// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Actual command capture consumes only the fixed inherited cgroup FD and private parent channel.

#[path = "support/cgroup_fixture.rs"]
mod cgroup_fixture;

use cgroup_fixture::CgroupFixture;
use serde_json::{Value, json};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Command, Output, Stdio};

fn command(root: Option<&File>) -> Command {
    // Keep the source descriptor away from stdio setup and the fixed child slot.
    let pinned = root.map(|file| {
        // SAFETY: F_DUPFD_CLOEXEC creates a distinct owned copy of this live borrowed capability.
        let descriptor = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 32) };
        assert!(descriptor >= 32);
        // SAFETY: The successful duplicate is owned only by this File.
        unsafe { File::from_raw_fd(descriptor) }
    });
    let mut command = Command::new(env!("CARGO_BIN_EXE_nerva-connector-exec"));
    command
        .arg("--capture-cgroup")
        .env_clear()
        .env("NERVA_CONNECTOR_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // SAFETY: Child descriptor setup uses only async-signal-safe operations; the closure owns the pinned source.
    unsafe {
        command.pre_exec(move || {
            if let Some(file) = &pinned {
                if libc::dup2(file.as_raw_fd(), 4) < 0 || libc::fcntl(4, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            } else {
                libc::close(4);
            }
            Ok(())
        });
    }
    command
}

fn response(output: &Output) -> Value {
    assert!(output.stdout.len() <= 1024);
    assert!(
        output.stderr.is_empty(),
        "Raw native data must never appear on stderr"
    );
    serde_json::from_slice(&output.stdout).expect("Finite exact response required")
}

fn denied(output: Output, error: &str) {
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(response(&output), json!({"ok":false,"error":error}));
}

#[test]
fn actual_cgroup_capture_is_stable_generation_aware_and_liveness_checked() {
    let mut fixture = CgroupFixture::new();
    let original = fixture.open();
    let first = command(Some(&original)).output().unwrap();
    assert!(first.status.success());
    let first = response(&first);
    assert_eq!(first.as_object().unwrap().len(), 2);
    assert_eq!(first["ok"], true);
    let identity = first["identity"].as_object().unwrap();
    assert_eq!(identity.len(), 5);
    assert_eq!(identity["handleType"], 254);
    assert_eq!(identity["handle"].as_str().unwrap().len(), 16);
    let other = command(Some(&fixture.open())).output().unwrap();
    assert!(other.status.success());
    assert_eq!(response(&other), first);
    let (mut reader, writer) = UnixStream::pair().unwrap();
    let status = command(Some(&original))
        .stdout(Stdio::from(OwnedFd::from(writer)))
        .status()
        .unwrap();
    assert!(status.success());
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), first);
    fixture.replace();
    denied(command(Some(&original)).output().unwrap(), "changed");
    let replaced = command(Some(&fixture.open())).output().unwrap();
    assert!(replaced.status.success());
    let replaced = response(&replaced);
    assert_eq!(replaced["identity"]["bootId"], first["identity"]["bootId"]);
    assert_eq!(
        replaced["identity"]["filesystemId"],
        first["identity"]["filesystemId"]
    );
    assert_ne!(replaced["identity"]["handle"], first["identity"]["handle"]);
}

#[test]
fn actual_cgroup_capture_rejects_selectors_payload_and_nonprivate_output() {
    let fixture = CgroupFixture::new();
    let root = fixture.open();
    denied(command(None).output().unwrap(), "invalid");
    denied(
        command(Some(&tempfile::tempfile().unwrap()))
            .output()
            .unwrap(),
        "invalid",
    );
    denied(
        command(Some(&File::open("/proc").unwrap()))
            .output()
            .unwrap(),
        "unsupported",
    );
    for extra in ["--path=/sys/fs/cgroup", "--fd=5", "--capture-cgroup"] {
        denied(command(Some(&root)).arg(extra).output().unwrap(), "invalid");
    }
    denied(
        command(Some(&root))
            .env("NERVA_CONNECTOR_PARENT_PID", "1")
            .output()
            .unwrap(),
        "unavailable",
    );
    let mut child = command(Some(&root)).stdin(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(b"{}").unwrap();
    denied(child.wait_with_output().unwrap(), "invalid");
    let output = tempfile::tempfile().unwrap();
    let mut reader = output.try_clone().unwrap();
    let status = command(Some(&root))
        .stdout(Stdio::from(output))
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(1));
    reader.seek(SeekFrom::Start(0)).unwrap();
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap(),
        json!({"ok":false,"error":"invalid"})
    );
    let file_helper = Command::new(env!("CARGO_BIN_EXE_nerva-connector-files"))
        .arg("--capture-cgroup")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!file_helper.status.success());
    assert!(
        !file_helper
            .stdout
            .windows(8)
            .any(|window| window == b"identity")
    );
}
