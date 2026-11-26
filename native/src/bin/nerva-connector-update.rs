// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Atomically exchanges two existing program directories without a missing-installation crash window.

use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path};

struct Directory {
    parent: File,
    name: CString,
    _target: File,
}

fn trusted(path: &Path) -> io::Result<File> {
    if !path.is_absolute()
        || path.as_os_str().len() > 4096
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(io::Error::other("canonical absolute directory required"));
    }
    // SAFETY: geteuid has no pointer arguments or side effects.
    let uid = unsafe { libc::geteuid() };
    for ancestor in path.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor)?;
        let administrator_group = cfg!(target_os = "macos")
            && metadata.uid() == 0
            && metadata.gid() == 80
            && metadata.mode() & 0o002 == 0;
        if !metadata.is_dir()
            || (metadata.uid() != 0 && metadata.uid() != uid)
            || (metadata.mode() & 0o022 != 0 && !administrator_group)
        {
            return Err(io::Error::other("untrusted program ancestry"));
        }
    }
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

fn directory(path: &Path) -> io::Result<Directory> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("missing parent"))?;
    let leaf = path
        .file_name()
        .ok_or_else(|| io::Error::other("missing leaf"))?;
    if leaf.as_bytes().is_empty()
        || leaf.as_bytes().len() > 255
        || leaf
            .as_bytes()
            .iter()
            .any(|value| *value < 32 || *value == 127)
    {
        return Err(io::Error::other("invalid directory leaf"));
    }
    Ok(Directory {
        parent: trusted(parent)?,
        name: CString::new(leaf.as_bytes()).map_err(io::Error::other)?,
        _target: trusted(path)?,
    })
}

fn exchange(current: &Directory, staged: &Directory) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    // SAFETY: both descriptors are retained directory handles and both C strings are live plain leaves.
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            current.parent.as_raw_fd(),
            current.name.as_ptr(),
            staged.parent.as_raw_fd(),
            staged.name.as_ptr(),
            libc::RENAME_EXCHANGE,
        )
    };
    #[cfg(target_os = "macos")]
    // SAFETY: both descriptors are retained directory handles and both C strings are live plain leaves.
    let result = unsafe {
        libc::renameatx_np(
            current.parent.as_raw_fd(),
            current.name.as_ptr(),
            staged.parent.as_raw_fd(),
            staged.name.as_ptr(),
            libc::RENAME_SWAP,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    current.parent.sync_all()?;
    staged.parent.sync_all()
}

fn run() -> io::Result<()> {
    let arguments: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    if arguments.len() != 2 {
        return Err(io::Error::other(
            "two existing program directories required",
        ));
    }
    let current = directory(Path::new(&arguments[0]))?;
    let staged = directory(Path::new(&arguments[1]))?;
    exchange(&current, &staged)
}

fn main() {
    if run().is_err() {
        eprintln!("NERVA_UPDATE atomic program exchange failed");
        std::process::exit(1);
    }
}
