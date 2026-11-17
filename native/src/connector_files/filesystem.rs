//! Descriptor-relative resolution never follows symlinks or enters another mount below the selected root.

use super::{Entry, Failure, FileKind, Metadata};
use std::ffi::CString;
use std::fs::File;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::FileExt;

const NO_XDEV: u64 = 1;
const NO_MAGICLINKS: u64 = 2;
const NO_SYMLINKS: u64 = 4;
const BENEATH: u64 = 8;

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

pub(super) fn open(directory: i32, path: &str, flags: i32, resolve: u64) -> Result<File, Failure> {
    open_mode(directory, path, flags, resolve, 0)
}

pub(super) fn open_mode(
    directory: i32,
    path: &str,
    flags: i32,
    resolve: u64,
    mode: u64,
) -> Result<File, Failure> {
    optional_mode(directory, path, flags, resolve, mode)?.ok_or(Failure::Denied)
}

/// Absence is distinguished only for fixed private upload slot names; all other open failures remain denied.
pub(super) fn optional_mode(
    directory: i32,
    path: &str,
    flags: i32,
    resolve: u64,
    mode: u64,
) -> Result<Option<File>, Failure> {
    let path = CString::new(path).map_err(|_| Failure::Invalid)?;
    let how = OpenHow {
        flags: (flags
            | libc::O_CLOEXEC
            | if flags & libc::O_PATH == 0 {
                libc::O_NONBLOCK
            } else {
                0
            }) as u64,
        mode,
        resolve,
    };
    // SAFETY: The directory descriptor is owned by the caller; both C-layout arguments remain live for the exact syscall size.
    let fd = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            directory,
            path.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        )
    };
    if fd < 0 {
        return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            Ok(None)
        } else {
            Err(Failure::Denied)
        };
    }
    // SAFETY: Successful openat2 returns a fresh owned file descriptor.
    Ok(Some(unsafe { File::from_raw_fd(fd as i32) }))
}

/// The parent passes an already pinned directory capability at descriptor four; no request selects a host path.
pub fn root() -> Result<File, Failure> {
    root_at(4)
}

pub(super) fn root_at(source: i32) -> Result<File, Failure> {
    // SAFETY: F_DUPFD_CLOEXEC creates an owned copy only when inherited descriptor four is valid.
    let fd = unsafe { libc::fcntl(source, libc::F_DUPFD_CLOEXEC, 6) };
    if fd < 0 {
        return Err(Failure::Invalid);
    }
    // SAFETY: The successful duplication returns a new descriptor owned by this file.
    let directory = unsafe { File::from_raw_fd(fd) };
    if raw(&directory)?.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Err(Failure::Denied);
    }
    let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: fstatfs initializes the entire valid output object on success.
    if unsafe { libc::fstatfs(directory.as_raw_fd(), filesystem.as_mut_ptr()) } != 0 {
        return Err(Failure::Unavailable);
    }
    // SAFETY: Successful fstatfs initialized this object.
    let filesystem = unsafe { filesystem.assume_init() };
    if [
        0x9fa0, 0x62656572, 0x64626720, 0x74726163, 0x27e0eb, 0x63677270, 0x65735546,
    ]
    .contains(&(filesystem.f_type as u64))
    {
        return Err(Failure::Denied);
    }
    Ok(directory)
}

pub(super) fn target(root: &File, path: &str, directory: bool) -> Result<File, Failure> {
    if path.is_empty()
        || path.len() > 4096
        || path.as_bytes().iter().any(|byte| *byte < 32)
        || (path != "."
            && path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == ".."))
    {
        return Err(Failure::Invalid);
    }
    open(
        root.as_raw_fd(),
        path,
        libc::O_PATH | libc::O_NOFOLLOW | if directory { libc::O_DIRECTORY } else { 0 },
        NO_XDEV | NO_MAGICLINKS | NO_SYMLINKS | BENEATH,
    )
}

/// Mutations retain an existing parent and a single name; neither implicit parent creation nor root replacement is permitted.
pub(super) fn relative(path: &str) -> Result<(), Failure> {
    if path.is_empty()
        || path.len() > 4096
        || path.as_bytes().iter().any(|byte| *byte < 32)
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(Failure::Invalid);
    }
    Ok(())
}

/// Parent descriptors are opened only when an operation actually touches the destination.
pub(super) fn parent(root: &File, path: &str) -> Result<(File, CString), Failure> {
    relative(path)?;
    let (parent, basename) = path.rsplit_once('/').unwrap_or((".", path));
    Ok((
        open(
            root.as_raw_fd(),
            parent,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
            NO_XDEV | NO_MAGICLINKS | NO_SYMLINKS | BENEATH,
        )?,
        CString::new(basename).map_err(|_| Failure::Invalid)?,
    ))
}

pub(super) fn raw(file: &File) -> Result<libc::stat, Failure> {
    let metadata = identity(file)?;
    let kind = metadata.st_mode & libc::S_IFMT;
    if (kind != libc::S_IFREG && kind != libc::S_IFDIR)
        || metadata.st_size < 0
        || (kind == libc::S_IFREG && metadata.st_nlink != 1)
    {
        return Err(Failure::Denied);
    }
    Ok(metadata)
}

/// Identity inspection never opens a symlink or special file for I/O.
pub(super) fn identity(file: &File) -> Result<libc::stat, Failure> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: The owned descriptor is valid and fstat initializes the complete object on success.
    if unsafe { libc::fstat(file.as_raw_fd(), metadata.as_mut_ptr()) } != 0 {
        return Err(Failure::Denied);
    }
    // SAFETY: Successful fstat initialized the metadata object.
    let metadata = unsafe { metadata.assume_init() };
    Ok(metadata)
}

pub(super) fn metadata(value: &libc::stat) -> Result<Metadata, Failure> {
    if value.st_mtime < 0 || value.st_mtime_nsec < 0 || value.st_mtime_nsec >= 1_000_000_000 {
        return Err(Failure::Denied);
    }
    let time = (value.st_mtime as u128) * 1_000_000_000 + value.st_mtime_nsec as u128;
    if time > i64::MAX as u128 {
        return Err(Failure::Denied);
    }
    Ok(Metadata {
        kind: if value.st_mode & libc::S_IFMT == libc::S_IFDIR {
            FileKind::Directory
        } else {
            FileKind::File
        },
        size_bytes: value.st_size.to_string(),
        modified_at_ns: time.to_string(),
        mode: value.st_mode & 0o777,
    })
}

/// Metadata-changing operations retain the exact regular object opened beneath the granted root.
pub(super) fn regular(root: &File, path: &str) -> Result<(File, libc::stat), Failure> {
    let captured = target(root, path, false)?;
    let before = raw(&captured)?;
    if before.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(Failure::Denied);
    }
    let file = open(
        root.as_raw_fd(),
        &format!("/proc/self/fd/{}", captured.as_raw_fd()),
        libc::O_RDONLY,
        0,
    )?;
    unchanged(&before, &raw(&file)?)?;
    Ok((file, before))
}

fn unchanged(before: &libc::stat, after: &libc::stat) -> Result<(), Failure> {
    if before.st_dev != after.st_dev
        || before.st_ino != after.st_ino
        || before.st_size != after.st_size
        || before.st_mtime != after.st_mtime
        || before.st_mtime_nsec != after.st_mtime_nsec
        || before.st_ctime != after.st_ctime
        || before.st_ctime_nsec != after.st_ctime_nsec
        || before.st_nlink != after.st_nlink
    {
        return Err(Failure::Changed);
    }
    Ok(())
}

/// Positioned reads only accept a single-link regular file and return at most the already validated allocation.
pub fn read(
    root: &File,
    path: &str,
    offset: u64,
    limit: u32,
) -> Result<(Vec<u8>, Metadata), Failure> {
    let captured = target(root, path, false)?;
    let before = raw(&captured)?;
    if before.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(Failure::Denied);
    }
    let file = open(
        root.as_raw_fd(),
        &format!("/proc/self/fd/{}", captured.as_raw_fd()),
        libc::O_RDONLY,
        0,
    )?;
    unchanged(&before, &raw(&file)?)?;
    let mut output = vec![0u8; limit as usize];
    let count = file
        .read_at(&mut output, offset)
        .map_err(|_| Failure::Denied)?;
    output.truncate(count);
    unchanged(&before, &raw(&file)?)?;
    Ok((output, metadata(&before)?))
}

/// Metadata comes from the opened object rather than a second path lookup.
pub fn stat(root: &File, path: &str) -> Result<Metadata, Failure> {
    metadata(&raw(&target(root, path, false)?)?)
}

/// Filesystem cookies support bounded pages; mutation is reported instead of promising a stable directory snapshot.
pub fn list(
    root: &File,
    path: &str,
    cursor: u64,
) -> Result<(Vec<Entry>, Option<String>, Metadata), Failure> {
    let captured = target(root, path, true)?;
    let before = raw(&captured)?;
    let directory = open(
        root.as_raw_fd(),
        &format!("/proc/self/fd/{}", captured.as_raw_fd()),
        libc::O_RDONLY | libc::O_DIRECTORY,
        0,
    )?;
    unchanged(&before, &raw(&directory)?)?;
    // SAFETY: The descriptor is an owned directory and the validated cookie fits off_t.
    if unsafe { libc::lseek(directory.as_raw_fd(), cursor as libc::off_t, libc::SEEK_SET) } < 0 {
        return Err(Failure::Invalid);
    }
    let mut buffer = [0u8; 4096];
    let mut entries = Vec::new();
    let mut scanned: usize = 0;
    let mut next = cursor;
    let mut encoded_budget: usize = 0;
    let complete: bool = 'page: loop {
        // SAFETY: getdents64 writes at most the provided byte slice and owns no returned pointers.
        let count = unsafe {
            libc::syscall(
                libc::SYS_getdents64,
                directory.as_raw_fd(),
                buffer.as_mut_ptr(),
                buffer.len(),
            )
        };
        if count < 0 {
            return Err(Failure::Denied);
        }
        if count == 0 {
            break true;
        }
        let count = count as usize;
        if count > buffer.len() {
            return Err(Failure::Unavailable);
        }
        let mut position = 0;
        while position < count {
            if count - position < 20 {
                return Err(Failure::Unavailable);
            }
            let record = &buffer[position..count];
            let length = u16::from_ne_bytes([record[16], record[17]]) as usize;
            if length < 20 || length > record.len() {
                return Err(Failure::Unavailable);
            }
            let cookie =
                i64::from_ne_bytes(record[8..16].try_into().map_err(|_| Failure::Unavailable)?);
            if cookie < 0 {
                return Err(Failure::Unavailable);
            }
            let name = &record[19..length];
            let end = name
                .iter()
                .position(|byte| *byte == 0)
                .ok_or(Failure::Unavailable)?;
            let name = std::str::from_utf8(&name[..end]).map_err(|_| Failure::Denied)?;
            if name != "." && name != ".." {
                if name.is_empty()
                    || name.len() > 255
                    || name.bytes().any(|byte| byte < 32 || byte == b'/')
                {
                    return Err(Failure::Denied);
                }
                let cost = name.len() * 2 + 64;
                if encoded_budget + cost > 48000 {
                    break 'page false;
                }
                encoded_budget += cost;
                let kind = match record[18] {
                    libc::DT_REG => FileKind::File,
                    libc::DT_DIR => FileKind::Directory,
                    libc::DT_LNK => FileKind::SymbolicLink,
                    _ => FileKind::Other,
                };
                entries.push(Entry {
                    name: name.to_owned(),
                    kind,
                });
            }
            next = cookie as u64;
            scanned += 1;
            position += length;
            if entries.len() >= 128 || scanned >= 256 {
                break;
            }
        }
        if entries.len() >= 128 || scanned >= 256 {
            break false;
        }
    };
    unchanged(&before, &raw(&directory)?)?;
    Ok((
        entries,
        if complete {
            None
        } else {
            Some(next.to_string())
        },
        metadata(&before)?,
    ))
}
