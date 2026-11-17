// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Actual file helper capture/effects use private fixed descriptors, never remote path or identity selectors.

use serde_json::{Value, json};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::{UnixDatagram, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

fn pin(source: &impl AsRawFd) -> File {
    // SAFETY: Duplication retains a new owned descriptor above every fixed child bootstrap target.
    let descriptor = unsafe { libc::fcntl(source.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 16) };
    assert!(descriptor >= 16);
    // SAFETY: The successful duplication returns a new descriptor owned only by this File.
    unsafe { File::from_raw_fd(descriptor) }
}

fn context_pipe(bytes: &[u8]) -> OwnedFd {
    let (mut parent, child) = UnixStream::pair().unwrap();
    parent.write_all(bytes).unwrap();
    parent.shutdown(std::net::Shutdown::Write).unwrap();
    child.into()
}

fn command(root: &File, staging: Option<&File>, context: Option<OwnedFd>) -> Command {
    let helper = File::open(env!("CARGO_BIN_EXE_nerva-connector-files")).unwrap();
    let helper = pin(&helper);
    let root = pin(root);
    let staging = staging.map(pin);
    let context = context.map(|context| pin(&context));
    let mut child = Command::new("/proc/self/fd/3");
    child
        .env_clear()
        .env("NERVA_CONNECTOR_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // SAFETY: Only async-signal-safe dup/close operations run after fork; pinned sources cannot alias targets.
    unsafe {
        child.pre_exec(move || {
            for (target, source) in [
                (3, Some(&helper)),
                (4, Some(&root)),
                (5, staging.as_ref()),
                (6, context.as_ref()),
            ] {
                if let Some(source) = source {
                    if libc::dup2(source.as_raw_fd(), target) < 0
                        || libc::fcntl(target, libc::F_SETFD, 0) < 0
                    {
                        return Err(std::io::Error::last_os_error());
                    }
                } else {
                    libc::close(target);
                }
            }
            Ok(())
        });
    }
    child
}

fn decoded(output: &Output) -> Value {
    assert!(output.stdout.len() <= 4096);
    assert!(
        output.stderr.is_empty(),
        "Private helper errors must never contain native diagnostics"
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn denied(output: Output, code: &str) {
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        decoded(&output),
        json!({
            "ok": false,
            "error": code
        })
    );
}

fn fake_identity() -> Value {
    json!({
        "filesystemUuid": "1".repeat(32),
        "device": "1",
        "inode": "1",
        "handleType": 1,
        "handle": "0".repeat(16)
    })
}

fn operation(
    root: &File,
    staging: Option<&File>,
    context: Option<OwnedFd>,
    required: bool,
    payload: Value,
) -> Output {
    let mut command = command(root, staging, context);
    command.env(
        "NERVA_CONNECTOR_FILE_MODE",
        if staging.is_some() {
            "read-write"
        } else {
            "read-only"
        },
    );
    if required {
        command.env("NERVA_CONNECTOR_FILE_EFFECT", "required");
    }
    invoke(command, payload)
}

fn invoke(mut command: Command, payload: Value) -> Output {
    let mut child = command.stdin(Stdio::piped()).spawn().unwrap();
    let input = serde_json::to_vec(&payload).unwrap();
    // A rejected bootstrap may close stdin before the otherwise-valid operation is delivered.
    let _ = child.stdin.take().unwrap().write_all(&input);
    child.wait_with_output().unwrap()
}

#[test]
fn malformed_or_ambient_effect_context_never_becomes_an_unbound_request() {
    let root = File::open("/proc").unwrap();
    let request = json!({
        "action": "stat",
        "requestId": "probe",
        "path": "."
    });
    denied(
        operation(&root, None, None, true, request.clone()),
        "unavailable",
    );
    let valid = json!({
        "root": fake_identity(),
        "staging": null
    });
    denied(
        operation(
            &root,
            None,
            Some(context_pipe(&serde_json::to_vec(&valid).unwrap())),
            false,
            request.clone(),
        ),
        "invalid",
    );
    let mut malformed = vec![
        json!({
            "root": fake_identity()
        }),
        json!({
            "root": fake_identity(),
            "staging": null,
            "path": "/ignored"
        }),
        Value::Null,
    ];
    for (field, value) in [
        ("device", json!("01")),
        ("inode", json!("18446744073709551616")),
        ("handleType", json!(2)),
        ("handle", json!("A".repeat(16))),
        ("filesystemUuid", json!("0".repeat(32))),
        ("unexpected", json!("/not-a-root-selector")),
    ] {
        let mut context = valid.clone();
        context["root"][field] = value;
        malformed.push(context);
    }
    for context in malformed {
        denied(
            operation(
                &root,
                None,
                Some(context_pipe(&serde_json::to_vec(&context).unwrap())),
                true,
                request.clone(),
            ),
            "invalid",
        );
    }
    denied(
        operation(
            &root,
            None,
            Some(context_pipe(&vec![b' '; 4097])),
            true,
            request.clone(),
        ),
        "invalid",
    );
    let mut regular = tempfile::tempfile().unwrap();
    regular
        .write_all(&serde_json::to_vec(&valid).unwrap())
        .unwrap();
    regular.seek(SeekFrom::Start(0)).unwrap();
    denied(
        operation(&root, None, Some(regular.into()), true, request),
        "invalid",
    );
    denied(
        command(&root, None, None)
            .env("NERVA_CONNECTOR_FILE_EFFECT", "optional")
            .output()
            .unwrap(),
        "invalid",
    );
    let mut descriptors = [-1; 2];
    // SAFETY: pipe2 initializes exactly two new descriptors in this owned output array.
    let created = unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) };
    assert_eq!(created, 0);
    // SAFETY: Successful pipe2 returned these distinct owned read/write ends exactly once.
    let (_read, write) = unsafe {
        (
            OwnedFd::from_raw_fd(descriptors[0]),
            OwnedFd::from_raw_fd(descriptors[1]),
        )
    };
    denied(
        operation(
            &root,
            None,
            Some(write),
            true,
            json!({
                "action": "stat",
                "requestId": "probe",
                "path": "."
            }),
        ),
        "invalid",
    );
    let (parent, child) = UnixDatagram::pair().unwrap();
    parent.send(b"{}").unwrap();
    denied(
        operation(
            &root,
            None,
            Some(child.into()),
            true,
            json!({
                "action": "stat",
                "requestId": "probe",
                "path": "."
            }),
        ),
        "invalid",
    );
}

#[test]
fn local_capture_rejects_unsupported_roots_input_and_non_private_output() {
    let root = File::open("/proc").unwrap();
    denied(
        command(&root, None, None)
            .arg("--capture-file-effect")
            .output()
            .unwrap(),
        "unsupported",
    );
    denied(
        command(&root, None, None)
            .args(["--capture-file-effect", "--root=4"])
            .output()
            .unwrap(),
        "invalid",
    );
    denied(
        command(&root, None, None)
            .arg("--capture-file-effect")
            .env("NERVA_CONNECTOR_FILE_EFFECT", "required")
            .output()
            .unwrap(),
        "invalid",
    );
    denied(
        command(&root, None, Some(context_pipe(b"{}")))
            .arg("--capture-file-effect")
            .output()
            .unwrap(),
        "invalid",
    );
    let output = tempfile::tempfile().unwrap();
    let mut read = output.try_clone().unwrap();
    let status = command(&root, None, None)
        .arg("--capture-file-effect")
        .stdout(Stdio::from(output))
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(1));
    read.seek(SeekFrom::Start(0)).unwrap();
    let mut bytes = Vec::new();
    read.read_to_end(&mut bytes).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap(),
        json!({
            "ok": false,
            "error": "invalid"
        })
    );
    let mut child = command(&root, None, None)
        .arg("--capture-file-effect")
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"{}").unwrap();
    denied(child.wait_with_output().unwrap(), "invalid");
}

fn captured(root: &File, staging: Option<&File>) -> Value {
    let output = command(root, staging, None)
        .arg("--capture-file-effect")
        .output()
        .unwrap();
    assert!(output.status.success());
    let value = decoded(&output);
    assert_eq!(value.as_object().unwrap().len(), 3);
    assert_eq!(value["ok"], true);
    json!({
        "root": value["root"],
        "staging": value["staging"]
    })
}

fn write_request() -> Value {
    json!({
        "action": "write",
        "requestId": "effect",
        "path": "published",
        "mode": "create",
        "dataBase64": "aGVsbG8=",
        "stagingId": "a".repeat(64)
    })
}

#[test]
#[ignore = "requires the owned ext4 fixture for actual generation-bearing root and stage checks"]
fn bound_native_write_reuses_only_exact_captured_root_and_staging_descriptors() {
    let parent = PathBuf::from(std::env::var_os("NERVA_ROOT_IDENTITY_TEST_PARENT").unwrap());
    let owned = tempfile::tempdir_in(parent).unwrap();
    let path = owned.path().join("workspace");
    let stage_path = owned.path().join("stage");
    std::fs::create_dir(&path).unwrap();
    std::fs::create_dir(&stage_path).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&stage_path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let root = File::open(&path).unwrap();
    let stage = File::open(&stage_path).unwrap();
    let context = captured(&root, Some(&stage));
    let readonly = captured(&root, None);
    let bytes = serde_json::to_vec(&context).unwrap();
    let ro = serde_json::to_vec(&readonly).unwrap();
    assert!(readonly["staging"].is_null());
    let stat = operation(
        &root,
        None,
        Some(context_pipe(&ro)),
        true,
        json!({
            "action": "stat",
            "requestId": "probe",
            "path": "."
        }),
    );
    assert!(stat.status.success());
    assert_eq!(decoded(&stat)["ok"], true);
    let ignored = File::open("/dev/null").unwrap();
    let mut readonly_command = command(&root, Some(&ignored), Some(context_pipe(&ro)));
    readonly_command
        .env("NERVA_CONNECTOR_FILE_MODE", "read-only")
        .env("NERVA_CONNECTOR_FILE_EFFECT", "required");
    let stat = invoke(
        readonly_command,
        json!({
            "action": "stat",
            "requestId": "probe",
            "path": "."
        }),
    );
    assert!(stat.status.success());
    assert_eq!(decoded(&stat)["ok"], true);
    denied(
        operation(
            &root,
            None,
            Some(context_pipe(&bytes)),
            true,
            json!({
                "action": "stat",
                "requestId": "probe",
                "path": "."
            }),
        ),
        "invalid",
    );
    denied(
        operation(
            &root,
            Some(&stage),
            Some(context_pipe(&ro)),
            true,
            write_request(),
        ),
        "invalid",
    );
    let mut changed_generation = context.clone();
    let handle = changed_generation["root"]["handle"]
        .as_str()
        .unwrap()
        .to_owned();
    changed_generation["root"]["handle"] = json!(format!(
        "{}{}",
        &handle[..15],
        if handle.ends_with('0') { '1' } else { '0' }
    ));
    denied(
        operation(
            &root,
            Some(&stage),
            Some(context_pipe(
                &serde_json::to_vec(&changed_generation).unwrap(),
            )),
            true,
            write_request(),
        ),
        "changed",
    );
    std::fs::rename(&path, owned.path().join("old-workspace")).unwrap();
    std::fs::create_dir(&path).unwrap();
    let replacement = File::open(&path).unwrap();
    denied(
        operation(
            &replacement,
            Some(&stage),
            Some(context_pipe(&bytes)),
            true,
            write_request(),
        ),
        "changed",
    );
    std::fs::rename(&stage_path, owned.path().join("old-stage")).unwrap();
    std::fs::create_dir(&stage_path).unwrap();
    std::fs::set_permissions(&stage_path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let new_stage = File::open(&stage_path).unwrap();
    denied(
        operation(
            &root,
            Some(&new_stage),
            Some(context_pipe(&bytes)),
            true,
            write_request(),
        ),
        "changed",
    );
    assert!(!owned.path().join("old-workspace/published").exists());
    assert!(!path.join("published").exists());
    assert_eq!(std::fs::read_dir(&stage_path).unwrap().count(), 0);
    let output = operation(
        &root,
        Some(&stage),
        Some(context_pipe(&bytes)),
        true,
        write_request(),
    );
    assert!(output.status.success());
    assert_eq!(decoded(&output)["ok"], true);
    assert_eq!(
        std::fs::read(owned.path().join("old-workspace/published")).unwrap(),
        b"hello"
    );
    assert!(!path.join("published").exists());
    assert_eq!(
        std::fs::read_dir(owned.path().join("old-stage"))
            .unwrap()
            .count(),
        0
    );
}
