//! Single private-directory creation retains the parent capability and never follows links or creates implicit parents.

use super::{Failure, filesystem};
use std::fs::File;
use std::os::fd::AsRawFd;

/// A successful mkdirat is an effect even if parent synchronization or delivery later fails.
pub fn create(root: &File, path: &str) -> Result<(), Failure> {
    let (parent, basename) = filesystem::parent(root, path)?;
    // SAFETY: The parent is retained under openat2's no-link/no-mount/beneath rules; the name is one validated component and mode is fixed.
    if unsafe { libc::mkdirat(parent.as_raw_fd(), basename.as_ptr(), 0o700) } != 0 {
        return Err(Failure::Changed);
    }
    parent.sync_all().map_err(|_| Failure::Indeterminate)
}
