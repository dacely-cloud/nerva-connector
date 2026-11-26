// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Only an owned fork child's genuine kernel exec event may establish native Pipe readiness.

use super::SetupFailure;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

pub struct Payload {
    pid: libc::pid_t,
    pidfd: OwnedFd,
    status: Option<i32>,
    reaped: bool,
    group: Option<super::pipe_group::Group>,
}

fn failed() -> io::Error {
    io::Error::other("Native Pipe exec ownership unavailable")
}

fn wait(pid: libc::pid_t, flags: i32) -> io::Result<Option<i32>> {
    loop {
        let mut status = 0;
        // SAFETY: The caller retains this unreaped child; the initialized status belongs to this stack frame.
        let result = unsafe { libc::waitpid(pid, &mut status, flags) };
        if result == pid {
            return Ok(Some(status));
        }
        if result == 0 {
            return Ok(None);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn trace(operation: libc::c_uint, pid: libc::pid_t, options: libc::c_ulong) -> io::Result<()> {
    // SAFETY: Every operation and option is receiver-fixed and addresses solely this owner's unreaped fork child.
    if unsafe { libc::ptrace(operation, pid, 0usize, options) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

impl Payload {
    pub fn spawn<P, F>(prepare: P, action: F) -> io::Result<Self>
    where
        P: FnOnce() -> Result<(), SetupFailure>,
        F: FnOnce() -> Result<(), SetupFailure>,
    {
        super::pipe_group::prepare_guardian()?;
        // SAFETY: This trusted native helper is single-threaded; no other thread or workload shares child ownership.
        let parent = unsafe { libc::getpid() };
        // SAFETY: The forked child immediately installs parent-death ownership and executes only the captured local closure.
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            return Err(io::Error::last_os_error());
        }
        if pid == 0 {
            child(parent, prepare, action);
        }
        // SAFETY: The freshly forked unreaped PID cannot be reused; pidfd_open captures its exact kernel identity.
        let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0u32) };
        if descriptor < 0 {
            // SAFETY: This exact unreaped child is still owned after fork and must not survive failed identity capture.
            unsafe { libc::kill(pid, libc::SIGKILL) };
            let _ = wait(pid, 0);
            return Err(io::Error::last_os_error());
        }
        // SAFETY: Successful pidfd_open returned a fresh owned descriptor.
        let pidfd = unsafe { OwnedFd::from_raw_fd(descriptor as i32) };
        let mut owner = Self {
            pid,
            pidfd,
            status: None,
            reaped: false,
            group: None,
        };
        let stopped = wait(pid, 0)?.ok_or_else(failed)?;
        if !libc::WIFSTOPPED(stopped) || libc::WSTOPSIG(stopped) != libc::SIGSTOP {
            if libc::WIFEXITED(stopped) || libc::WIFSIGNALED(stopped) {
                owner.status = Some(stopped);
                owner.reaped = true;
            }
            return Err(failed());
        }
        trace(
            libc::PTRACE_SETOPTIONS,
            pid,
            (libc::PTRACE_O_TRACEEXEC | libc::PTRACE_O_EXITKILL) as libc::c_ulong,
        )?;
        trace(libc::PTRACE_CONT, pid, 0)?;
        let status = wait(pid, 0)?.ok_or_else(failed)?;
        if !libc::WIFSTOPPED(status)
            || libc::WSTOPSIG(status) != libc::SIGTRAP
            || status >> 16 != libc::PTRACE_EVENT_EXEC
        {
            if libc::WIFEXITED(status) || libc::WIFSIGNALED(status) {
                owner.status = Some(status);
                owner.reaped = true;
            }
            return Err(failed());
        }
        owner.group = Some(super::pipe_group::Group::capture(pid)?);
        trace(libc::PTRACE_DETACH, pid, 0)?;
        Ok(owner)
    }

    pub fn descriptor(&self) -> i32 {
        self.pidfd.as_raw_fd()
    }

    pub fn try_status(&mut self) -> io::Result<Option<i32>> {
        if self.status.is_none() {
            loop {
                // SAFETY: Initialized siginfo receives only this exact pidfd's exit observation. WNOWAIT preserves leader identity until scoped tree cleanup.
                let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                // SAFETY: The owned live pidfd cannot address a reused PID, and the bounded nonblocking observation never reaps it.
                let result = unsafe {
                    libc::waitid(
                        libc::P_PIDFD,
                        self.pidfd.as_raw_fd() as u32,
                        &mut info,
                        libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                    )
                };
                if result != 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(error);
                }
                // SAFETY: Successful waitid initialized the SIGCHLD union; only its documented child PID/status fields are read.
                let (pid, status) = unsafe { (info.si_pid(), info.si_status()) };
                if pid == 0 {
                    return Ok(None);
                }
                if pid != self.pid {
                    return Err(failed());
                }
                self.status = Some(match info.si_code {
                    libc::CLD_EXITED => status << 8,
                    libc::CLD_KILLED => status,
                    libc::CLD_DUMPED => status | 0x80,
                    _ => return Err(failed()),
                });
                break;
            }
        }
        Ok(self.status)
    }

    pub fn stop(&mut self) -> io::Result<()> {
        if self.reaped {
            return Ok(());
        }
        if let Some(group) = &mut self.group {
            let status = group.stop()?;
            self.status.get_or_insert(status);
            self.reaped = true;
            return Ok(());
        }
        // SAFETY: Before group verification only this exact fork-owned pidfd can be signalled; no group or untrusted descendants were admitted.
        if unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.pidfd.as_raw_fd(),
                libc::SIGKILL,
                0usize,
                0u32,
            )
        } != 0
            && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        {
            return Err(io::Error::last_os_error());
        }
        self.status = wait(self.pid, 0)?;
        self.reaped = true;
        Ok(())
    }
}

impl Drop for Payload {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn child<P, F>(parent: libc::pid_t, prepare: P, action: F) -> !
where
    P: FnOnce() -> Result<(), SetupFailure>,
    F: FnOnce() -> Result<(), SetupFailure>,
{
    // SAFETY: These process-local operations install death ownership before the child can execute captured setup.
    let established = unsafe {
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) == 0 && libc::getppid() == parent
    };
    let failure = if established && super::pipe_group::child_session().is_ok() {
        match prepare() {
            Err(failure) => failure,
            Ok(()) => {
                // SAFETY: Only this prepared owned child requests tracing; the unchanged payload seccomp filter is installed afterward.
                let traced = unsafe {
                    libc::ptrace(libc::PTRACE_TRACEME, 0, 0usize, 0usize) == 0
                        && libc::raise(libc::SIGSTOP) == 0
                };
                if traced {
                    action().err().unwrap_or(SetupFailure::Execute)
                } else {
                    SetupFailure::Execute
                }
            }
        }
    } else {
        SetupFailure::Execute
    };
    let message = format!("NERVA_EXEC_SETUP {}\n", failure.code());
    // SAFETY: The immutable message is live for its exact length; the child writes only bounded setup diagnostics and never returns.
    unsafe {
        libc::write(libc::STDERR_FILENO, message.as_ptr().cast(), message.len());
        libc::_exit(125);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    #[test]
    fn immediate_success_requires_a_kernel_exec_event() {
        let mut payload = Payload::spawn(
            || Ok(()),
            || {
                let _error = Command::new("/bin/true").exec();
                Err(SetupFailure::Execute)
            },
        )
        .unwrap();
        let status = loop {
            if let Some(status) = payload.try_status().unwrap() {
                break status;
            }
            std::thread::yield_now();
        };
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 0);
    }

    #[test]
    fn failed_exec_preexec_death_and_generic_trap_cannot_report_ready() {
        assert!(
            Payload::spawn(
                || Ok(()),
                || {
                    let _error = Command::new("/nerva-does-not-exist").exec();
                    Err(SetupFailure::Execute)
                }
            )
            .is_err()
        );
        assert!(
            Payload::spawn(
                || Ok(()),
                || {
                    // SAFETY: This test-only child kills only itself before exec; the parent must refuse Ready and join it.
                    unsafe {
                        libc::raise(libc::SIGKILL);
                    }
                    Err(SetupFailure::Execute)
                }
            )
            .is_err()
        );
        assert!(
            Payload::spawn(
                || Ok(()),
                || {
                    // SAFETY: A test-only ordinary SIGTRAP is not a kernel exec event and must be rejected.
                    unsafe {
                        libc::raise(libc::SIGTRAP);
                    }
                    Err(SetupFailure::Execute)
                }
            )
            .is_err()
        );
    }
}
