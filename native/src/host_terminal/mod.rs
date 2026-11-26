// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

//! An explicitly consented host PTY owns its terminal session, not a sandbox or managed lock scope.

mod io;
mod protocol;
mod session;

use protocol::{Control, Launch, MAXIMUM_CONTROL, MAXIMUM_LAUNCH, Report, invalid};
use session::{RootExit, Session};
use std::io as stdio;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

struct Transfer {
    started: Instant,
    stop_at_ms: AtomicU64,
    stopping: AtomicBool,
    output_done: AtomicBool,
    output_complete: AtomicBool,
    output_bytes: AtomicU64,
}

impl Transfer {
    fn stop(&self) {
        let now = u64::try_from(self.started.elapsed().as_millis())
            .unwrap_or(u64::MAX - 1)
            .saturating_add(1);
        let _ = self
            .stop_at_ms
            .compare_exchange(0, now, Ordering::AcqRel, Ordering::Acquire);
        self.stopping.store(true, Ordering::Release);
    }

    fn drain_expired(&self) -> bool {
        let stopped = self.stop_at_ms.load(Ordering::Acquire);
        stopped != 0
            && self.started.elapsed().as_millis().saturating_add(1) >= u128::from(stopped) + 10000
    }
}

struct Runtime {
    launch: Launch,
    session: Session,
    channel: Arc<io::Channel>,
    transfer: Arc<Transfer>,
    input: Option<JoinHandle<stdio::Result<()>>>,
    output: Option<JoinHandle<stdio::Result<()>>>,
    stopped: bool,
}

pub fn probe() -> bool {
    let mut master = -1;
    let mut slave = -1;
    // SAFETY: openpty initializes both descriptors; null optional arguments select normal terminal defaults.
    if unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } < 0
    {
        return false;
    }
    // SAFETY: successful openpty transferred these two fresh descriptors to this scope.
    let (_master, _slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    #[cfg(target_os = "linux")]
    {
        // SAFETY: zero flags request an identity-pinned descriptor for this existing process only.
        let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0) };
        if pidfd < 0 {
            return false;
        }
        // SAFETY: the checked syscall result is a newly owned file descriptor.
        let _pidfd = unsafe { OwnedFd::from_raw_fd(pidfd as i32) };
    }
    true
}

pub fn run() -> stdio::Result<()> {
    // SAFETY: --host-terminal's documented private ABI transfers inherited descriptor 3 to this owner.
    let descriptor = unsafe { OwnedFd::from_raw_fd(3) };
    let channel = Arc::new(io::Channel::new(descriptor)?);
    let mut pending = Vec::new();
    let deadline = Instant::now();
    let launch: Launch = loop {
        if deadline.elapsed() >= Duration::from_secs(10) {
            return Err(invalid());
        }
        if let Some(line) = io::line(channel.descriptor(), &mut pending, MAXIMUM_LAUNCH)? {
            break serde_json::from_slice(&line).map_err(|_| invalid())?;
        }
        io::poll(channel.descriptor(), libc::POLLIN, 100)?;
    };
    launch.validate()?;
    if !pending.is_empty() {
        return Err(invalid());
    }
    io::close_on_exec(4).or_else(|error| {
        if error.raw_os_error() == Some(libc::EBADF) {
            Ok(())
        } else {
            Err(error)
        }
    })?;
    io::nonblocking(0)?;
    io::nonblocking(1)?;
    let session = Session::create(&launch)?;
    let transfer = Arc::new(Transfer {
        started: Instant::now(),
        stop_at_ms: AtomicU64::new(0),
        stopping: AtomicBool::new(false),
        output_done: AtomicBool::new(false),
        output_complete: AtomicBool::new(false),
        output_bytes: AtomicU64::new(0),
    });
    let mut runtime = Runtime {
        launch,
        session,
        channel,
        transfer,
        input: None,
        output: None,
        stopped: false,
    };
    runtime.start()?;
    runtime.serve()
}

impl Runtime {
    fn start(&mut self) -> stdio::Result<()> {
        let master = self.session.master.clone();
        let transfer = self.transfer.clone();
        let channel = self.channel.clone();
        let token = self.launch.token.clone();
        self.input = Some(
            thread::Builder::new()
                .name("host-terminal-input".into())
                .spawn(move || {
                    let result = input(master, transfer.clone(), channel, token);
                    if result.is_err() {
                        transfer.stop();
                    }
                    result
                })?,
        );
        let master = self.session.master.clone();
        let transfer = self.transfer.clone();
        self.output = Some(
            thread::Builder::new()
                .name("host-terminal-output".into())
                .spawn(move || {
                    let result = output(master, transfer.clone());
                    transfer
                        .output_complete
                        .store(result.is_ok(), Ordering::Release);
                    transfer.output_done.store(true, Ordering::Release);
                    if result.is_err() {
                        transfer.stop();
                    }
                    result
                })?,
        );
        self.channel.send(&Report::Ready {
            token: &self.launch.token,
            cols: self.launch.cols,
            rows: self.launch.rows,
        })
    }

    fn serve(&mut self) -> stdio::Result<()> {
        let mut pending = Vec::new();
        let mut previous: Option<(Option<RootExit>, bool)> = None;
        let mut attempted_stop = false;
        let mut controls = 0usize;
        loop {
            let exit = self.session.root_exit()?;
            let done = self.transfer.output_done.load(Ordering::Acquire);
            if previous != Some((exit, done)) {
                self.state(exit)?;
                previous = Some((exit, done));
            }
            if self.transfer.stopping.load(Ordering::Acquire) && !attempted_stop {
                attempted_stop = true;
                let _ = self.stop();
            }
            let line = match io::line(self.channel.descriptor(), &mut pending, MAXIMUM_CONTROL) {
                Ok(line) => line,
                Err(error) => {
                    let _ = self.stop();
                    return if error.kind() == stdio::ErrorKind::UnexpectedEof {
                        Ok(())
                    } else {
                        Err(error)
                    };
                }
            };
            if let Some(line) = line {
                controls += 1;
                if controls > 4096 {
                    return Err(invalid());
                }
                let control: Control = serde_json::from_slice(&line).map_err(|_| invalid())?;
                control.validate(&self.launch.token)?;
                match control {
                    Control::Resize { id, cols, rows, .. } => {
                        let ok = !self.stopped && self.session.resize(cols, rows).is_ok();
                        if ok {
                            self.launch.cols = cols;
                            self.launch.rows = rows;
                        }
                        self.channel.send(&Report::Control {
                            token: &self.launch.token,
                            id: &id,
                            ok,
                        })?;
                    }
                    Control::Stop { id, .. } => {
                        let ok = self.stop().is_ok();
                        self.state(self.session.root_exit()?)?;
                        self.channel.send(&Report::Control {
                            token: &self.launch.token,
                            id: &id,
                            ok,
                        })?;
                        attempted_stop = true;
                    }
                }
            } else {
                io::poll(self.channel.descriptor(), libc::POLLIN, 100)?;
            }
        }
    }

    fn state(&self, exit: Option<RootExit>) -> stdio::Result<()> {
        let complete = self.transfer.output_done.load(Ordering::Acquire)
            && self.transfer.output_complete.load(Ordering::Acquire);
        self.channel.send(&Report::State {
            token: &self.launch.token,
            running: exit.is_none(),
            tree_running: None,
            exit_code: exit.and_then(|value| value.code),
            signal: exit.and_then(|value| value.signal),
            output_complete: complete,
            output_final_bytes: complete.then(|| {
                self.transfer
                    .output_bytes
                    .load(Ordering::Acquire)
                    .to_string()
            }),
        })
    }

    fn stop(&mut self) -> stdio::Result<()> {
        if self.stopped {
            return Ok(());
        }
        self.transfer.stop();
        self.session.stop()?;
        if let Some(thread) = self.input.take() {
            let _ = thread.join().map_err(|_| invalid())?;
        }
        if let Some(thread) = self.output.take() {
            thread.join().map_err(|_| invalid())??;
        }
        self.stopped = true;
        Ok(())
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn input(
    master: Arc<OwnedFd>,
    transfer: Arc<Transfer>,
    channel: Arc<io::Channel>,
    token: String,
) -> stdio::Result<()> {
    let mut bytes = [0u8; 32768];
    let mut accepted = 0u64;
    while !transfer.stopping.load(Ordering::Acquire) {
        if !io::poll(0, libc::POLLIN, 100)? {
            continue;
        }
        let count = match io::read(0, &mut bytes) {
            Ok(0) => {
                transfer.stop();
                return Ok(());
            }
            Ok(count) => count,
            Err(error)
                if error.kind() == stdio::ErrorKind::WouldBlock
                    || error.kind() == stdio::ErrorKind::Interrupted =>
            {
                continue;
            }
            Err(error) => return Err(error),
        };
        io::write_all(
            master.as_raw_fd(),
            &bytes[..count],
            || transfer.stopping.load(Ordering::Acquire),
            Duration::from_secs(10),
        )?;
        accepted = accepted
            .checked_add(count as u64)
            .filter(|value| *value <= i64::MAX as u64)
            .ok_or_else(invalid)?;
        channel.send(&Report::Input {
            token: &token,
            accepted_bytes: accepted.to_string(),
        })?;
    }
    Ok(())
}

fn output(master: Arc<OwnedFd>, transfer: Arc<Transfer>) -> stdio::Result<()> {
    let mut bytes = [0u8; 32768];
    loop {
        if transfer.drain_expired() {
            return Err(stdio::Error::new(
                stdio::ErrorKind::TimedOut,
                "terminal-output-drain-unconfirmed",
            ));
        }
        if !io::poll(master.as_raw_fd(), libc::POLLIN, 100)? {
            continue;
        }
        let count = match io::read(master.as_raw_fd(), &mut bytes) {
            Ok(0) => return Ok(()),
            Ok(count) => count,
            Err(error) if error.raw_os_error() == Some(libc::EIO) => return Ok(()),
            Err(error)
                if error.kind() == stdio::ErrorKind::WouldBlock
                    || error.kind() == stdio::ErrorKind::Interrupted =>
            {
                continue;
            }
            Err(error) => return Err(error),
        };
        io::write_all(
            1,
            &bytes[..count],
            || transfer.drain_expired(),
            Duration::from_secs(8 * 86400),
        )?;
        let next = transfer
            .output_bytes
            .load(Ordering::Relaxed)
            .checked_add(count as u64)
            .filter(|next| *next <= i64::MAX as u64)
            .ok_or_else(invalid)?;
        transfer.output_bytes.store(next, Ordering::Release);
    }
}
