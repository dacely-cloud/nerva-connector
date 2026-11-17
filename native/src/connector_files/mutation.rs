//! Atomic bounded publications use a private locally selected same-filesystem staging directory.

use super::{Failure, Metadata, WriteMode, filesystem};
use std::ffi::CString;
use std::fs::File;
use std::io::Write;
use std::os::fd::AsRawFd;

const RESOLUTION: u64 = 1 | 2 | 4 | 8;

fn name(id: &str) -> Result<String, Failure> {
    if id.len() != 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(Failure::Invalid);
    }
    Ok(format!("write-{id}"))
}

/// Recovery unlinks only the original device-derived staging name in its dedicated private directory.
pub fn cleanup(stage: &File, id: &str) -> Result<bool, Failure> {
    let name = CString::new(name(id)?).map_err(|_| Failure::Invalid)?;
    // SAFETY: The retained directory capability and validated single-component name cannot select an ambient path.
    let result = unsafe { libc::unlinkat(stage.as_raw_fd(), name.as_ptr(), 0) };
    if result != 0 {
        return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            Ok(false)
        } else {
            Err(Failure::Unavailable)
        };
    }
    stage.sync_all().map_err(|_| Failure::Unavailable)?;
    Ok(true)
}

/// No directory, symlink, mount crossing or ambient target can become an atomic write destination.
pub fn write(
    root: &File,
    stage: &File,
    path: &str,
    mode: WriteMode,
    bytes: &[u8],
    id: &str,
) -> Result<Metadata, Failure> {
    let (parent, destination) = filesystem::parent(root, path)?;
    if matches!(mode, WriteMode::Replace) {
        let target = filesystem::target(root, path, false)?;
        if filesystem::raw(&target)?.st_mode & libc::S_IFMT != libc::S_IFREG {
            return Err(Failure::Denied);
        }
    }
    let temporary = name(id)?;
    let mut file = filesystem::open_mode(
        stage.as_raw_fd(),
        &temporary,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW,
        RESOLUTION,
        0o600,
    )?;
    let result = (|| {
        file.write_all(bytes).map_err(|_| Failure::Unavailable)?;
        file.sync_all().map_err(|_| Failure::Unavailable)?;
        stage.sync_all().map_err(|_| Failure::Unavailable)?;
        let source = CString::new(temporary).map_err(|_| Failure::Invalid)?;
        // SAFETY: Both directory descriptors are pinned capabilities. Only validated single-component names and fixed flags enter renameat2.
        let published = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                stage.as_raw_fd(),
                source.as_ptr(),
                parent.as_raw_fd(),
                destination.as_ptr(),
                if matches!(mode, WriteMode::Create) {
                    libc::RENAME_NOREPLACE
                } else {
                    0
                },
            )
        };
        if published != 0 {
            return Err(Failure::Changed);
        }
        parent.sync_all().map_err(|_| Failure::Indeterminate)?;
        stage.sync_all().map_err(|_| Failure::Indeterminate)?;
        filesystem::metadata(&filesystem::raw(&file)?)
    })();
    if result.is_err() {
        cleanup(stage, id)?;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connector_files::confinement;
    use std::process::Command;

    fn probe(root: &str, stage: &str, outside: &str) -> bool {
        let inherited_root = File::open(root).unwrap();
        let inherited_stage = File::open(stage).unwrap();
        let root = filesystem::root_at(inherited_root.as_raw_fd()).unwrap();
        let stage = filesystem::root_at(inherited_stage.as_raw_fd()).unwrap();
        drop(inherited_root);
        drop(inherited_stage);
        if confinement::install(root.as_raw_fd(), Some(stage.as_raw_fd())).is_err() {
            return false;
        }
        if write(
            &root,
            &stage,
            "created",
            WriteMode::Create,
            b"published",
            &"a".repeat(64),
        )
        .is_err()
        {
            return false;
        }
        if super::super::chmod::change(&root, "created", 0o700).is_err()
            || super::super::rename::publish(&root, "created", "renamed", WriteMode::Create)
                .is_err()
            || super::super::rename::publish(&root, "renamed", "replacement", WriteMode::Replace)
                .is_err()
            || super::super::rename::publish(&root, "replacement", "created", WriteMode::Create)
                .is_err()
            || super::super::chmod::change(&root, "created", 0o600).is_err()
        {
            return false;
        }
        if super::super::removal::remove(&root, "removal-tree", true).ok() != Some(3) {
            return false;
        }
        if super::super::directory::create(&root, "created-directory").is_err() {
            return false;
        }
        let denied_read = filesystem::open(root.as_raw_fd(), outside, libc::O_RDONLY, 0).is_err();
        let denied_write = filesystem::open_mode(
            root.as_raw_fd(),
            outside,
            libc::O_WRONLY | libc::O_TRUNC,
            0,
            0,
        )
        .is_err();
        let target = CString::new(outside).unwrap();
        let outside_directory = CString::new(format!("{outside}-directory")).unwrap();
        let outside_creation = CString::new(format!("{outside}-new-directory")).unwrap();
        let empty: [*const libc::c_char; 1] = [std::ptr::null()];
        // SAFETY: These valid fixed calls independently test kernel denial without relying on the request/path parser.
        let denied = unsafe {
            libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) == -1
                && libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) == -1
                && libc::execve(c"/bin/true".as_ptr(), empty.as_ptr(), empty.as_ptr()) == -1
                && libc::fchmod(root.as_raw_fd(), 0o777) == -1
                && libc::fchmod(root.as_raw_fd(), 0o700) == -1
                && libc::mkdirat(root.as_raw_fd(), c"broad-mode".as_ptr(), 0o777) == -1
                && libc::mkdirat(root.as_raw_fd(), outside_creation.as_ptr(), 0o700) == -1
                && libc::unlinkat(root.as_raw_fd(), target.as_ptr(), 0) == -1
                && libc::unlinkat(
                    root.as_raw_fd(),
                    outside_directory.as_ptr(),
                    libc::AT_REMOVEDIR,
                ) == -1
                && libc::syscall(
                    libc::SYS_renameat2,
                    root.as_raw_fd(),
                    c"created".as_ptr(),
                    root.as_raw_fd(),
                    target.as_ptr(),
                    0,
                ) == -1
        };
        denied_read && denied_write && denied
    }

    #[test]
    fn writes_keep_kernel_denials_outside_selected_roots_and_private_staging() {
        if let Ok(root) = std::env::var("NERVA_CONNECTOR_RW_TEST_ROOT") {
            let success = probe(
                &root,
                &std::env::var("NERVA_CONNECTOR_RW_TEST_STAGE").unwrap(),
                &std::env::var("NERVA_CONNECTOR_RW_TEST_OUTSIDE").unwrap(),
            );
            // SAFETY: This is the deliberately confined child; unrestricted test-harness destructors must not run here.
            unsafe {
                libc::_exit(if success { 0 } else { 1 });
            }
        }
        let owned = tempfile::tempdir().unwrap();
        let root = owned.path().join("root");
        let stage = owned.path().join("stage");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&stage).unwrap();
        std::fs::write(root.join("replacement"), b"replaced").unwrap();
        std::fs::create_dir_all(root.join("removal-tree/nested")).unwrap();
        std::fs::write(root.join("removal-tree/nested/file"), b"removed").unwrap();
        let outside = owned.path().join("outside");
        std::fs::write(&outside, b"private").unwrap();
        let outside_directory = owned.path().join("outside-directory");
        std::fs::create_dir(&outside_directory).unwrap();
        let test_name = concat!(
            "connector_files::mutation::tests::",
            "writes_keep_kernel_denials_outside_selected_roots_and_private_staging"
        );
        let result = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test_name, "--nocapture"])
            .env_clear()
            .env("NERVA_CONNECTOR_RW_TEST_ROOT", &root)
            .env("NERVA_CONNECTOR_RW_TEST_STAGE", &stage)
            .env("NERVA_CONNECTOR_RW_TEST_OUTSIDE", &outside)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "write confinement did not independently prove kernel denials"
        );
        assert_eq!(std::fs::read(root.join("created")).unwrap(), b"published");
        assert!(root.join("created-directory").is_dir());
        assert!(!root.join("broad-mode").exists());
        assert_eq!(std::fs::read(&outside).unwrap(), b"private");
        assert!(outside_directory.is_dir());
        assert!(!owned.path().join("outside-new-directory").exists());
        assert!(!root.join("removal-tree").exists());
        assert_eq!(std::fs::read_dir(&stage).unwrap().count(), 0);
    }
}
