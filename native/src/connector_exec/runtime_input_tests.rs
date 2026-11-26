// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

use super::*;
use serde_json::{Value, json};
use std::io::Read;
use std::os::unix::fs::{MetadataExt, symlink};

fn machine() -> Value {
    json!({
        "kind": "machine",
        "cwd": ".",
        "environment": [],
        "stdin": ""
    })
}

fn decode(value: &Value) -> io::Result<RuntimeInput> {
    let input: RuntimeInput = serde_json::from_value(value.clone()).map_err(|_| invalid())?;
    input.validate()?;
    Ok(input)
}

#[test]
fn variants_are_explicit_and_closed_without_missing_field_fallback() {
    assert!(
        decode(&json!({
            "kind": "fixed"
        }))
        .is_ok()
    );
    assert!(decode(&machine()).is_ok());
    for value in [
        json!({}),
        json!({
            "kind": "other"
        }),
        json!({
            "kind": "fixed",
            "cwd": "."
        }),
        json!({
            "kind": "machine",
            "cwd": ".",
            "environment": []
        }),
        json!({
            "kind": "machine",
            "cwd": ".",
            "stdin": ""
        }),
        json!({
            "kind": "machine",
            "environment": [],
            "stdin": ""
        }),
        json!({
            "kind": "machine",
            "cwd": ".",
            "environment": [],
            "stdin": "",
            "terminal": true
        }),
    ] {
        assert!(decode(&value).is_err(), "{value}");
    }
}

#[test]
fn pipe_requires_its_exact_guardian_incarnation_and_captured_limits() {
    let pipe = json!({
        "kind": "pipe",
        "cwd": ".",
        "environment": [],
        "stdin": "",
        "incarnation": "a".repeat(64),
        "guardianProfile": format!("nerva-connector-guard-{}-{}","a".repeat(32),"b".repeat(64)),
        "maximumInputBytes": "0",
        "maximumControls": 1,
        "executionDeadlineMs": "9223372036854775807"
    });
    assert!(decode(&pipe).is_ok());
    for field in [
        "incarnation",
        "guardianProfile",
        "maximumInputBytes",
        "maximumControls",
        "executionDeadlineMs",
    ] {
        let mut missing = pipe.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(decode(&missing).is_err());
    }
    for (field, value) in [
        ("maximumInputBytes", json!("00")),
        ("maximumInputBytes", json!("65537")),
        ("executionDeadlineMs", json!("0")),
        ("executionDeadlineMs", json!("01")),
        ("executionDeadlineMs", json!("9223372036854775808")),
        ("maximumControls", json!(0)),
        ("maximumControls", json!(257)),
        ("stdin", json!("a")),
        ("incarnation", json!("b".repeat(63))),
        ("guardianProfile", json!("nerva-connector-launch-wrong")),
    ] {
        let mut changed = pipe.clone();
        changed[field] = value;
        assert!(decode(&changed).is_err());
    }
}

#[test]
fn cwd_environment_and_initial_input_have_independent_hard_ceilings() {
    for path in [
        "",
        "..",
        "a/../b",
        "/absolute",
        "a//b",
        "a/./b",
        "a\\b",
        "C:drive",
        "a\0b",
        "a\u{0085}b",
    ] {
        let mut value = machine();
        value["cwd"] = json!(path);
        assert!(decode(&value).is_err(), "{path:?}");
    }
    for entries in [
        json!([{"name":"A","value":"x"},{"name":"A","value":"y"}]),
        json!([{"name":"Z","value":"x"},{"name":"A","value":"y"}]),
        json!([{"name":"NERVA_CONNECTOR_PARENT_PID","value":"1"}]),
        json!([{"name":"A","value":"x\0y"}]),
        json!([{"name":"1A","value":"x"}]),
        json!([{"name":"A","value":"x","extra":true}]),
        json!([{"name":"A","value":"x".repeat(1024)}]),
    ] {
        let mut value = machine();
        value["environment"] = entries;
        assert!(decode(&value).is_err());
    }
    let mut value = machine();
    value["stdin"] = json!("x".repeat(1025));
    assert!(decode(&value).is_err());
    value["stdin"] = json!("a\0b");
    assert!(decode(&value).is_ok());
    value["cwd"] = json!("x".repeat(513));
    assert!(decode(&value).is_err());
}

#[test]
fn application_input_is_an_exact_sealed_finite_descriptor() {
    let mut file = sealed_stdin("before\0after\n").unwrap();
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"before\0after\n");
    assert_eq!(file.read(&mut [0u8; 1]).unwrap(), 0);
    assert!(file.write_all(b"replacement").is_err());
    // SAFETY: This read-only descriptor query receives a live owned memfd.
    let seals = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GET_SEALS) };
    assert_eq!(
        seals,
        libc::F_SEAL_WRITE | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_SEAL
    );
    assert!(sealed_stdin(&"x".repeat(1025)).is_err());
}

#[test]
fn cwd_pins_the_actual_directory_and_rejects_links_and_traversal() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path();
    std::fs::create_dir(path.join("nested")).unwrap();
    let root = File::open(path).unwrap();
    let captured = cwd(&root, "nested").unwrap();
    let inode = captured.metadata().unwrap().ino();
    std::fs::rename(path.join("nested"), path.join("old")).unwrap();
    std::fs::create_dir(path.join("nested")).unwrap();
    assert_eq!(captured.metadata().unwrap().ino(), inode);
    assert_ne!(
        cwd(&root, "nested").unwrap().metadata().unwrap().ino(),
        inode
    );
    assert_eq!(
        cwd(&root, ".").unwrap().metadata().unwrap().ino(),
        root.metadata().unwrap().ino()
    );
    symlink("nested", path.join("alias")).unwrap();
    symlink("/tmp", path.join("outside")).unwrap();
    for denied in [
        "alias",
        "outside",
        "../",
        "/tmp",
        "missing",
        "nested/../old",
    ] {
        assert!(cwd(&root, denied).is_err());
    }
}

#[test]
fn explicit_environment_overrides_never_inherit_the_host_environment() {
    let mut value = machine();
    value["environment"] = json!([{"name":"CUSTOM_VALUE","value":"fixture"}]);
    let input = decode(&value).unwrap();
    let mut command = Command::new("/usr/bin/true");
    command.env_clear().env("LANG", "C.UTF-8");
    input.environment(&mut command);
    let values: Vec<_> = command.get_envs().collect();
    assert_eq!(values.len(), 2);
    assert!(
        values.iter().any(|(name, value)| *name == "CUSTOM_VALUE"
            && *value == Some(std::ffi::OsStr::new("fixture")))
    );
    PreparedInput::prepare(&RuntimeInput::Fixed {})
        .unwrap()
        .install()
        .unwrap();
}
