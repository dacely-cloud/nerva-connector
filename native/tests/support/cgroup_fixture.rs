// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Exact owned empty cgroups are removed with rmdir, never recursive control-file deletion.

use std::fs::File;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

pub struct CgroupFixture {
    path: PathBuf,
    root: File,
}

impl CgroupFixture {
    pub fn new() -> Self {
        let path = PathBuf::from(format!(
            "/sys/fs/cgroup/nerva-cgroup-native-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).expect("Owned empty cgroup creation must succeed");
        let root = File::open(&path).expect("Owned cgroup descriptor must open");
        Self { path, root }
    }

    pub fn open(&self) -> File {
        let root = File::open(&self.path).expect("Owned cgroup descriptor must open");
        self.assert_owned();
        root
    }

    pub fn replace(&mut self) {
        self.assert_owned();
        std::fs::remove_dir(&self.path).expect("Only the exact empty owned cgroup is removed");
        std::fs::create_dir(&self.path)
            .expect("Replacement empty owned cgroup creation must succeed");
        self.root = File::open(&self.path).expect("Replacement owned cgroup descriptor must open");
    }

    fn assert_owned(&self) {
        let expected = self
            .root
            .metadata()
            .expect("Owned cgroup metadata must remain readable");
        let current = std::fs::symlink_metadata(&self.path)
            .expect("Owned cgroup pathname must remain available");
        assert!(
            current.is_dir() && current.dev() == expected.dev() && current.ino() == expected.ino(),
            "Changed fixture ownership must preserve the unexpected cgroup"
        );
    }
}

impl Drop for CgroupFixture {
    fn drop(&mut self) {
        self.assert_owned();
        // An unexpected live/moved group remains visible as a failed cleanup obligation.
        std::fs::remove_dir(&self.path).expect("Exact owned cgroup cleanup must succeed");
    }
}
