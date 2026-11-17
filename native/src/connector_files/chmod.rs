//! Descriptor-only permission changes expose two private modes and never follow another path after opening.

use super::{Failure, Metadata, filesystem};
use std::fs::File;
use std::os::fd::AsRawFd;

/// A completed fchmod remains an effect even when synchronization or path revalidation subsequently fails.
pub fn change(root: &File, path: &str, mode: u32) -> Result<Metadata, Failure> {
    if ![0o600, 0o700].contains(&mode) {
        return Err(Failure::Invalid);
    }
    let (_parent, _name) = filesystem::parent(root, path)?;
    let (file, before) = filesystem::regular(root, path)?;
    // SAFETY: The owned descriptor references a checked single-link regular file; only fixed private permission modes enter fchmod.
    if unsafe { libc::fchmod(file.as_raw_fd(), mode) } != 0 {
        return Err(Failure::Denied);
    }
    file.sync_all().map_err(|_| Failure::Indeterminate)?;
    let after = filesystem::raw(&file).map_err(|_| Failure::Indeterminate)?;
    let current = filesystem::target(root, path, false).map_err(|_| Failure::Indeterminate)?;
    let current = filesystem::raw(&current).map_err(|_| Failure::Indeterminate)?;
    if before.st_dev != after.st_dev
        || before.st_ino != after.st_ino
        || before.st_dev != current.st_dev
        || before.st_ino != current.st_ino
        || after.st_mode & 0o7777 != mode
        || current.st_mode & 0o7777 != mode
    {
        return Err(Failure::Indeterminate);
    }
    filesystem::metadata(&after).map_err(|_| Failure::Indeterminate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{MetadataExt, symlink};

    #[test]
    fn changes_only_single_link_regular_files_to_private_modes() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("file"), b"preserved").unwrap();
        std::fs::create_dir(directory.path().join("folder")).unwrap();
        symlink("file", directory.path().join("link")).unwrap();
        let root = File::open(directory.path()).unwrap();
        assert_eq!(change(&root, "file", 0o700).unwrap().mode, 0o700);
        assert_eq!(change(&root, "file", 0o600).unwrap().mode, 0o600);
        assert!(change(&root, "file", 0o777).is_err());
        assert!(change(&root, "file", 0o4600).is_err());
        assert!(change(&root, "folder", 0o700).is_err());
        assert!(change(&root, "link", 0o700).is_err());
        assert!(change(&root, ".", 0o700).is_err());
        std::fs::hard_link(directory.path().join("file"), directory.path().join("hard")).unwrap();
        assert!(change(&root, "file", 0o700).is_err());
        assert_eq!(
            std::fs::metadata(directory.path().join("file"))
                .unwrap()
                .mode()
                & 0o7777,
            0o600
        );
        assert_eq!(
            std::fs::read(directory.path().join("file")).unwrap(),
            b"preserved"
        );
    }
}
