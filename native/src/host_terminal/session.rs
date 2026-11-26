// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

use super::io::{close_on_exec, nonblocking};
use super::protocol::{Launch, invalid};
use std::ffi::CString;
#[cfg(target_os = "linux")]
use std::fs;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq)]
pub struct RootExit {
    pub code: Option<i32>,
    pub signal: Option<&'static str>,
}

pub struct Session {
    pub master: Arc<OwnedFd>,
    pid: libc::pid_t,
    reaped: bool,
}

impl Session {
    pub fn create(launch: &Launch) -> io::Result<Self> {
        let strings: Vec<CString> = launch.validate()?;
        let mut arguments: Vec<*const libc::c_char> =
            strings.iter().map(|value| value.as_ptr()).collect();
        arguments.push(std::ptr::null());
        let mut master = -1;
        let mut size = libc::winsize {
            ws_row: launch.rows,
            ws_col: launch.cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: the supervisor is single-threaded before forkpty; all exec arguments are built above.
        let parent = unsafe { libc::getpid() };
        // SAFETY: SIGCHLD is reset before creating children so WNOWAIT can retain their identities.
        unsafe {
            libc::signal(libc::SIGCHLD, libc::SIG_DFL);
            libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        }
        // SAFETY: master and size are valid, name/termios are intentionally null; no other threads exist yet.
        // macOS declares the termios and size arguments mutable; forkpty only reads them.
        let pid = unsafe {
            libc::forkpty(
                &mut master,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &raw mut size,
            )
        };
        if pid < 0 {
            return Err(io::Error::last_os_error());
        }
        if pid == 0 {
            // SAFETY: only async-signal-safe system calls execute in the child before execvp/_exit.
            unsafe {
                libc::signal(libc::SIGPIPE, libc::SIG_DFL);
                #[cfg(target_os = "linux")]
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) < 0 {
                    libc::_exit(125);
                }
                if libc::getppid() != parent {
                    libc::_exit(125);
                }
                libc::execvp(strings[0].as_ptr(), arguments.as_ptr());
                libc::_exit(127);
            }
        }
        // SAFETY: forkpty returned this new owned master descriptor only to the parent.
        let descriptor = unsafe { OwnedFd::from_raw_fd(master) };
        let mut session = Self {
            master: Arc::new(descriptor),
            pid,
            reaped: false,
        };
        if let Err(error) = nonblocking(master).and_then(|()| close_on_exec(master)) {
            let _ = session.stop();
            return Err(error);
        }
        Ok(session)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        super::protocol::geometry(cols, rows)?;
        let size = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: the retained master and initialized winsize remain valid for this ioctl.
        if unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ, &size) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn root_exit(&self) -> io::Result<Option<RootExit>> {
        if self.reaped {
            return Err(invalid());
        }
        // SAFETY: an all-zero siginfo_t is valid output storage for waitid.
        let mut information: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // SAFETY: pid is our unreaped child; WNOWAIT retains its kernel identity until disposal.
        if unsafe {
            libc::waitid(
                libc::P_PID,
                self.pid as u32,
                &mut information,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } < 0
        {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: waitid initialized the child-status variant of this siginfo_t.
        if unsafe { information.si_pid() } == 0 {
            return Ok(None);
        }
        // SAFETY: a nonzero waitid child status has the documented si_status field.
        let status = unsafe { information.si_status() };
        Ok(Some(if information.si_code == libc::CLD_EXITED {
            RootExit {
                code: Some(status),
                signal: None,
            }
        } else {
            RootExit {
                code: None,
                signal: Some(signal_name(status)),
            }
        }))
    }

    pub fn stop(&mut self) -> io::Result<RootExit> {
        let deadline = Instant::now();
        loop {
            let active = self.signal_session()?;
            if active == 0 && self.root_exit()?.is_some() {
                break;
            }
            if deadline.elapsed() >= Duration::from_secs(10) {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "terminal-session-stop-unconfirmed",
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        self.root_exit()?.ok_or_else(invalid)
    }

    #[cfg(target_os = "linux")]
    fn signal_session(&self) -> io::Result<usize> {
        let mut active = 0;
        for (index, entry) in fs::read_dir("/proc")?.enumerate() {
            if index >= 1_048_576 {
                return Err(invalid());
            }
            let entry = entry?;
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|value| value.parse::<i32>().ok())
                .filter(|value| *value > 1)
            else {
                continue;
            };
            if !in_session(pid, self.pid)? {
                continue;
            }
            // SAFETY: pidfd_open takes a numeric PID and zero flags; the returned descriptor pins signal identity.
            let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
            if raw < 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ESRCH) {
                    continue;
                }
                return Err(error);
            }
            // SAFETY: pidfd_open returned a new owned descriptor after the nonnegative check above.
            let handle =
                unsafe { OwnedFd::from_raw_fd(i32::try_from(raw).map_err(|_| invalid())?) };
            if !in_session(pid, self.pid)? {
                continue;
            }
            // SAFETY: the retained pidfd selects its original process even if the numeric PID is later reused.
            let result = unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    handle.as_raw_fd(),
                    libc::SIGKILL,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                )
            };
            if result < 0 && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
                return Err(io::Error::last_os_error());
            }
            active += 1;
        }
        Ok(active)
    }

    /// macOS has no `/proc` or pidfd: libproc lists processes, `getsid` selects this session, and
    /// zombies are skipped so the unreaped session leader does not count as running.
    #[cfg(target_os = "macos")]
    fn signal_session(&self) -> io::Result<usize> {
        // SAFETY: a null buffer with zero size asks libproc only for the current process count.
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if count < 0 {
            return Err(io::Error::last_os_error());
        }
        let capacity = usize::try_from(count)
            .map_err(|_| invalid())?
            .saturating_add(256)
            .min(1_048_576);
        let mut pids: Vec<libc::pid_t> = vec![0; capacity];
        let bytes =
            i32::try_from(capacity * std::mem::size_of::<libc::pid_t>()).map_err(|_| invalid())?;
        // SAFETY: the buffer holds `capacity` pid_t values and its exact byte size is passed.
        let listed = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        if listed < 0 {
            return Err(io::Error::last_os_error());
        }
        let listed = usize::try_from(listed)
            .map_err(|_| invalid())?
            .min(capacity);
        let mut active = 0;
        for &pid in &pids[..listed] {
            // SAFETY: getsid only reads the session identifier of a numeric process ID.
            if pid <= 1 || unsafe { libc::getsid(pid) } != self.pid || !live(pid)? {
                continue;
            }
            // SAFETY: the process was just confirmed to be a live member of this terminal session.
            if unsafe { libc::kill(pid, libc::SIGKILL) } < 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ESRCH) {
                    continue;
                }
                return Err(error);
            }
            active += 1;
        }
        Ok(active)
    }
}

/// Whether a process still exists and is not a zombie; a vanished process is not live.
#[cfg(target_os = "macos")]
fn live(pid: libc::pid_t) -> io::Result<bool> {
    // SAFETY: an all-zero proc_bsdinfo is valid output storage.
    let mut information: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = i32::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).map_err(|_| invalid())?;
    // SAFETY: the buffer is exactly one proc_bsdinfo and its size is passed.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&raw mut information).cast(),
            size,
        )
    };
    Ok(written == size && information.pbi_status != libc::SZOMB)
}

impl Drop for Session {
    fn drop(&mut self) {
        if !self.reaped {
            let _ = self.signal_session();
            // SAFETY: this is still our unreaped direct child, so its numeric PID cannot identify another process.
            unsafe {
                libc::kill(self.pid, libc::SIGKILL);
            }
            let deadline = Instant::now();
            while deadline.elapsed() < Duration::from_secs(10) {
                let mut status = 0;
                // SAFETY: waitpid only reaps our retained direct child and writes one initialized integer.
                let result = unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG) };
                if result == self.pid
                    || (result < 0
                        && io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD))
                {
                    self.reaped = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn in_session(pid: i32, expected: i32) -> io::Result<bool> {
    let value = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return Ok(false),
        Err(error) => return Err(error),
    };
    let Some((_, rest)) = value.rsplit_once(") ") else {
        return Err(invalid());
    };
    let mut fields = rest.split_whitespace();
    let state = fields.next().ok_or_else(invalid)?;
    let session = fields
        .nth(2)
        .ok_or_else(invalid)?
        .parse::<i32>()
        .map_err(|_| invalid())?;
    Ok(session == expected && state != "Z" && state != "X")
}

fn signal_name(value: i32) -> &'static str {
    match value {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGABRT => "SIGABRT",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        libc::SIGBUS => "SIGBUS",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGSYS => "SIGSYS",
        _ => "UNKNOWN",
    }
}
