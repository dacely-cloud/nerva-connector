// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Opt-in local kernel qualification. No signed protocol, private key or release artifact is changed.

#[path = "../src/opened_root_identity.rs"]
mod opened_root_identity;

use opened_root_identity::{RootIdentityFailure, inspect};
use std::fs::File;
use std::os::fd::AsRawFd;
use std::os::fd::FromRawFd;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn reference(name: &str) -> PathBuf {
    let value = std::env::var_os(name).expect("Explicit owned qualification reference required");
    let path = PathBuf::from(value);
    assert!(
        path.is_absolute(),
        "Qualification reference must be absolute"
    );
    path
}

#[test]
fn kernel_layout_is_exact_and_non_directories_are_never_identities() {
    assert!(opened_root_identity::layout_verified());
    let file = tempfile::tempfile().unwrap();
    assert!(matches!(
        inspect(&file),
        Err(RootIdentityFailure::NotDirectory)
    ));
    let proc = File::open("/proc").unwrap();
    assert!(matches!(
        inspect(&proc),
        Err(RootIdentityFailure::UnsupportedFilesystem)
    ));
}

#[test]
#[ignore = "requires an explicitly supplied owned parent on qualified ext4"]
fn qualified_ext4_descriptors_pin_renamed_roots_and_distinguish_replacement() {
    let parent = reference("NERVA_ROOT_IDENTITY_TEST_PARENT");
    let owned = tempfile::Builder::new()
        .prefix("nerva-root-identity-")
        .tempdir_in(parent)
        .unwrap();
    let path = owned.path().join("workspace");
    let renamed = owned.path().join("renamed");
    std::fs::create_dir(&path).unwrap();
    let file_alias = File::open(&path).unwrap();
    let command_alias = File::open(&path).unwrap();
    let before = inspect(&file_alias).expect("Qualified ext4 descriptor identity required");
    assert!(
        inspect(&command_alias).unwrap() == before,
        "Two independent aliases of one root must agree"
    );
    std::fs::rename(&path, &renamed).unwrap();
    assert!(
        inspect(&file_alias).unwrap() == before,
        "Rename cannot retarget a pinned descriptor"
    );
    let recaptured = File::open(&renamed).unwrap();
    assert!(
        inspect(&recaptured).unwrap() == before,
        "Recapture of the same renamed directory must agree"
    );
    std::fs::create_dir(&path).unwrap();
    let replacement = File::open(&path).unwrap();
    assert!(
        inspect(&replacement).unwrap() != before,
        "The old alias must not bind a replacement directory"
    );
    assert!(
        inspect(&file_alias).unwrap() == before,
        "Replacing a pathname must not replace an existing capability"
    );
    drop(recaptured);
    std::fs::remove_dir(&renamed).unwrap();
    assert!(
        matches!(inspect(&file_alias), Err(RootIdentityFailure::Unlinked)),
        "Unlinked directory roots cannot create a fresh binding"
    );
    drop(file_alias);
    drop(command_alias);
    std::fs::create_dir(&renamed).unwrap();
    let recreated = File::open(&renamed).unwrap();
    assert!(
        inspect(&recreated).unwrap() != before,
        "Delete/recreate must not inherit the prior identity"
    );
}

#[test]
#[ignore = "changes only a task-owned ext4 directory generation to prove the handle is not dev/inode alone"]
fn inode_generation_is_part_of_the_open_descriptor_identity() {
    let owned = tempfile::Builder::new()
        .prefix("nerva-root-generation-")
        .tempdir_in(reference("NERVA_ROOT_IDENTITY_TEST_PARENT"))
        .unwrap();
    let root = File::open(owned.path()).unwrap();
    let before = inspect(&root).expect("Qualified ext4 descriptor identity required");
    let generation = u32::from_ne_bytes(before.handle[4..8].try_into().unwrap());
    let mut replacement = generation ^ 0x5aa5_5aa5;
    if replacement == 0 {
        replacement = 1;
    }
    // SAFETY: The official EXT4_IOC_SETVERSION takes a live pointer to this bounded generation.
    // This inode belongs solely to the temporary qualification directory and is deleted at teardown.
    let changed = unsafe {
        libc::ioctl(
            root.as_raw_fd(),
            libc::_IOW::<libc::c_long>(u32::from(b'f'), 4),
            &replacement,
        )
    };
    assert!(
        changed == 0,
        "Task-owned ext4 generation update failed with OS code {:?}",
        std::io::Error::last_os_error().raw_os_error()
    );
    let after = inspect(&root).unwrap();
    assert!(
        after.device == before.device
            && after.inode == before.inode
            && after.filesystem_uuid == before.filesystem_uuid
    );
    assert!(
        after.handle_type == before.handle_type && after.handle != before.handle,
        "Same dev/inode with a different generation must not alias"
    );
    assert!(after != before);
}

#[test]
#[ignore = "requires two task-owned mounted byte-for-byte ext4 clones in an isolated mount namespace"]
fn cloned_filesystems_need_the_actual_device_identity_even_when_uuid_and_handles_match() {
    let left = File::open(reference("NERVA_ROOT_IDENTITY_CLONE_LEFT")).unwrap();
    let right = File::open(reference("NERVA_ROOT_IDENTITY_CLONE_RIGHT")).unwrap();
    let one = inspect(&left).expect("First qualified cloned filesystem required");
    let two = inspect(&right).expect("Second qualified cloned filesystem required");
    assert!(
        one.filesystem_uuid == two.filesystem_uuid,
        "The clone qualification must really preserve the filesystem UUID"
    );
    assert!(
        one.inode == two.inode && one.handle_type == two.handle_type && one.handle == two.handle,
        "The clone qualification must really preserve the generation-bearing root handle"
    );
    assert!(
        one.device != two.device && one != two,
        "Distinct mounted clones must not produce a joint workspace identity"
    );
    let alias = File::open(reference("NERVA_ROOT_IDENTITY_BIND_ALIAS")).unwrap();
    assert!(
        inspect(&alias).unwrap() == one,
        "Two bind aliases of the same actual root must agree"
    );
}

#[test]
#[ignore = "requires a task-owned tmpfs mount in an isolated mount namespace"]
fn unsupported_filesystems_do_not_downgrade_to_device_and_inode() {
    let unsupported = File::open(reference("NERVA_ROOT_IDENTITY_UNSUPPORTED")).unwrap();
    assert!(matches!(
        inspect(&unsupported),
        Err(RootIdentityFailure::UnsupportedFilesystem)
    ));
}

#[test]
#[ignore = "requires local administrator to drop all child user/group authority after granting one root FD"]
fn already_granted_descriptor_can_be_inspected_without_root_identity() {
    if std::env::var_os("NERVA_ROOT_IDENTITY_UNPRIVILEGED_CHILD").is_some() {
        // SAFETY: getuid/geteuid/getgroups only inspect this isolated qualification child's identity.
        assert!(unsafe {
            libc::getuid() == 65534
                && libc::geteuid() == 65534
                && libc::getgroups(0, std::ptr::null_mut()) == 0
        });
        // SAFETY: Only the trusted parent qualification grants this exact inherited descriptor;
        // this child takes ownership once and never accepts an external FD selector.
        let root = unsafe { File::from_raw_fd(4) };
        assert!(
            inspect(&root).is_ok(),
            "Unprivileged inherited capability must retain its exact kernel identity"
        );
        return;
    }
    let owned = tempfile::Builder::new()
        .prefix("nerva-root-unprivileged-")
        .tempdir_in(reference("NERVA_ROOT_IDENTITY_TEST_PARENT"))
        .unwrap();
    let root = File::open(owned.path()).unwrap();
    let executable = File::open(std::env::current_exe().unwrap()).unwrap();
    let descriptor = root.as_raw_fd();
    let mut child = Command::new("/proc/self/fd/0");
    child
        .stdin(Stdio::from(executable))
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .args([
            "--ignored",
            "--exact",
            "already_granted_descriptor_can_be_inspected_without_root_identity",
            "--nocapture",
        ])
        .env("NERVA_ROOT_IDENTITY_UNPRIVILEGED_CHILD", "1");
    // SAFETY: Before exec this closure calls only async-signal-safe descriptor/identity syscalls.
    // The executable is already pinned at stdin, the directory is copied to fixed FD4, and
    // every supplementary group plus real/effective/saved root identity is irrevocably dropped.
    unsafe {
        child.pre_exec(move || {
            if libc::dup2(descriptor, 4) < 0
                || libc::fcntl(4, libc::F_SETFD, 0) < 0
                || libc::setgroups(0, std::ptr::null()) != 0
                || libc::setresgid(65534, 65534, 65534) != 0
                || libc::setresuid(65534, 65534, 65534) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    assert!(
        child.status().unwrap().success(),
        "Non-root inherited-FD inspection must succeed"
    );
}
