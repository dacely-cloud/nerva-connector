// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Irreversible execution restrictions are installed after namespace admission and before execve.

use super::configuration::{Configuration, WorkspaceAccess, invalid};
use crate::sandbox::{self, Grant};
use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

fn directory(path: &str) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

fn executable(root: &File, path: &str) -> io::Result<File> {
    let relative =
        CString::new(path.strip_prefix('/').ok_or_else(invalid)?).map_err(|_| invalid())?;
    let how = OpenHow {
        flags: (libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NONBLOCK) as u64,
        mode: 0,
        resolve: 0x02 | 0x04 | 0x08,
    };
    // SAFETY: openat2 receives a live root descriptor, terminated path and exact immutable structure.
    let descriptor = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            root.as_raw_fd(),
            relative.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        )
    };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: Successful openat2 returned a new owned descriptor.
    let mut file = unsafe { File::from_raw_fd(descriptor as i32) };
    let metadata = file.metadata()?;
    let mut header = [0u8; 64];
    if !metadata.is_file()
        || metadata.mode() & 0o6022 != 0
        || metadata.mode() & 0o111 == 0
        || metadata.len() < header.len() as u64
        || metadata.len() > 268435456
        || metadata.nlink() != 1
    {
        return Err(invalid());
    }
    file.read_exact(&mut header)?;
    let machine = if cfg!(target_arch = "x86_64") {
        62
    } else if cfg!(target_arch = "aarch64") {
        183
    } else {
        0
    };
    if &header[0..6] != b"\x7fELF\x02\x01"
        || machine == 0
        || u16::from_le_bytes([header[18], header[19]]) != machine
        || ![2, 3].contains(&u16::from_le_bytes([header[16], header[17]]))
    {
        return Err(invalid());
    }
    Ok(file)
}

fn interpreter(root: &File, file: &File) -> io::Result<Option<File>> {
    let mut header = [0u8; 64];
    file.read_exact_at(&mut header, 0)?;
    let file_size = file.metadata()?.len();
    let offset = u64::from_le_bytes(header[32..40].try_into().map_err(|_| invalid())?);
    let count = u16::from_le_bytes([header[56], header[57]]) as u64;
    let size = u16::from_le_bytes([header[54], header[55]]) as u64;
    if count > 128
        || size != 56
        || offset
            .checked_add(count * size)
            .is_none_or(|end| end > file_size)
    {
        return Err(invalid());
    }
    let mut selected = None;
    for index in 0..count {
        let mut entry = [0u8; 56];
        file.read_exact_at(&mut entry, offset + index * size)?;
        if u32::from_le_bytes(entry[0..4].try_into().map_err(|_| invalid())?) != 3 {
            continue;
        }
        if selected.is_some() {
            return Err(invalid());
        }
        let start = u64::from_le_bytes(entry[8..16].try_into().map_err(|_| invalid())?);
        let length = u64::from_le_bytes(entry[32..40].try_into().map_err(|_| invalid())?);
        if !(2..=4096).contains(&length)
            || start.checked_add(length).is_none_or(|end| end > file_size)
        {
            return Err(invalid());
        }
        let mut bytes = vec![0u8; length as usize];
        file.read_exact_at(&mut bytes, start)?;
        if bytes.pop() != Some(0) || bytes.contains(&0) {
            return Err(invalid());
        }
        let path = String::from_utf8(bytes).map_err(|_| invalid())?;
        if !path.starts_with("/lib/")
            && !path.starts_with("/lib64/")
            && !path.starts_with("/usr/lib/")
            && !path.starts_with("/usr/lib64/")
        {
            return Err(invalid());
        }
        let canonical = std::fs::canonicalize(path)?;
        let canonical = canonical.to_str().ok_or_else(invalid)?;
        if !canonical.starts_with("/lib/")
            && !canonical.starts_with("/lib64/")
            && !canonical.starts_with("/usr/lib/")
            && !canonical.starts_with("/usr/lib64/")
        {
            return Err(invalid());
        }
        selected = Some(executable(root, canonical)?);
    }
    Ok(selected)
}

/// Read-only runtime and exact executable inodes remain independent of workspace write grants.
pub fn install(value: &Configuration) -> io::Result<()> {
    prepare(value)?;
    super::syscalls::install()
}

/// Pipe children finish this same irreversible preparation before entering their controlled exec-event stop.
pub fn prepare(value: &Configuration) -> io::Result<()> {
    {
        let root = directory("/")?;
        let temporary = directory("/tmp")?;
        let workspace = directory("/workspace")?;
        let null = File::open("/dev/null")?;
        let executables: Vec<File> = value
            .allowed_executables
            .iter()
            .map(|path| executable(&root, path))
            .collect::<io::Result<Vec<File>>>()?;
        let mut interpreters = Vec::new();
        for file in &executables {
            if let Some(loader) = interpreter(&root, file)? {
                interpreters.push(loader);
            }
        }
        let read = (1 << 2) | (1 << 3);
        let write = read
            | (1 << 1)
            | (1 << 4)
            | (1 << 5)
            | (1 << 7)
            | (1 << 8)
            | (1 << 12)
            | (1 << 13)
            | (1 << 14);
        let mut grants = vec![
            Grant {
                descriptor: root.as_raw_fd(),
                access: read,
            },
            Grant {
                descriptor: temporary.as_raw_fd(),
                access: write,
            },
            Grant {
                descriptor: null.as_raw_fd(),
                access: 1 << 1,
            },
        ];
        if matches!(value.workspace_access, WorkspaceAccess::ReadWrite) {
            grants.push(Grant {
                descriptor: workspace.as_raw_fd(),
                access: write,
            });
        }
        for file in executables.iter().chain(interpreters.iter()) {
            grants.push(Grant {
                descriptor: file.as_raw_fd(),
                access: (1 << 0) | (1 << 2),
            });
        }
        sandbox::restrict(&grants)?;
    }
    // SAFETY: Only standard pipes remain needed; all owned capability handles have already been dropped.
    if unsafe { libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, 0u32) } != 0 {
        return Err(io::Error::last_os_error());
    }
    for (resource, maximum) in [
        (libc::RLIMIT_CPU, value.maximum_cpu_seconds),
        (libc::RLIMIT_AS, value.maximum_address_bytes),
        (libc::RLIMIT_FSIZE, value.maximum_file_bytes),
        (libc::RLIMIT_NOFILE, 64),
        (libc::RLIMIT_NPROC, 64),
        (libc::RLIMIT_CORE, 0),
        (libc::RLIMIT_MEMLOCK, 0),
    ] {
        let limit = libc::rlimit {
            rlim_cur: maximum,
            rlim_max: maximum,
        };
        // SAFETY: This process-local limit is initialized and no other workload is modified.
        if unsafe { libc::setrlimit(resource, &limit) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    // SAFETY: Disabling dumpability only reduces this process's inspection surface.
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
