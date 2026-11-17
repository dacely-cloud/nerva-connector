// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Shared irreversible Landlock setup; callers select their exact already-opened capabilities.

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

#[repr(C)]
struct Ruleset {
    filesystem: u64,
    network: u64,
}

#[repr(C, packed)]
struct Beneath {
    access: u64,
    parent: i32,
}

/// A borrowed descriptor is opened and validated by the caller before restrictions are installed.
pub struct Grant {
    pub descriptor: i32,
    pub access: u64,
}

/// No partial or unsupported installation is accepted. Rules handle all ABI-4 file rights and TCP rights.
pub fn restrict(grants: &[Grant]) -> io::Result<()> {
    // SAFETY: A version query requires a null pointer, zero size and the VERSION flag.
    if unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<u8>(),
            0usize,
            1u32,
        )
    } < 4
    {
        return Err(io::Error::other("Landlock ABI 4 is required"));
    }
    let ruleset = Ruleset {
        filesystem: (1u64 << 15) - 1,
        network: 3,
    };
    // SAFETY: The C-layout structure remains valid for the exact supplied size.
    let fd = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            &ruleset,
            std::mem::size_of::<Ruleset>(),
            0u32,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: The successful syscall returned a new descriptor owned by this scope.
    let descriptor = unsafe { OwnedFd::from_raw_fd(fd as i32) };
    for grant in grants {
        let beneath = Beneath {
            access: grant.access,
            parent: grant.descriptor,
        };
        // SAFETY: The packed PATH_BENEATH structure references a caller-owned live descriptor.
        if unsafe {
            libc::syscall(
                libc::SYS_landlock_add_rule,
                descriptor.as_raw_fd(),
                1u32,
                &beneath,
                0u32,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    // SAFETY: These process-local restrictions are irreversible and only reduce authority.
    if unsafe {
        libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
            || libc::syscall(
                libc::SYS_landlock_restrict_self,
                descriptor.as_raw_fd(),
                0u32,
            ) != 0
    } {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Exact parent identity and process-local death signal close the startup race before blocking on input.
pub fn parent_lifetime() -> io::Result<()> {
    let expected: libc::pid_t = std::env::var("NERVA_CONNECTOR_PARENT_PID")
        .map_err(io::Error::other)?
        .parse()
        .map_err(io::Error::other)?;
    if expected <= 0 {
        return Err(io::Error::other("Invalid connector parent"));
    }
    // SAFETY: Installing a local death signal and querying the parent cannot affect another workload.
    if unsafe {
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 || libc::getppid() != expected
    } {
        return Err(io::Error::other("Connector parent changed"));
    }
    Ok(())
}
