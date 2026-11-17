// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Only this fixed inherited Unix socket carries finite local native control records.

use super::configuration::invalid;
use super::pipe_protocol::{Decoded, ENCODED_BYTES, Event, decode};
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};

#[cfg(test)]
static INTERRUPTED_POLLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub struct Broker {
    channel: File,
    pending: Vec<u8>,
}

pub fn nonblocking(fd: i32) -> io::Result<()> {
    // SAFETY: The caller owns this live descriptor; only its nonblocking status changes.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    // SAFETY: The valid status flags are preserved and O_NONBLOCK cannot grant descriptor authority.
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn poll(entries: &mut [libc::pollfd], expires_at_ms: u64) -> io::Result<()> {
    loop {
        let timeout = super::launch_window::remaining_ms(expires_at_ms)?.min(1000) as i32;
        // SAFETY: The mutable slice contains initialized pollfd records for owned descriptors.
        if unsafe { libc::poll(entries.as_mut_ptr(), entries.len() as libc::nfds_t, timeout) } >= 0
        {
            super::launch_window::check(expires_at_ms)?;
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
        #[cfg(test)]
        INTERRUPTED_POLLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
}

pub fn verify(descriptor: i32) -> io::Result<()> {
    let mut kind: i32 = 0;
    let mut domain: i32 = 0;
    let mut length = std::mem::size_of::<i32>() as libc::socklen_t;
    // SAFETY: Explicit Pipe bootstrap moved the separate inherited control socket to fd zero; the initialized output pointers have their supplied exact sizes.
    if unsafe {
        libc::getsockopt(
            descriptor,
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            (&mut kind as *mut i32).cast(),
            &mut length,
        )
    } != 0
        || kind != libc::SOCK_STREAM
    {
        return Err(invalid());
    }
    length = std::mem::size_of::<i32>() as libc::socklen_t;
    // SAFETY: The same fixed live descriptor and initialized scalar identify its socket domain.
    if unsafe {
        libc::getsockopt(
            descriptor,
            libc::SOL_SOCKET,
            libc::SO_DOMAIN,
            (&mut domain as *mut i32).cast(),
            &mut length,
        )
    } != 0
        || domain != libc::AF_UNIX
    {
        return Err(invalid());
    }
    Ok(())
}

impl Broker {
    pub fn open() -> io::Result<Self> {
        verify(0)?;
        // SAFETY: The explicit Pipe launch transfers this fixed socket exactly once to the native broker owner.
        let channel = unsafe { File::from_raw_fd(0) };
        nonblocking(channel.as_raw_fd())?;
        Ok(Self {
            channel,
            pending: Vec::with_capacity(ENCODED_BYTES),
        })
    }

    pub fn buffered(&self) -> bool {
        self.pending.contains(&b'\n')
    }

    /// Reporting expiry never waits for a blocked controller or delays payload cleanup.
    pub fn notify_expired(&mut self, event: &Event<'_>) {
        if let Ok(mut bytes) = serde_json::to_vec(event)
            && bytes.len() <= 1024
        {
            bytes.push(b'\n');
            let _ = self.channel.write(&bytes);
        }
    }

    pub fn descriptor(&self) -> i32 {
        self.channel.as_raw_fd()
    }

    pub fn receive(
        &mut self,
        incarnation: &str,
        expires_at_ms: u64,
    ) -> io::Result<Option<Decoded>> {
        loop {
            super::launch_window::check(expires_at_ms)?;
            if let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
                let command = decode(&self.pending[..end], incarnation)?;
                self.pending.drain(..=end);
                return Ok(Some(command));
            }
            let mut chunk = [0u8; 4096];
            match self.channel.read(&mut chunk) {
                Ok(0) => return Err(io::Error::other("Native Pipe control owner closed")),
                Ok(count) => {
                    if self.pending.len() + count > ENCODED_BYTES + 1 {
                        return Err(invalid());
                    }
                    self.pending.extend_from_slice(&chunk[..count]);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(None),
                Err(error) => return Err(error),
            }
        }
    }

    pub fn send(&mut self, event: &Event<'_>, expires_at_ms: u64) -> io::Result<()> {
        let mut bytes = serde_json::to_vec(event).map_err(|_| invalid())?;
        if bytes.len() > 1024 {
            return Err(invalid());
        }
        bytes.push(b'\n');
        let mut offset = 0;
        while offset < bytes.len() {
            super::launch_window::check(expires_at_ms)?;
            match self.channel.write(&bytes[offset..]) {
                Ok(0) => return Err(io::Error::other("Native Pipe receipt channel closed")),
                Ok(count) => offset += count,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    let mut entries = [libc::pollfd {
                        fd: self.descriptor(),
                        events: libc::POLLOUT,
                        revents: 0,
                    }];
                    poll(&mut entries, expires_at_ms)?;
                    if entries[0].revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
                        return Err(invalid());
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::OwnedFd;
    use std::os::unix::net::UnixStream;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    fn expiry() -> u64 {
        (SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64)
            + 30
    }

    #[test]
    fn actual_socket_receipt_backpressure_and_idle_poll_are_deadline_bounded() {
        let (sender, _receiver) = UnixStream::pair().unwrap();
        sender.set_nonblocking(true).unwrap();
        let descriptor: OwnedFd = sender.into();
        let mut broker = Broker {
            channel: File::from(descriptor),
            pending: Vec::with_capacity(ENCODED_BYTES),
        };
        let bytes = [0u8; 4096];
        let mut filled = 0;
        loop {
            match broker.channel.write(&bytes) {
                Ok(count) => {
                    filled += count;
                    assert!(filled <= 4 * 1024 * 1024);
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) => panic!("{error}"),
            }
        }
        let started = Instant::now();
        let event = Event::Ready {
            incarnation: &"a".repeat(64),
            initial_input_bytes: 0,
            initial_input_hash: digest_empty(),
        };
        assert_eq!(
            broker.send(&event, expiry()).unwrap_err().raw_os_error(),
            Some(libc::ETIMEDOUT)
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        let started = Instant::now();
        let mut entries = [libc::pollfd {
            fd: broker.descriptor(),
            events: libc::POLLOUT,
            revents: 0,
        }];
        assert_eq!(
            poll(&mut entries, expiry()).unwrap_err().raw_os_error(),
            Some(libc::ETIMEDOUT)
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    fn digest_empty() -> String {
        super::super::pipe_protocol::digest(b"")
    }

    extern "C" fn interrupt(_signal: libc::c_int) {}

    struct OwnedChild(libc::pid_t);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            // SAFETY: This fixed unreaped child cannot be PID-reused and no caller supplies a foreign process identity.
            unsafe {
                libc::kill(self.0, libc::SIGKILL);
                libc::waitpid(self.0, std::ptr::null_mut(), 0);
            }
        }
    }

    #[test]
    fn actual_repeated_eintr_does_not_refresh_the_captured_poll_cutoff() {
        use std::sync::atomic::Ordering;
        let (ready_read, ready_write) = UnixStream::pair().unwrap();
        let (idle, _idle_peer) = UnixStream::pair().unwrap();
        let deadline = expiry() + 170;
        // SAFETY: This test-owned child uses only clock/poll/signal and initialized stack storage after fork, then _exit; it touches no application services.
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            // SAFETY: The zeroed sigaction is initialized before use; the handler changes only this isolated owned child's disposition.
            unsafe {
                let mut action: libc::sigaction = std::mem::zeroed();
                action.sa_sigaction = interrupt as *const () as usize;
                libc::sigemptyset(&mut action.sa_mask);
                if libc::sigaction(libc::SIGUSR1, &action, std::ptr::null_mut()) != 0 {
                    libc::_exit(2);
                }
                INTERRUPTED_POLLS.store(0, Ordering::Relaxed);
                if libc::write(ready_write.as_raw_fd(), b"x".as_ptr().cast(), 1) != 1 {
                    libc::_exit(3);
                }
                let mut entries = [libc::pollfd {
                    fd: idle.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                }];
                let expired = poll(&mut entries, deadline)
                    .is_err_and(|error| error.raw_os_error() == Some(libc::ETIMEDOUT));
                libc::_exit(
                    if expired && INTERRUPTED_POLLS.load(Ordering::Relaxed) >= 3 {
                        0
                    } else {
                        4
                    },
                );
            }
        }
        let child = OwnedChild(pid);
        drop(ready_write);
        let mut ready_entries = [libc::pollfd {
            fd: ready_read.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        }];
        // SAFETY: One initialized record observes only the test-owned ready socket, with a finite wait.
        assert!(unsafe { libc::poll(ready_entries.as_mut_ptr(), 1, 1000) } > 0);
        let mut byte = [0u8];
        // SAFETY: The initialized one-byte buffer receives only the owned child's readiness marker.
        let count = unsafe { libc::read(ready_read.as_raw_fd(), byte.as_mut_ptr().cast(), 1) };
        assert_eq!(count, 1);
        let started = Instant::now();
        loop {
            // SAFETY: The child remains owned and unreaped throughout this finite loop, so PID reuse cannot target another process.
            unsafe {
                libc::kill(pid, libc::SIGUSR1);
            }
            let mut status = 0;
            // SAFETY: Only this owned child is observed; status is initialized local storage.
            let result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
            if result == pid {
                std::mem::forget(child);
                assert!(libc::WIFEXITED(status));
                assert_eq!(libc::WEXITSTATUS(status), 0);
                break;
            }
            assert!(started.elapsed() < Duration::from_secs(2));
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
