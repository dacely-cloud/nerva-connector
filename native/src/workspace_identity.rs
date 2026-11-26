// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Strict raw identity codec is private local bootstrap data, never a permission or public grant.

use crate::opened_root_identity::{RootIdentityFailure, inspect};
use crate::private_parent_pipe::PipeFailure;
use serde::{Deserialize, Serialize};
use std::fs::File;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureFailure {
    Unsupported,
    Changed,
    Unavailable,
    Invalid,
}

impl From<RootIdentityFailure> for CaptureFailure {
    fn from(value: RootIdentityFailure) -> Self {
        match value {
            RootIdentityFailure::NotDirectory => Self::Invalid,
            RootIdentityFailure::Unlinked | RootIdentityFailure::Changed => Self::Changed,
            RootIdentityFailure::UnsupportedFilesystem | RootIdentityFailure::UnsupportedHandle => {
                Self::Unsupported
            }
            RootIdentityFailure::LayoutUnavailable
            | RootIdentityFailure::FilesystemUnavailable
            | RootIdentityFailure::UuidUnavailable
            | RootIdentityFailure::HandleUnavailable => Self::Unavailable,
        }
    }
}

impl From<PipeFailure> for CaptureFailure {
    fn from(value: PipeFailure) -> Self {
        match value {
            PipeFailure::Invalid => Self::Invalid,
            PipeFailure::Unavailable => Self::Unavailable,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityInput {
    filesystem_uuid: String,
    device: String,
    inode: String,
    handle_type: i32,
    handle: String,
}

/// Comparison retains the complete generation-bearing handle and exact unsigned 64-bit quantities.
#[derive(Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", try_from = "IdentityInput")]
pub struct WorkspaceIdentity {
    filesystem_uuid: String,
    device: String,
    inode: String,
    handle_type: i32,
    handle: String,
}

impl TryFrom<IdentityInput> for WorkspaceIdentity {
    type Error = &'static str;
    fn try_from(value: IdentityInput) -> Result<Self, Self::Error> {
        if !hexadecimal(&value.filesystem_uuid, 32)
            || value.filesystem_uuid.bytes().all(|byte| byte == b'0')
            || !decimal(&value.device)
            || !decimal(&value.inode)
            || value.handle_type != 1
            || !hexadecimal(&value.handle, 16)
        {
            return Err("Invalid private workspace identity");
        }
        Ok(Self {
            filesystem_uuid: value.filesystem_uuid,
            device: value.device,
            inode: value.inode,
            handle_type: value.handle_type,
            handle: value.handle,
        })
    }
}

impl WorkspaceIdentity {
    /// The borrowed capability remains owned by the caller throughout this read-only kernel capture.
    pub fn capture(root: &File) -> Result<Self, CaptureFailure> {
        let identity = inspect(root)?;
        Ok(Self {
            filesystem_uuid: hex(&identity.filesystem_uuid),
            device: identity.device.to_string(),
            inode: identity.inode.to_string(),
            handle_type: identity.handle_type,
            handle: hex(&identity.handle),
        })
    }
}

pub(crate) fn decimal(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 20
        && (value.len() == 1 || !value.starts_with('0'))
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<u64>().is_ok()
}

pub(crate) fn hexadecimal(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(char::from(DIGITS[usize::from(byte >> 4)]));
        result.push(char::from(DIGITS[usize::from(byte & 15)]));
    }
    result
}
