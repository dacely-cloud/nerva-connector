// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Fixed inherited pipes are accepted only from the lifetime-pinned private parent.

// Linux UAPI include/uapi/linux/magic.h; named FIFOs use their containing filesystem.
const PIPEFS_MAGIC: libc::c_long = 0x5049_5045;

#[derive(Clone, Copy)]
pub enum PipeFailure {
    Invalid,
    Unavailable,
}

/// No pathname or peer-selected descriptor can replace these inherited local channels.
pub fn validate(descriptor: i32, access: libc::c_int) -> Result<(), PipeFailure> {
    if access != libc::O_RDONLY && access != libc::O_WRONLY {
        return Err(PipeFailure::Invalid);
    }
    // SAFETY: F_GETFL inspects only this borrowed inherited descriptor.
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
    if flags < 0 {
        return Err(PipeFailure::Unavailable);
    }
    match (access, flags & libc::O_ACCMODE) {
        (libc::O_RDONLY, libc::O_WRONLY) | (libc::O_WRONLY, libc::O_RDONLY) => {
            return Err(PipeFailure::Invalid);
        }
        _ => {}
    }
    let mut status = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: Successful fstat initializes the whole fixed output for the borrowed descriptor.
    if unsafe { libc::fstat(descriptor, status.as_mut_ptr()) } != 0 {
        return Err(PipeFailure::Unavailable);
    }
    // SAFETY: fstat succeeded and fully initialized the output.
    let status = unsafe { status.assume_init() };
    // SAFETY: getuid only inspects this process's operating-system identity.
    let owner = unsafe { libc::getuid() };
    if status.st_uid != owner {
        return Err(PipeFailure::Invalid);
    }
    match status.st_mode & libc::S_IFMT {
        libc::S_IFIFO if status.st_mode & 0o077 == 0 => {
            let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
            // SAFETY: Successful fstatfs initializes the complete output for the borrowed pipe.
            if unsafe { libc::fstatfs(descriptor, filesystem.as_mut_ptr()) } != 0 {
                return Err(PipeFailure::Unavailable);
            }
            // SAFETY: fstatfs succeeded and initialized its filesystem magic.
            if unsafe { filesystem.assume_init() }.f_type != PIPEFS_MAGIC {
                return Err(PipeFailure::Invalid);
            }
            Ok(())
        }
        libc::S_IFSOCK => {
            let mut kind: libc::c_int = 0;
            let mut kind_length = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
            // SAFETY: SO_TYPE writes one exactly sized integer for this borrowed socket.
            if unsafe {
                libc::getsockopt(
                    descriptor,
                    libc::SOL_SOCKET,
                    libc::SO_TYPE,
                    (&mut kind as *mut libc::c_int).cast(),
                    &mut kind_length,
                )
            } != 0
                || kind_length as usize != std::mem::size_of::<libc::c_int>()
                || kind != libc::SOCK_STREAM
            {
                return Err(PipeFailure::Invalid);
            }
            let mut peer = std::mem::MaybeUninit::<libc::ucred>::uninit();
            let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
            // SAFETY: getsockopt receives an exactly sized writable credential buffer.
            if unsafe {
                libc::getsockopt(
                    descriptor,
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    peer.as_mut_ptr().cast(),
                    &mut length,
                )
            } != 0
                || length as usize != std::mem::size_of::<libc::ucred>()
            {
                return Err(PipeFailure::Invalid);
            }
            // SAFETY: The successful option read initialized an exact ucred.
            let peer = unsafe { peer.assume_init() };
            // SAFETY: getppid reads this process's current lifetime-pinned parent identity.
            if peer.pid != unsafe { libc::getppid() } || peer.uid != owner {
                return Err(PipeFailure::Invalid);
            }
            Ok(())
        }
        _ => Err(PipeFailure::Invalid),
    }
}
