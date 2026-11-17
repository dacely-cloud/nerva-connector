// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Only a verified fork child's private session/group may be signalled; its adopted descendants join before input descriptors close.

use std::io;

fn failed() -> io::Error {
    io::Error::other("Native Pipe group ownership unavailable")
}

pub fn prepare_guardian() -> io::Result<()> {
    // SAFETY: This trusted guardian owns one payload tree. Subreaper and SIGCHLD disposition affect only this helper process, never its host parent.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = libc::SIG_DFL;
        libc::sigemptyset(&mut action.sa_mask);
        if libc::sigaction(libc::SIGCHLD, &action, std::ptr::null_mut()) != 0
            || libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1) != 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

pub fn child_session() -> io::Result<()> {
    // SAFETY: Only the freshly forked trusted child changes its own session before final payload seccomp; untrusted code cannot change groups afterward.
    if unsafe { libc::setsid() != libc::getpid() } {
        return Err(failed());
    }
    Ok(())
}

pub struct Group {
    pid: libc::pid_t,
    leader_status: Option<i32>,
    joined: bool,
}

impl Group {
    /// The caller holds this exact unreaped child trace-stopped; no remote PID or PGID is accepted.
    pub fn capture(pid: libc::pid_t) -> io::Result<Self> {
        // SAFETY: The fork-owned unreaped stopped child cannot be PID-reused. Its group/session must be private and distinct from the guardian's.
        let valid = unsafe {
            pid > 1
                && pid != libc::getpid()
                && pid != libc::getpgrp()
                && pid != libc::getsid(0)
                && libc::getpgid(pid) == pid
                && libc::getsid(pid) == pid
        };
        if !valid {
            return Err(failed());
        }
        Ok(Self {
            pid,
            leader_status: None,
            joined: false,
        })
    }

    /// Manual reaping and subreaper adoption keep every descendant in this verified immutable group until it is joined.
    pub fn stop(&mut self) -> io::Result<i32> {
        if self.joined {
            return self.leader_status.ok_or_else(failed);
        }
        loop {
            let mut status = 0;
            // SAFETY: Negative wait targets ONLY this captured private group; the initialized status belongs to this frame.
            let result = unsafe { libc::waitpid(-self.pid, &mut status, libc::WNOHANG) };
            if result > 0 {
                if result == self.pid {
                    self.leader_status = Some(status);
                }
                continue;
            }
            if result < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                if error.raw_os_error() == Some(libc::ECHILD) {
                    self.joined = true;
                    return self.leader_status.ok_or_else(failed);
                }
                return Err(error);
            }
            // SAFETY: waitpid just proved this exact group still has an owned unreaped child. Exiting members remain zombies until this sole owner reaps them; no signal occurs after ECHILD.
            if unsafe { libc::kill(-self.pid, libc::SIGKILL) } != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(error);
                }
            }
            let delay = libc::timespec {
                tv_sec: 0,
                tv_nsec: 1_000_000,
            };
            // SAFETY: The fixed finite delay yields between scoped group-kill/reap attempts, including fork races, without closing application input.
            unsafe {
                libc::nanosleep(&delay, std::ptr::null_mut());
            }
        }
    }
}
