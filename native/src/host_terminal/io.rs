// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

use super::protocol::{MAXIMUM_CONTROL, MAXIMUM_PENDING, Report, invalid};
use std::io;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct Channel {
    descriptor: OwnedFd,
    writer: Mutex<()>,
}

impl Channel {
    pub fn new(descriptor: OwnedFd) -> io::Result<Self> {
        nonblocking(descriptor.as_raw_fd())?;
        close_on_exec(descriptor.as_raw_fd())?;
        Ok(Self {
            descriptor,
            writer: Mutex::new(()),
        })
    }

    pub fn descriptor(&self) -> RawFd {
        self.descriptor.as_raw_fd()
    }

    pub fn send(&self, report: &Report<'_>) -> io::Result<()> {
        let _guard = self.writer.lock().map_err(|_| invalid())?;
        let mut bytes = serde_json::to_vec(report).map_err(|_| invalid())?;
        if bytes.len() >= MAXIMUM_CONTROL {
            return Err(invalid());
        }
        bytes.push(b'\n');
        write_all(self.descriptor(), &bytes, || false, Duration::from_secs(10))
    }
}

pub fn nonblocking(descriptor: RawFd) -> io::Result<()> {
    // SAFETY: fcntl receives a live borrowed descriptor and integer flag arguments.
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the descriptor remains owned by the caller throughout this operation.
    if unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn close_on_exec(descriptor: RawFd) -> io::Result<()> {
    // SAFETY: fcntl receives a live borrowed descriptor and integer flag arguments.
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: only this inherited descriptor's execution inheritance is changed.
    if unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn poll(descriptor: RawFd, events: libc::c_short, milliseconds: i32) -> io::Result<bool> {
    let mut selected = libc::pollfd {
        fd: descriptor,
        events,
        revents: 0,
    };
    loop {
        // SAFETY: selected is one initialized pollfd, valid for the duration of poll.
        let result = unsafe { libc::poll(&mut selected, 1, milliseconds) };
        if result >= 0 {
            if selected.revents & libc::POLLNVAL != 0 {
                return Err(invalid());
            }
            return Ok(result != 0);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

pub fn read(descriptor: RawFd, buffer: &mut [u8]) -> io::Result<usize> {
    // SAFETY: buffer is writable for exactly buffer.len() bytes and descriptor is borrowed.
    let result = unsafe { libc::read(descriptor, buffer.as_mut_ptr().cast(), buffer.len()) };
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result as usize)
    }
}

pub fn write_all(
    descriptor: RawFd,
    bytes: &[u8],
    interrupted: impl Fn() -> bool,
    timeout: Duration,
) -> io::Result<()> {
    let deadline = Instant::now();
    let mut position = 0;
    while position < bytes.len() {
        if interrupted() || deadline.elapsed() >= timeout {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "terminal-write-interrupted",
            ));
        }
        // SAFETY: the remaining immutable slice is valid for the requested write length.
        let written = unsafe {
            libc::write(
                descriptor,
                bytes[position..].as_ptr().cast(),
                bytes.len() - position,
            )
        };
        if written > 0 {
            position += written as usize;
        } else if written == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "terminal-write-zero",
            ));
        } else {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::WouldBlock {
                poll(descriptor, libc::POLLOUT, 100)?;
            } else if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
    Ok(())
}

pub fn line(
    descriptor: RawFd,
    buffer: &mut Vec<u8>,
    maximum: usize,
) -> io::Result<Option<Vec<u8>>> {
    if maximum > MAXIMUM_PENDING {
        return Err(invalid());
    }
    if let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
        if end > maximum {
            return Err(invalid());
        }
        let mut selected: Vec<u8> = buffer.drain(..=end).collect();
        selected.pop();
        return Ok(Some(selected));
    }
    if buffer.len() > maximum {
        return Err(invalid());
    }
    let mut bytes = [0u8; 4096];
    match read(descriptor, &mut bytes) {
        Ok(0) => Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "terminal-control-closed",
        )),
        Ok(count) => {
            buffer.extend_from_slice(&bytes[..count]);
            if buffer.len() > maximum + bytes.len() {
                return Err(invalid());
            }
            if buffer.contains(&b'\n') {
                line(descriptor, buffer, maximum)
            } else {
                Ok(None)
            }
        }
        Err(error)
            if error.kind() == io::ErrorKind::WouldBlock
                || error.kind() == io::ErrorKind::Interrupted =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}
