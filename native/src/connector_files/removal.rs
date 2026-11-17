//! Finite descriptor-relative removal never follows links or crosses a mount boundary.

use super::{Failure, filesystem};
use std::ffi::CString;
use std::fs::File;
use std::os::fd::AsRawFd;

const MAXIMUM_ENTRIES: u32 = 4096;
const MAXIMUM_DEPTH: u32 = 32;
const MAXIMUM_PAGES: u32 = 256;
const RESOLUTION: u64 = 1 | 2 | 4 | 8;

struct Removal {
    removed: u32,
    pages: u32,
}

impl Removal {
    fn target(
        &mut self,
        root: &File,
        path: &str,
        recursive: bool,
        depth: u32,
    ) -> Result<(), Failure> {
        if depth > MAXIMUM_DEPTH || self.removed >= MAXIMUM_ENTRIES {
            return Err(Failure::Denied);
        }
        let captured = filesystem::target(root, path, false)?;
        let before = filesystem::identity(&captured)?;
        let directory = before.st_mode & libc::S_IFMT == libc::S_IFDIR;
        if directory && recursive {
            let mut cursor = 0;
            loop {
                if self.pages >= MAXIMUM_PAGES {
                    return Err(Failure::Denied);
                }
                self.pages += 1;
                let (entries, next, _) = filesystem::list(root, path, cursor)?;
                for entry in entries {
                    self.target(root, &format!("{path}/{}", entry.name), true, depth + 1)?;
                }
                match next {
                    Some(next) => {
                        let next = super::decimal(&next)?;
                        if next == cursor {
                            return Err(Failure::Changed);
                        }
                        cursor = next;
                    }
                    None => break,
                }
            }
        }
        if self.removed >= MAXIMUM_ENTRIES {
            return Err(Failure::Denied);
        }
        let (parent, basename) = path.rsplit_once('/').unwrap_or((".", path));
        let parent = filesystem::open(
            root.as_raw_fd(),
            parent,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
            RESOLUTION,
        )?;
        let current = filesystem::open(
            parent.as_raw_fd(),
            basename,
            libc::O_PATH | libc::O_NOFOLLOW,
            RESOLUTION,
        )?;
        let after = filesystem::identity(&current)?;
        if before.st_dev != after.st_dev
            || before.st_ino != after.st_ino
            || before.st_mode & libc::S_IFMT != after.st_mode & libc::S_IFMT
        {
            return Err(Failure::Changed);
        }
        if directory && recursive {
            let contents = filesystem::open(
                root.as_raw_fd(),
                &format!("/proc/self/fd/{}", captured.as_raw_fd()),
                libc::O_RDONLY | libc::O_DIRECTORY,
                0,
            )?;
            contents.sync_all().map_err(|_| Failure::Indeterminate)?;
        }
        let basename = CString::new(basename).map_err(|_| Failure::Invalid)?;
        // SAFETY: The pinned parent stays beneath the granted root, the single-component name is validated, and unlinkat never follows the final entry.
        if unsafe {
            libc::unlinkat(
                parent.as_raw_fd(),
                basename.as_ptr(),
                if directory { libc::AT_REMOVEDIR } else { 0 },
            )
        } != 0
        {
            return Err(Failure::Changed);
        }
        self.removed += 1;
        if depth == 1 {
            parent.sync_all().map_err(|_| Failure::Indeterminate)?;
        }
        Ok(())
    }
}

/// Partial effects, including a failed durability flush, are always reported as indeterminate.
pub fn remove(root: &File, path: &str, recursive: bool) -> Result<u32, Failure> {
    if path == "." {
        return Err(Failure::Invalid);
    }
    let mut operation = Removal {
        removed: 0,
        pages: 0,
    };
    match operation.target(root, path, recursive, 1) {
        Ok(()) => Ok(operation.removed),
        Err(_) if operation.removed > 0 => Err(Failure::Indeterminate),
        Err(error) => Err(error),
    }
}
