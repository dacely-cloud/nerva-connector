// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Actual host PTYs exercise the existing ELF and private descriptor protocol without sandbox or managed-lock claims.

use serde::Deserialize;
use serde_json::json;
use std::fs;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MAXIMUM_OUTPUT: usize = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum Report {
    Ready {
        token: String,
        cols: u16,
        rows: u16,
    },
    Input {
        token: String,
        #[serde(rename = "acceptedBytes")]
        accepted: String,
    },
    State {
        token: String,
        running: bool,
        #[serde(rename = "treeRunning")]
        tree: Option<bool>,
        #[serde(rename = "exitCode")]
        exit: Option<i32>,
        signal: Option<String>,
        #[serde(rename = "outputComplete")]
        complete: bool,
        #[serde(rename = "outputFinalBytes")]
        final_bytes: Option<String>,
    },
    Control {
        token: String,
        id: String,
        ok: bool,
    },
}

impl Report {
    fn validate(&self) {
        let token = match self {
            Self::Ready { token, cols, rows } => {
                assert!((2..=500).contains(cols) && (1..=200).contains(rows));
                token
            }
            Self::Input { token, accepted } => {
                decimal(accepted);
                token
            }
            Self::State {
                token,
                tree,
                complete,
                final_bytes,
                ..
            } => {
                assert_eq!(
                    *tree, None,
                    "a host PTY must not invent complete tree containment"
                );
                assert_eq!(*complete, final_bytes.is_some());
                if let Some(value) = final_bytes {
                    decimal(value);
                }
                token
            }
            Self::Control { token, id, .. } => {
                decimal(id);
                token
            }
        };
        assert_eq!(token, TOKEN);
    }
}

fn decimal(value: &str) -> u64 {
    let parsed = value.parse::<u64>().expect("exact decimal counter");
    assert!(parsed <= i64::MAX as u64);
    assert_eq!(parsed.to_string(), value);
    parsed
}

fn nonblocking(descriptor: i32) {
    // SAFETY: this fixture owns the supplied descriptor and changes only its own nonblocking flag.
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
    assert!(flags >= 0);
    // SAFETY: the live descriptor and checked flags remain valid across this call.
    assert!(unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } >= 0);
}

struct ProcessIdentity {
    pid: i32,
    handle: OwnedFd,
}

impl ProcessIdentity {
    fn capture(pid: i32) -> Option<Self> {
        // SAFETY: pidfd_open creates an identity-pinned descriptor; no numeric PID is signaled by the fixture.
        let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        if raw < 0 {
            return None;
        }
        // SAFETY: the successful syscall transferred one newly owned descriptor.
        let handle = unsafe { OwnedFd::from_raw_fd(i32::try_from(raw).unwrap()) };
        Some(Self { pid, handle })
    }

    fn kill(&self) {
        // SAFETY: the retained pidfd identifies only this captured fixture process, including after PID reuse.
        unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.handle.as_raw_fd(),
                libc::SIGKILL,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            );
        }
    }

    fn reap(&self) {
        // SAFETY: zeroed siginfo_t is valid waitid output storage; P_PIDFD selects this exact adopted child identity.
        let mut status: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // SAFETY: the retained pidfd cannot select a replacement or unrelated fixture child after numeric PID reuse.
        unsafe {
            libc::waitid(
                libc::P_PIDFD,
                self.handle.as_raw_fd() as u32,
                &mut status,
                libc::WEXITED | libc::WNOHANG,
            );
        }
    }
}

/// Each fixture retains subprocess and pipe ownership, including when an assertion unwinds.
struct Terminal {
    child: Child,
    channel: Option<UnixStream>,
    input: Option<ChildStdin>,
    output: ChildStdout,
    pending: Vec<u8>,
    bytes: Vec<u8>,
    reports: Vec<Report>,
    identities: Vec<ProcessIdentity>,
}

impl Terminal {
    fn launch(source: &str) -> Self {
        static SUBREAPER: OnceLock<()> = OnceLock::new();
        SUBREAPER.get_or_init(|| {
            // SAFETY: only this isolated integration-test process adopts its own orphaned fixture descendants for cleanup.
            assert_eq!(unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1) }, 0);
        });
        let (mut parent, child) = UnixStream::pair().unwrap();
        // SAFETY: this duplication pins the channel above all fixed child stdio/bootstrap descriptors.
        let descriptor = unsafe { libc::fcntl(child.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 16) };
        assert!(descriptor >= 16);
        // SAFETY: fcntl transferred this fresh descriptor to the fixture.
        let pinned = unsafe { OwnedFd::from_raw_fd(descriptor) };
        let mut command = Command::new(env!("CARGO_BIN_EXE_nerva-connector-exec"));
        command
            .arg("--host-terminal")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("TERM", "xterm-256color")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // SAFETY: only async-signal-safe dup/fcntl calls execute in the fork child, and pinned cannot alias descriptor3.
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(pinned.as_raw_fd(), 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        parent
            .write_all(
                &serde_json::to_vec(&json!({
                    "token": TOKEN,
                    "executable": "/usr/bin/python3",
                    "arguments": ["-I", "-B", "-c", source],
                    "windowsVerbatimArguments": false,
                    "cols": 80,
                    "rows": 24
                }))
                .unwrap(),
            )
            .unwrap();
        parent.write_all(b"\n").unwrap();
        parent.set_nonblocking(true).unwrap();
        nonblocking(output.as_raw_fd());
        let mut terminal = Self {
            child,
            channel: Some(parent),
            input: Some(input),
            output,
            pending: Vec::new(),
            bytes: Vec::new(),
            reports: Vec::new(),
            identities: Vec::new(),
        };
        terminal.wait(|value| {
            matches!(
                value,
                Report::Ready {
                    cols: 80,
                    rows: 24,
                    ..
                }
            )
        });
        terminal.capture_session();
        terminal
    }

    fn pump(&mut self, output: bool) -> io::Result<()> {
        if let Some(channel) = &mut self.channel {
            append(channel, &mut self.pending, 16384)?;
            while let Some(end) = self.pending.iter().position(|value| *value == b'\n') {
                assert!(end <= 4096 && self.reports.len() < 4096);
                let report: Report = serde_json::from_slice(&self.pending[..end]).unwrap();
                report.validate();
                self.reports.push(report);
                self.pending.drain(..=end);
            }
        }
        if output {
            append(&mut self.output, &mut self.bytes, MAXIMUM_OUTPUT)?;
        }
        Ok(())
    }

    fn wait(&mut self, selected: impl Fn(&Report) -> bool) -> &Report {
        let deadline = Instant::now();
        loop {
            self.pump(true).unwrap();
            if let Some(index) = self.reports.iter().position(&selected) {
                return &self.reports[index];
            }
            assert!(
                deadline.elapsed() < Duration::from_secs(20),
                "native report timed out: {:?}",
                self.reports
            );
            assert!(
                self.child.try_wait().unwrap().is_none(),
                "PTY broker exited before its expected report"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn output_contains(&mut self, expected: &[u8]) {
        let deadline = Instant::now();
        while !self
            .bytes
            .windows(expected.len())
            .any(|window| window == expected)
        {
            self.pump(true).unwrap();
            assert!(
                deadline.elapsed() < Duration::from_secs(10),
                "terminal output timed out"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn send(&mut self, value: serde_json::Value) {
        let channel = self.channel.as_mut().unwrap();
        channel
            .write_all(&serde_json::to_vec(&value).unwrap())
            .unwrap();
        channel.write_all(b"\n").unwrap();
    }

    fn input(&mut self, bytes: &[u8]) {
        self.input.as_mut().unwrap().write_all(bytes).unwrap();
    }

    fn stop(&mut self) {
        self.capture_session();
        self.send(json!({
            "token": TOKEN,
            "operation": "stop",
            "id": "2"
        }));
        self.wait(|value| matches!(value, Report::Control { id, ok: true, .. } if id == "2"));
        self.wait(|value| {
            matches!(
                value,
                Report::State {
                    running: false,
                    complete: true,
                    ..
                }
            )
        });
        self.pump(true).unwrap();
    }

    fn final_count(&self) -> u64 {
        self.reports
            .iter()
            .rev()
            .find_map(|value| match value {
                Report::State {
                    complete: true,
                    final_bytes: Some(bytes),
                    ..
                } => Some(decimal(bytes)),
                _ => None,
            })
            .expect("actual terminal EOF total")
    }

    fn disconnect(&mut self) {
        self.capture_session();
        if let Some(channel) = self.channel.take() {
            let _ = channel.shutdown(std::net::Shutdown::Both);
        }
        self.input.take();
    }

    fn exit(&mut self) -> ExitStatus {
        let deadline = Instant::now();
        loop {
            self.pump(true).unwrap();
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(
                deadline.elapsed() < Duration::from_secs(20),
                "PTY broker did not join cleanup"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn capture_session(&mut self) {
        let children = fs::read_to_string(format!(
            "/proc/{}/task/{}/children",
            self.child.id(),
            self.child.id()
        ))
        .unwrap_or_default();
        let Some(root) = children
            .split_whitespace()
            .next()
            .and_then(|value| value.parse::<i32>().ok())
        else {
            return;
        };
        for entry in fs::read_dir("/proc").unwrap().flatten() {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|value| value.parse::<i32>().ok())
            else {
                continue;
            };
            if process_session(pid).is_some_and(|(session, _)| session == root)
                && !self.identities.iter().any(|value| value.pid == pid)
                && let Some(identity) = ProcessIdentity::capture(pid)
                && process_session(pid).is_some_and(|(session, _)| session == root)
            {
                self.identities.push(identity);
            }
        }
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.disconnect();
        let deadline = Instant::now();
        while deadline.elapsed() < Duration::from_secs(15) {
            let _ = self.pump(true);
            if self.child.try_wait().ok().flatten().is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        for process in &self.identities {
            process.kill();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let deadline = Instant::now();
        while deadline.elapsed() < Duration::from_secs(2) {
            for process in &self.identities {
                process.reap();
            }
            if self
                .identities
                .iter()
                .all(|value| process_session(value.pid).is_none())
            {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
}

fn append(source: &mut impl Read, destination: &mut Vec<u8>, maximum: usize) -> io::Result<()> {
    let mut buffer = [0u8; 32768];
    loop {
        match source.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(count) => {
                assert!(destination.len() + count <= maximum);
                destination.extend_from_slice(&buffer[..count]);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
            Err(error) => return Err(error),
        }
    }
}

fn process_session(pid: i32) -> Option<(i32, String)> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, rest) = stat.rsplit_once(") ")?;
    let mut fields = rest.split_whitespace();
    let state = fields.next()?.to_owned();
    Some((fields.nth(2)?.parse().ok()?, state))
}

#[test]
fn actual_probe_reports_a_real_available_linux_pty() {
    let output = Command::new(env!("CARGO_BIN_EXE_nerva-connector-exec"))
        .arg("--host-terminal-probe")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap(),
        json!({
            "supported": true
        })
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn actual_terminal_input_resize_root_exit_and_final_bytes_remain_exact() {
    let mut terminal = Terminal::launch(
        r#"import os,tty,fcntl,termios,struct
assert os.isatty(0) and os.isatty(1) and os.isatty(2)
tty.setraw(0)
def size():
 r,c,_,_=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,b'\0'*8)); os.write(1,('SIZE:%d,%d\n'%(c,r)).encode())
size()
assert os.read(0,1)==b'R'
size()
data=os.read(0,64)
os.write(1,b'INPUT:'+data)
os._exit(7)
"#,
    );
    terminal.output_contains(b"SIZE:80,24\n");
    terminal.send(json!({
        "token": TOKEN,
        "operation": "resize",
        "id": "1",
        "cols": 112,
        "rows": 37
    }));
    terminal.wait(|value| matches!(value, Report::Control { id, ok: true, .. } if id == "1"));
    terminal.input(b"R");
    terminal.output_contains(b"SIZE:112,37\n");
    terminal.input(b"interactive\0\xff\n");
    terminal.wait(|value| matches!(value, Report::Input { accepted, .. } if accepted == "15"));
    terminal.wait(|value| {
        matches!(
            value,
            Report::State {
                running: false,
                exit: Some(7),
                signal: None,
                complete: true,
                ..
            }
        )
    });
    terminal.pump(true).unwrap();
    assert!(terminal.bytes.ends_with(b"INPUT:interactive\0\xff\n"));
    assert_eq!(terminal.final_count(), terminal.bytes.len() as u64);
    terminal.stop();
}

#[test]
fn binary_output_survives_real_pipe_backpressure_without_utf8_or_line_conversion() {
    let mut terminal = Terminal::launch(
        r#"import os,tty
tty.setraw(0)
os.write(1,b'READY\n')
assert os.read(0,1)==b'G'
data=bytes(range(256))*8192
while data:
 n=os.write(1,data); data=data[n:]
os._exit(0)
"#,
    );
    terminal.output_contains(b"READY\n");
    terminal.input(b"G");
    thread::sleep(Duration::from_millis(200));
    terminal.pump(false).unwrap();
    assert!(
        !terminal
            .reports
            .iter()
            .any(|value| matches!(value, Report::State { complete: true, .. })),
        "finite OS buffers must apply actual backpressure"
    );
    terminal.wait(|value| {
        matches!(
            value,
            Report::State {
                running: false,
                exit: Some(0),
                complete: true,
                ..
            }
        )
    });
    terminal.pump(true).unwrap();
    let expected: Vec<u8> = b"READY\n"
        .iter()
        .copied()
        .chain((0u8..=255).cycle().take(2 * 1024 * 1024))
        .collect();
    assert_eq!(terminal.bytes, expected);
    assert_eq!(terminal.final_count(), expected.len() as u64);
    terminal.stop();
}

const SESSION_CHILDREN: &str = r#"import os,signal,time
ready_read,ready_write=os.pipe()
child=os.fork()
if child==0:
 os.close(ready_read)
 os.setpgid(0,0)
 signal.signal(signal.SIGHUP,signal.SIG_IGN)
 os.write(ready_write,b'R')
 os.write(1,('CHILD:%d\n'%os.getpid()).encode())
 while True: time.sleep(.1)
os.close(ready_write)
assert os.read(ready_read,1)==b'R'
os.tcsetpgrp(0,child)
os.write(1,('ROOT:%d\n'%os.getpid()).encode())
while True: time.sleep(.1)
"#;

#[test]
fn stop_joins_root_and_same_session_members_in_distinct_process_groups() {
    let mut terminal = Terminal::launch(SESSION_CHILDREN);
    terminal.output_contains(b"CHILD:");
    terminal.capture_session();
    assert!(terminal.identities.len() >= 2);
    terminal.stop();
    assert!(terminal.identities.iter().all(|value| {
        process_session(value.pid).is_none_or(|(_, state)| state == "Z" || state == "X")
    }));
    assert_eq!(terminal.final_count(), terminal.bytes.len() as u64);
}

#[test]
fn caller_control_disconnect_stops_the_original_session_and_joins_broker() {
    let mut terminal = Terminal::launch(SESSION_CHILDREN);
    terminal.output_contains(b"CHILD:");
    terminal.capture_session();
    assert!(terminal.identities.len() >= 2);
    terminal.disconnect();
    assert!(terminal.exit().success());
    assert!(terminal.identities.iter().all(|value| {
        process_session(value.pid).is_none_or(|(_, state)| state == "Z" || state == "X")
    }));
}

#[test]
fn root_exit_is_reported_while_a_same_session_child_keeps_its_terminal_live() {
    let mut terminal = Terminal::launch(
        r#"import os,signal,time
child=os.fork()
if child==0:
 signal.signal(signal.SIGHUP,signal.SIG_IGN)
 os.write(1,('CHILD:%d\n'%os.getpid()).encode())
 while True: time.sleep(.1)
os.write(1,b'ROOT-EXIT\n')
time.sleep(.1)
os._exit(9)
"#,
    );
    terminal.output_contains(b"CHILD:");
    terminal.wait(|value| {
        matches!(
            value,
            Report::State {
                running: false,
                exit: Some(9),
                complete: false,
                ..
            }
        )
    });
    terminal.capture_session();
    terminal.stop();
    assert_eq!(terminal.final_count(), terminal.bytes.len() as u64);
}
