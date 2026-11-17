// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Both actual helpers consume only a fixed pinned descriptor and emit private bounded diagnostics.

#[path = "../src/opened_root_identity.rs"]
mod opened_root_identity;

use opened_root_identity::{OpenedRootIdentity, inspect};
use serde_json::{Value, json};
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

fn helpers() -> [&'static str; 2] {
    [
        env!("CARGO_BIN_EXE_nerva-connector-files"),
        env!("CARGO_BIN_EXE_nerva-connector-exec"),
    ]
}

fn command(helper: &str, root: Option<&File>) -> Command {
    let mut command = Command::new(helper);
    command
        .arg("--inspect-root")
        .env_clear()
        .env("NERVA_CONNECTOR_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let descriptor = root.map(AsRawFd::as_raw_fd);
    // SAFETY: The pre-exec child uses only async-signal-safe descriptor operations; parent retains root.
    unsafe {
        command.pre_exec(move || {
            if let Some(descriptor) = descriptor {
                if libc::dup2(descriptor, 4) < 0 || libc::fcntl(4, libc::F_SETFD, 0) < 0 {
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
        "No raw native diagnostics may escape on stderr"
    );
    serde_json::from_slice(&output.stdout).expect("Exact finite JSON diagnostic required")
}

fn denied(output: Output, error: &str) {
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(response(&output), json!({"ok":false,"error":error}));
}

#[test]
fn both_helpers_reject_selectors_input_and_invalid_authority_without_fallback() {
    let proc = File::open("/proc").unwrap();
    let regular = tempfile::tempfile().unwrap();
    for helper in helpers() {
        denied(
            command(helper, Some(&proc)).output().unwrap(),
            "unsupported",
        );
        denied(command(helper, None).output().unwrap(), "invalid");
        denied(command(helper, Some(&regular)).output().unwrap(), "invalid");
        denied(
            command(helper, Some(&proc))
                .arg("--path=/workspace")
                .output()
                .unwrap(),
            "invalid",
        );
        denied(
            command(helper, Some(&proc))
                .arg("--inspect-root")
                .output()
                .unwrap(),
            "invalid",
        );
        denied(
            command(helper, Some(&proc))
                .env("NERVA_CONNECTOR_PARENT_PID", "1")
                .output()
                .unwrap(),
            "unavailable",
        );
        denied(
            command(helper, Some(&proc))
                .env_remove("NERVA_CONNECTOR_PARENT_PID")
                .output()
                .unwrap(),
            "unavailable",
        );
        let mut child = command(helper, Some(&proc))
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"{\"fd\":5,\"action\":\"write\"}")
            .unwrap();
        denied(child.wait_with_output().unwrap(), "invalid");
    }
}

#[test]
fn output_files_never_receive_raw_root_material() {
    let root = File::open("/root").unwrap();
    for helper in helpers() {
        let output = tempfile::tempfile().unwrap();
        let mut reader = output.try_clone().unwrap();
        let status = command(helper, Some(&root))
            .stdout(Stdio::from(output))
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(1));
        use std::io::{Seek, SeekFrom};
        reader.seek(SeekFrom::Start(0)).unwrap();
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap(),
            json!({"ok":false,"error":"invalid"})
        );
    }
}

fn expected(identity: &OpenedRootIdentity) -> Value {
    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|value| format!("{value:02x}")).collect()
    }
    json!({"ok":true,"identity":{
        "filesystemUuid":hex(&identity.filesystem_uuid),
        "device":identity.device.to_string(),"inode":identity.inode.to_string(),
        "handleType":1,"handle":hex(&identity.handle),
    }})
}

#[test]
#[ignore = "requires owned ext4 fixture and both current source-built helpers"]
fn actual_helpers_agree_on_the_opened_root_across_pipe_socket_and_replacement() {
    let parent = PathBuf::from(std::env::var_os("NERVA_ROOT_IDENTITY_TEST_PARENT").unwrap());
    let owned = tempfile::tempdir_in(parent).unwrap();
    let path = owned.path().join("workspace");
    let renamed = owned.path().join("renamed");
    std::fs::create_dir(&path).unwrap();
    let root = File::open(&path).unwrap();
    let identity = inspect(&root).unwrap();
    let expected = expected(&identity);
    for helper in helpers() {
        let output = command(helper, Some(&root)).output().unwrap();
        assert!(output.status.success());
        assert_eq!(response(&output), expected);
        let (mut parent, child) = UnixStream::pair().unwrap();
        let status = command(helper, Some(&root))
            .stdout(Stdio::from(OwnedFd::from(child)))
            .status()
            .unwrap();
        assert!(status.success());
        let mut bytes = Vec::new();
        parent.read_to_end(&mut bytes).unwrap();
        assert!(bytes.len() <= 1024);
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), expected);
    }
    std::fs::rename(&path, &renamed).unwrap();
    std::fs::create_dir(&path).unwrap();
    let replacement = File::open(&path).unwrap();
    for helper in helpers() {
        assert_eq!(
            response(&command(helper, Some(&root)).output().unwrap()),
            expected
        );
        assert_ne!(
            response(&command(helper, Some(&replacement)).output().unwrap()),
            expected
        );
    }
    std::fs::remove_dir(&renamed).unwrap();
    for helper in helpers() {
        denied(command(helper, Some(&root)).output().unwrap(), "changed");
    }
}
