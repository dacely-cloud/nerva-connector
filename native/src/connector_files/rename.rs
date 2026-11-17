//! Same-root publication keeps both parent descriptors and verifies the moved source after its atomic rename.

use super::{Failure, Metadata, WriteMode, filesystem};
use std::fs::File;
use std::os::fd::AsRawFd;

/// Kernel rename cannot atomically condition on captured inode identities against a concurrently mutating tenant.
pub fn publish(
    root: &File,
    path: &str,
    destination: &str,
    mode: WriteMode,
) -> Result<Metadata, Failure> {
    if path == destination {
        return Err(Failure::Invalid);
    }
    let (source_parent, source_name) = filesystem::parent(root, path)?;
    let (destination_parent, destination_name) = filesystem::parent(root, destination)?;
    let (source, before) = filesystem::regular(root, path)?;
    let target = if matches!(mode, WriteMode::Replace) {
        Some(filesystem::regular(root, destination)?)
    } else {
        None
    };
    source.sync_all().map_err(|_| Failure::Unavailable)?;
    // SAFETY: Both retained parents are beneath one root without symlinks or mount crossings; names are validated single components and flags are fixed.
    let renamed = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            source_parent.as_raw_fd(),
            source_name.as_ptr(),
            destination_parent.as_raw_fd(),
            destination_name.as_ptr(),
            if matches!(mode, WriteMode::Create) {
                libc::RENAME_NOREPLACE
            } else {
                0
            },
        )
    };
    if renamed != 0 {
        return Err(Failure::Changed);
    }
    destination_parent
        .sync_all()
        .map_err(|_| Failure::Indeterminate)?;
    source_parent
        .sync_all()
        .map_err(|_| Failure::Indeterminate)?;
    let published =
        filesystem::target(root, destination, false).map_err(|_| Failure::Indeterminate)?;
    let after = filesystem::raw(&published).map_err(|_| Failure::Indeterminate)?;
    let retained = filesystem::raw(&source).map_err(|_| Failure::Indeterminate)?;
    if after.st_dev != before.st_dev
        || after.st_ino != before.st_ino
        || retained.st_dev != before.st_dev
        || retained.st_ino != before.st_ino
    {
        return Err(Failure::Indeterminate);
    }
    if let Some((target, _)) = target
        && filesystem::identity(&target)
            .map_err(|_| Failure::Indeterminate)?
            .st_nlink
            != 0
    {
        return Err(Failure::Indeterminate);
    }
    filesystem::metadata(&after).map_err(|_| Failure::Indeterminate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn creation_never_overwrites_and_replacement_requires_an_existing_regular_target() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("nested")).unwrap();
        std::fs::write(directory.path().join("source"), b"source").unwrap();
        std::fs::write(directory.path().join("existing"), b"existing").unwrap();
        symlink("existing", directory.path().join("link")).unwrap();
        let root = File::open(directory.path()).unwrap();
        assert!(publish(&root, "source", "existing", WriteMode::Create).is_err());
        assert!(matches!(
            publish(&root, "source", "missing", WriteMode::Replace),
            Err(Failure::Denied)
        ));
        assert!(publish(&root, "source", "link", WriteMode::Replace).is_err());
        assert!(publish(&root, "source", "nested", WriteMode::Replace).is_err());
        assert!(publish(&root, "source", ".", WriteMode::Create).is_err());
        assert!(publish(&root, "source", "source", WriteMode::Replace).is_err());
        assert!(publish(&root, "source", "nested/new", WriteMode::Create).is_ok());
        assert!(!directory.path().join("source").exists());
        assert!(publish(&root, "nested/new", "existing", WriteMode::Replace).is_ok());
        assert!(!directory.path().join("nested/new").exists());
        assert_eq!(
            std::fs::read(directory.path().join("existing")).unwrap(),
            b"source"
        );
    }

    #[test]
    fn rejects_source_links_and_escaping_parent_paths_without_changing_outside_data() {
        let directory = tempfile::tempdir().unwrap();
        let root_path = directory.path().join("root");
        std::fs::create_dir(&root_path).unwrap();
        std::fs::write(root_path.join("source"), b"source").unwrap();
        std::fs::write(directory.path().join("outside"), b"outside").unwrap();
        symlink("../outside", root_path.join("link")).unwrap();
        symlink("..", root_path.join("escape")).unwrap();
        let root = File::open(&root_path).unwrap();
        assert!(publish(&root, "link", "new", WriteMode::Create).is_err());
        assert!(publish(&root, "source", "../outside", WriteMode::Replace).is_err());
        assert!(publish(&root, "source", "escape/outside", WriteMode::Replace).is_err());
        std::fs::hard_link(root_path.join("source"), root_path.join("hard")).unwrap();
        assert!(publish(&root, "source", "new", WriteMode::Create).is_err());
        assert_eq!(
            std::fs::read(directory.path().join("outside")).unwrap(),
            b"outside"
        );
        assert_eq!(std::fs::read(root_path.join("source")).unwrap(), b"source");
    }
}
