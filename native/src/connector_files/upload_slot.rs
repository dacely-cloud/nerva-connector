//! One locked, bounded upload slot; descriptor-relative files never follow links or cross mounts.
use super::{Failure, WriteMode, filesystem};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::os::{fd::AsRawFd, unix::fs::FileExt};

pub const DATA: &str = "upload-data";
pub const META: &str = "upload-metadata";
pub const PARTIAL: &str = "upload-metadata.partial";

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Descriptor {
    pub path: String,
    pub upload_id: String,
    pub binding_sha256: String,
    pub mode: WriteMode,
    pub size_bytes: String,
    pub sha256: String,
}

/// Reopening the pinned directory creates a distinct open-file description: inherited dup fds would share flock ownership.
pub fn lock(stage: &File) -> Result<File, Failure> {
    let directory = filesystem::open(
        stage.as_raw_fd(),
        ".",
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
        15,
    )?;
    // SAFETY: The owned directory descriptor remains live for the complete operation; the fixed nonblocking lock is released on close.
    if unsafe { libc::flock(directory.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(Failure::Changed);
    }
    Ok(directory)
}

pub fn file(stage: &File, name: &str, writable: bool) -> Result<Option<File>, Failure> {
    let Some(captured) = filesystem::optional_mode(
        stage.as_raw_fd(),
        name,
        libc::O_PATH | libc::O_NOFOLLOW,
        15,
        0,
    )?
    else {
        return Ok(None);
    };
    let before = filesystem::raw(&captured)?;
    let parent = filesystem::raw(stage)?;
    if before.st_mode & libc::S_IFMT != libc::S_IFREG
        || before.st_mode & 0o7777 != 0o600
        || before.st_uid != parent.st_uid
        || before.st_dev != parent.st_dev
    {
        return Err(Failure::Denied);
    }
    let file = filesystem::open(
        stage.as_raw_fd(),
        &format!("/proc/self/fd/{}", captured.as_raw_fd()),
        if writable {
            libc::O_RDWR
        } else {
            libc::O_RDONLY
        },
        0,
    )?;
    let after = filesystem::raw(&file)?;
    if before.st_dev != after.st_dev
        || before.st_ino != after.st_ino
        || before.st_size != after.st_size
        || before.st_mode != after.st_mode
        || before.st_uid != after.st_uid
        || before.st_ctime != after.st_ctime
        || before.st_ctime_nsec != after.st_ctime_nsec
    {
        return Err(Failure::Changed);
    }
    Ok(Some(file))
}

pub fn create(stage: &File, name: &str) -> Result<File, Failure> {
    filesystem::open_mode(
        stage.as_raw_fd(),
        name,
        libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW,
        15,
        0o600,
    )
}

pub fn descriptor(stage: &File, name: &str) -> Result<Option<Descriptor>, Failure> {
    let Some(file) = file(stage, name, false)? else {
        return Ok(None);
    };
    let size = filesystem::raw(&file)?.st_size;
    if size > 8192 {
        return Err(Failure::Denied);
    }
    let mut bytes = vec![0; size as usize];
    file.read_exact_at(&mut bytes, 0)
        .map_err(|_| Failure::Denied)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| Failure::Denied)
}

pub fn match_descriptor(stage: &File, expected: &Descriptor) -> Result<(), Failure> {
    if descriptor(stage, PARTIAL)?.is_some() {
        return Err(Failure::Changed);
    }
    match descriptor(stage, META)? {
        Some(actual) if actual == *expected => Ok(()),
        Some(_) => Err(Failure::Changed),
        None => Err(Failure::Unavailable),
    }
}

pub fn data(stage: &File, maximum: u64) -> Result<(File, u64), Failure> {
    let file = file(stage, DATA, true)?.ok_or(Failure::Indeterminate)?;
    let size = filesystem::raw(&file)?.st_size as u64;
    if size > maximum {
        return Err(Failure::Denied);
    }
    Ok((file, size))
}

pub fn hash(file: &File, size: u64) -> Result<String, Failure> {
    let before = filesystem::raw(file)?;
    if before.st_size as u64 != size {
        return Err(Failure::Changed);
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 32768];
    let mut offset = 0;
    while offset < size {
        let length = (size - offset).min(buffer.len() as u64) as usize;
        file.read_exact_at(&mut buffer[..length], offset)
            .map_err(|_| Failure::Changed)?;
        hash.update(&buffer[..length]);
        offset += length as u64;
    }
    let after = filesystem::raw(file)?;
    if before.st_size != after.st_size
        || before.st_mtime != after.st_mtime
        || before.st_mtime_nsec != after.st_mtime_nsec
        || before.st_ctime != after.st_ctime
        || before.st_ctime_nsec != after.st_ctime_nsec
    {
        return Err(Failure::Changed);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub fn unlink(stage: &File, name: &str) -> Result<(), Failure> {
    let name = std::ffi::CString::new(name).map_err(|_| Failure::Invalid)?;
    // SAFETY: The name is one of the fixed private slot leaves, and stage is a retained directory capability.
    if unsafe { libc::unlinkat(stage.as_raw_fd(), name.as_ptr(), 0) } != 0 {
        return Err(Failure::Indeterminate);
    }
    Ok(())
}

pub fn rename(
    source: &File,
    source_name: &str,
    target: &File,
    target_name: &std::ffi::CStr,
    mode: WriteMode,
) -> Result<(), Failure> {
    let source_name = std::ffi::CString::new(source_name).map_err(|_| Failure::Invalid)?;
    // SAFETY: Both parents remain pinned and both names are validated single leaves; only the two fixed publication modes exist.
    if unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            source.as_raw_fd(),
            source_name.as_ptr(),
            target.as_raw_fd(),
            target_name.as_ptr(),
            if mode == WriteMode::Create {
                libc::RENAME_NOREPLACE
            } else {
                0
            },
        )
    } != 0
    {
        return Err(Failure::Changed);
    }
    Ok(())
}
