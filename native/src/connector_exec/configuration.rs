// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Strict local-only bootstrap data, never a remote request or permission inferred from an executable name.

use super::runtime_input::RuntimeInput;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::os::unix::fs::OpenOptionsExt;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceAccess {
    ReadOnly,
    ReadWrite,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configuration {
    #[serde(with = "super::launch_window")]
    pub admission_expires_at_ms: u64,
    pub apparmor_profile: String,
    pub program: String,
    pub arguments: Vec<String>,
    pub input: RuntimeInput,
    pub allowed_executables: Vec<String>,
    pub executable_descriptors: Vec<ExecutableDescriptor>,
    pub workspace_access: WorkspaceAccess,
    pub parent_namespaces: BTreeMap<String, String>,
    pub maximum_cpu_seconds: u64,
    #[serde(with = "decimal")]
    pub maximum_address_bytes: u64,
    #[serde(with = "decimal")]
    pub maximum_file_bytes: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutableDescriptor {
    pub path: String,
    pub descriptor: i32,
}

mod decimal {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value.is_empty()
            || value.len() > 16
            || (value.len() > 1 && value.starts_with('0'))
            || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(serde::de::Error::custom("Invalid exact execution limit"));
        }
        value.parse().map_err(serde::de::Error::custom)
    }
}

pub fn invalid() -> io::Error {
    io::Error::other("Invalid isolated execution configuration")
}

/// Program paths cannot select writable data, procfs, a device or the trampoline itself.
pub fn program_path(path: &str) -> bool {
    path.len() <= 4096
        && (path.starts_with("/usr/") || path.starts_with("/opt/"))
        && path.split('/').skip(1).all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.bytes().any(|value| value <= 32 || value == 127)
        })
}

pub fn load() -> io::Result<Configuration> {
    let file: File = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open("/nerva-execution.json")?;
    read(file)
}

pub(super) fn read(file: File) -> io::Result<Configuration> {
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > super::limits::CONFIGURATION_BYTES as u64 {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take((super::limits::CONFIGURATION_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > super::limits::CONFIGURATION_BYTES {
        return Err(invalid());
    }
    let value: Configuration = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    validate(&value)?;
    Ok(value)
}

pub fn validate(value: &Configuration) -> io::Result<()> {
    value.input.validate()?;
    let profile = value
        .apparmor_profile
        .strip_prefix("nerva-connector-exec-")
        .ok_or_else(invalid)?;
    if profile.len() != 97
        || profile.as_bytes()[32] != b'-'
        || !profile.bytes().enumerate().all(|(index, byte)| {
            index == 32 || byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
        })
    {
        return Err(invalid());
    }
    if !program_path(&value.program)
        || value.allowed_executables.is_empty()
        || value.allowed_executables.len() > 16
        || value.executable_descriptors.len() != value.allowed_executables.len()
        || value
            .executable_descriptors
            .iter()
            .enumerate()
            .any(|(index, entry)| {
                entry.descriptor != (if value.input.pipe() { 9 } else { 8 }) + index as i32
                    || entry.path != value.allowed_executables[index]
            })
        || !value
            .allowed_executables
            .iter()
            .any(|path| path == &value.program)
        || value
            .allowed_executables
            .iter()
            .any(|path| !program_path(path))
        || value.arguments.len() > 32
        || value
            .arguments
            .iter()
            .any(|arg| arg.len() > 4096 || arg.contains('\0'))
        || value.arguments.iter().map(String::len).sum::<usize>() > 8192
        || !(1..=30).contains(&value.maximum_cpu_seconds)
        || !(33554432..=17592186044416).contains(&value.maximum_address_bytes)
        || value.maximum_file_bytes > 16777216
    {
        return Err(invalid());
    }
    if let RuntimeInput::Pipe {
        guardian_profile, ..
    } = &value.input
        && *guardian_profile
            != value
                .apparmor_profile
                .replacen("nerva-connector-exec-", "nerva-connector-guard-", 1)
    {
        return Err(invalid());
    }
    Ok(())
}
