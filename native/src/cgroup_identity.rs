// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Boot-scoped cgroup2 identity includes the complete generation-bearing kernfs export handle.

use crate::opened_root_identity::capture_handle;
use crate::workspace_identity::{CaptureFailure, decimal, hex, hexadecimal};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

const FILEID_KERNFS: i32 = 254;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityInput {
    boot_id: String,
    device: String,
    filesystem_id: String,
    handle_type: i32,
    handle: String,
}

/// Raw boot/filesystem/handle material belongs only in the trusted local parent channel and encrypted history.
#[derive(Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", try_from = "IdentityInput")]
pub struct CgroupIdentity {
    boot_id: String,
    device: String,
    filesystem_id: String,
    handle_type: i32,
    handle: String,
}

impl TryFrom<IdentityInput> for CgroupIdentity {
    type Error = &'static str;
    fn try_from(value: IdentityInput) -> Result<Self, Self::Error> {
        if !boot_format(&value.boot_id)
            || !decimal(&value.device)
            || !hexadecimal(&value.filesystem_id, 16)
            || value.filesystem_id.bytes().all(|byte| byte == b'0')
            || value.handle_type != FILEID_KERNFS
            || !hexadecimal(&value.handle, 16)
        {
            return Err("Invalid private cgroup identity");
        }
        Ok(Self {
            boot_id: value.boot_id,
            device: value.device,
            filesystem_id: value.filesystem_id,
            handle_type: value.handle_type,
            handle: value.handle,
        })
    }
}

impl CgroupIdentity {
    /// Fixed relative cgroup.events checks reject removed kernfs nodes, whose handle and nlink can remain readable.
    pub fn capture(group: &File) -> Result<Self, CaptureFailure> {
        let boot_id = boot_id()?;
        let before = group.metadata().map_err(|_| CaptureFailure::Unavailable)?;
        if !before.is_dir() {
            return Err(CaptureFailure::Invalid);
        }
        let filesystem = filesystem_id(group)?;
        live(group)?;
        let handle = capture_handle(group)?;
        if handle.kind != FILEID_KERNFS || handle.bytes.len() != 8 {
            return Err(CaptureFailure::Unsupported);
        }
        let after = group.metadata().map_err(|_| CaptureFailure::Unavailable)?;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || filesystem_id(group)? != filesystem
        {
            return Err(CaptureFailure::Changed);
        }
        live(group)?;
        Ok(Self {
            boot_id,
            device: before.dev().to_string(),
            filesystem_id: hex(&filesystem),
            handle_type: handle.kind,
            handle: hex(&handle.bytes),
        })
    }
}

fn filesystem_id(group: &File) -> Result<[u8; 8], CaptureFailure> {
    if std::mem::size_of::<libc::fsid_t>() != 8 {
        return Err(CaptureFailure::Unsupported);
    }
    let mut value = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: Successful fstatfs initializes the entire output for this borrowed group descriptor.
    if unsafe { libc::fstatfs(group.as_raw_fd(), value.as_mut_ptr()) } != 0 {
        return Err(CaptureFailure::Unavailable);
    }
    // SAFETY: fstatfs succeeded and initialized the output, including both fixed fsid words.
    let value = unsafe { value.assume_init() };
    if value.f_type != libc::CGROUP2_SUPER_MAGIC {
        return Err(CaptureFailure::Unsupported);
    }
    let mut bytes = [0u8; 8];
    // SAFETY: Linux fsid_t is exactly two initialized 32-bit C integers; its verified eight bytes contain no padding.
    unsafe {
        std::ptr::copy_nonoverlapping(
            (&value.f_fsid as *const libc::fsid_t).cast::<u8>(),
            bytes.as_mut_ptr(),
            bytes.len(),
        );
    }
    if bytes == [0; 8] {
        return Err(CaptureFailure::Unsupported);
    }
    Ok(bytes)
}

fn live(group: &File) -> Result<(), CaptureFailure> {
    // SAFETY: This fixed single-component kernel control file is opened relative to the same retained cgroup FD.
    let descriptor = unsafe {
        libc::openat(
            group.as_raw_fd(),
            c"cgroup.events".as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if descriptor < 0 {
        return Err(CaptureFailure::Changed);
    }
    // SAFETY: Successful openat returned a new descriptor owned solely by this File.
    let events = unsafe { File::from_raw_fd(descriptor) };
    if !events
        .metadata()
        .map_err(|_| CaptureFailure::Unavailable)?
        .is_file()
    {
        return Err(CaptureFailure::Invalid);
    }
    let mut bytes = Vec::new();
    events
        .take(257)
        .read_to_end(&mut bytes)
        .map_err(|_| CaptureFailure::Changed)?;
    if bytes.len() > 256
        || !(bytes.starts_with(b"populated 0\n") || bytes.starts_with(b"populated 1\n"))
    {
        return Err(CaptureFailure::Unavailable);
    }
    Ok(())
}

fn boot_id() -> Result<String, CaptureFailure> {
    let boot = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open("/proc/sys/kernel/random/boot_id")
        .map_err(|_| CaptureFailure::Unavailable)?;
    let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: Successful fstatfs initializes the complete output for the fixed kernel procfs file.
    if unsafe { libc::fstatfs(boot.as_raw_fd(), filesystem.as_mut_ptr()) } != 0 {
        return Err(CaptureFailure::Unavailable);
    }
    // SAFETY: fstatfs succeeded and initialized its filesystem magic.
    if unsafe { filesystem.assume_init() }.f_type != libc::PROC_SUPER_MAGIC {
        return Err(CaptureFailure::Unsupported);
    }
    let mut bytes = Vec::new();
    boot.take(38)
        .read_to_end(&mut bytes)
        .map_err(|_| CaptureFailure::Unavailable)?;
    if bytes.len() != 37 || bytes.pop() != Some(b'\n') {
        return Err(CaptureFailure::Unavailable);
    }
    let value = String::from_utf8(bytes).map_err(|_| CaptureFailure::Unavailable)?;
    if !boot_format(&value) {
        return Err(CaptureFailure::Unavailable);
    }
    Ok(value)
}

fn boot_format(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
        && value.bytes().any(|byte| byte != b'0' && byte != b'-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cgroup_fixture::CgroupFixture;
    use serde_json::{Value, json};

    fn encoded() -> Value {
        json!({
            "bootId": "00000000-0000-0000-0000-000000000001",
            "device": "18446744073709551615",
            "filesystemId": "0000000000000001",
            "handleType": 254,
            "handle": "0000000000000001"
        })
    }

    #[test]
    fn codec_requires_exact_canonical_complete_identity() {
        assert!(serde_json::from_value::<CgroupIdentity>(encoded()).is_ok());
        for (key, value) in [
            ("bootId", json!("00000000-0000-0000-0000-000000000000")),
            ("bootId", json!("A0000000-0000-0000-0000-000000000001")),
            ("device", json!("018446744073709551615")),
            ("device", json!("18446744073709551616")),
            ("device", json!(1)),
            ("filesystemId", json!("0000000000000000")),
            ("filesystemId", json!("000000000000000A")),
            ("handleType", json!(1)),
            ("handle", json!("01")),
            ("extra", json!(null)),
        ] {
            let mut changed = encoded();
            changed[key] = value;
            assert!(serde_json::from_value::<CgroupIdentity>(changed).is_err());
        }
        for key in ["bootId", "device", "filesystemId", "handleType", "handle"] {
            let mut changed = encoded();
            changed.as_object_mut().unwrap().remove(key);
            assert!(serde_json::from_value::<CgroupIdentity>(changed).is_err());
        }
    }

    #[test]
    fn cgroup_capture_retains_generation_and_refuses_removed_node() {
        let mut fixture = CgroupFixture::new();
        let original = fixture.open();
        let identity = CgroupIdentity::capture(&original)
            .unwrap_or_else(|_| panic!("Qualified cgroup2 capture failed"));
        assert!(CgroupIdentity::capture(&fixture.open()).is_ok_and(|other| other == identity));
        fixture.replace();
        assert!(matches!(
            CgroupIdentity::capture(&original),
            Err(CaptureFailure::Changed)
        ));
        assert!(CgroupIdentity::capture(&fixture.open()).is_ok_and(|other| other != identity));
        assert!(matches!(
            CgroupIdentity::capture(&File::open("/proc").unwrap()),
            Err(CaptureFailure::Unsupported)
        ));
        assert!(matches!(
            CgroupIdentity::capture(&tempfile::tempfile().unwrap()),
            Err(CaptureFailure::Invalid)
        ));
    }
}
