// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Identity comes from an already-open descriptor, never a pathname or remote selector.
//! These kernel values are not a public profile, secret, permission grant or remotely supplied input.

use std::fs::File;
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;

const EXT4_SUPER_MAGIC: libc::c_long = 0xef53;
const HANDLE_BYTES: usize = 128;
const FILEID_INO32_GEN: i32 = 1;

/// Every unsupported primitive is explicit; dev/inode alone is never a fallback identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RootIdentityFailure {
    LayoutUnavailable,
    NotDirectory,
    Unlinked,
    UnsupportedFilesystem,
    FilesystemUnavailable,
    UuidUnavailable,
    HandleUnavailable,
    UnsupportedHandle,
    Changed,
}

/// The kernel inode generation lives inside the opaque ext4 file handle.
#[derive(Eq, PartialEq)]
pub struct OpenedRootIdentity {
    pub filesystem_uuid: [u8; 16],
    pub device: u64,
    pub inode: u64,
    pub handle_type: i32,
    pub handle: Vec<u8>,
}

/// Kernel export handle bytes are qualified by the caller's exact filesystem/type contract.
pub struct KernelFileHandle {
    pub kind: i32,
    pub bytes: Vec<u8>,
}

// Official UAPI: include/uapi/linux/ext4.h, struct fsuuid and EXT4_IOC_GETFSUUID.
// The encoded ioctl size is its fixed eight-byte header, not the trailing UUID buffer.
#[repr(C)]
struct UuidHeader {
    length: u32,
    flags: u32,
}

#[repr(C)]
struct UuidBuffer {
    length: u32,
    flags: u32,
    uuid: [u8; 16],
}

// Official UAPI: struct file_handle has two fixed 32-bit fields and a flexible byte array.
#[repr(C)]
struct HandleBuffer {
    length: u32,
    kind: i32,
    bytes: [u8; HANDLE_BYTES],
}

/// Capture UUID and an opaque generation-bearing handle from precisely the borrowed directory FD.
pub fn inspect(root: &File) -> Result<OpenedRootIdentity, RootIdentityFailure> {
    if !layout_verified() {
        return Err(RootIdentityFailure::LayoutUnavailable);
    }
    let before = root
        .metadata()
        .map_err(|_| RootIdentityFailure::FilesystemUnavailable)?;
    if !before.is_dir() {
        return Err(RootIdentityFailure::NotDirectory);
    }
    if before.nlink() == 0 {
        return Err(RootIdentityFailure::Unlinked);
    }
    let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: The borrowed descriptor remains open and successful fstatfs initializes the whole output.
    if unsafe { libc::fstatfs(root.as_raw_fd(), filesystem.as_mut_ptr()) } != 0 {
        return Err(RootIdentityFailure::FilesystemUnavailable);
    }
    // SAFETY: fstatfs succeeded and initialized this value.
    let filesystem = unsafe { filesystem.assume_init() };
    if filesystem.f_type != EXT4_SUPER_MAGIC {
        return Err(RootIdentityFailure::UnsupportedFilesystem);
    }
    let uuid = filesystem_uuid(root)?;
    let handle = capture_handle(root)?;
    // ext4's qualified export operation is generic_encode_ino32_fh: FILEID_INO32_GEN includes
    // both inode and generation. Other formats require their own qualification, not truncation.
    if handle.kind != FILEID_INO32_GEN || handle.bytes.len() != 8 {
        return Err(RootIdentityFailure::UnsupportedHandle);
    }
    let after = root
        .metadata()
        .map_err(|_| RootIdentityFailure::FilesystemUnavailable)?;
    if before.dev() != after.dev()
        || before.ino() != after.ino()
        || after.nlink() == 0
        || filesystem_uuid(root)? != uuid
    {
        return Err(RootIdentityFailure::Changed);
    }
    Ok(OpenedRootIdentity {
        filesystem_uuid: uuid,
        device: before.dev(),
        inode: before.ino(),
        handle_type: handle.kind,
        handle: handle.bytes,
    })
}

/// Query an already-open descriptor; no pathname, caller flags or reopen-by-handle operation is accepted.
pub fn capture_handle(root: &File) -> Result<KernelFileHandle, RootIdentityFailure> {
    if !layout_verified() {
        return Err(RootIdentityFailure::LayoutUnavailable);
    }
    let mut handle = HandleBuffer {
        length: HANDLE_BYTES as u32,
        kind: 0,
        bytes: [0; HANDLE_BYTES],
    };
    let mut mount_id: libc::c_int = 0;
    // SAFETY: Both buffers have the kernel's exact fixed headers and bounded writable trailing storage.
    // AT_EMPTY_PATH queries the inherited FD itself; no pathname is resolved and no file is opened by handle.
    if unsafe {
        libc::name_to_handle_at(
            root.as_raw_fd(),
            c"".as_ptr(),
            (&mut handle as *mut HandleBuffer).cast::<libc::file_handle>(),
            &mut mount_id,
            libc::AT_EMPTY_PATH | libc::AT_HANDLE_FID,
        )
    } != 0
    {
        return Err(RootIdentityFailure::HandleUnavailable);
    }
    if handle.length == 0 || handle.length as usize > HANDLE_BYTES {
        return Err(RootIdentityFailure::UnsupportedHandle);
    }
    Ok(KernelFileHandle {
        kind: handle.kind,
        bytes: handle.bytes[..handle.length as usize].to_vec(),
    })
}

fn filesystem_uuid(root: &File) -> Result<[u8; 16], RootIdentityFailure> {
    let mut value = UuidBuffer {
        length: 16,
        flags: 0,
        uuid: [0; 16],
    };
    // SAFETY: EXT4_IOC_GETFSUUID reads an eight-byte fsuuid header and writes its exact 16-byte tail.
    // The root descriptor and complete repr(C) buffer outlive this synchronous read-only ioctl.
    if unsafe {
        libc::ioctl(
            root.as_raw_fd(),
            libc::_IOR::<UuidHeader>(u32::from(b'f'), 44),
            &mut value,
        )
    } != 0
        || value.length != 16
        || value.flags != 0
        || value.uuid.iter().all(|byte| *byte == 0)
    {
        return Err(RootIdentityFailure::UuidUnavailable);
    }
    Ok(value.uuid)
}

/// Layout checks protect the ioctl request number and the two flexible-array backing allocations.
pub fn layout_verified() -> bool {
    std::mem::size_of::<UuidHeader>() == 8
        && std::mem::offset_of!(UuidBuffer, uuid) == 8
        && std::mem::offset_of!(HandleBuffer, bytes) == 8
        && std::mem::size_of::<libc::file_handle>() == 8
}
