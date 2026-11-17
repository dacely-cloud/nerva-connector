// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Physical effect context is private trusted bootstrap, independent of remote operation input.

use crate::connector_files::Failure;
use crate::private_parent_pipe;
use crate::workspace_identity::{CaptureFailure, WorkspaceIdentity};
use serde::{Deserialize, Deserializer, Serialize};
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::FromRawFd;

const MAXIMUM_CONTEXT: usize = 4096;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FileEffectContext {
    root: WorkspaceIdentity,
    #[serde(deserialize_with = "required_staging")]
    staging: Option<WorkspaceIdentity>,
}

fn required_staging<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<WorkspaceIdentity>, D::Error> {
    Option::<WorkspaceIdentity>::deserialize(deserializer)
}

#[derive(Serialize)]
#[serde(untagged)]
enum CaptureResponse {
    Success {
        ok: bool,
        #[serde(flatten)]
        context: Box<FileEffectContext>,
    },
    Failure {
        ok: bool,
        error: CaptureFailure,
    },
}

/// Only one exact local argv selector enters capture; extra arguments are rejected by the mode itself.
pub fn capture_selected() -> bool {
    std::env::args_os()
        .nth(1)
        .is_some_and(|value| value == "--capture-file-effect")
}

/// Capture only inherited FD4 and optional FD5; raw identities never leave the private parent pipe.
pub fn capture() -> i32 {
    let response = match capture_context() {
        Ok(context) => CaptureResponse::Success {
            ok: true,
            context: Box::new(context),
        },
        Err(error) => CaptureResponse::Failure { ok: false, error },
    };
    let success = matches!(response, CaptureResponse::Success { .. });
    let output = match serde_json::to_vec(&response) {
        Ok(output) if output.len() <= MAXIMUM_CONTEXT => output,
        _ => return 1,
    };
    let mut parent = std::io::stdout().lock();
    if parent.write_all(&output).is_err() || parent.flush().is_err() {
        return 1;
    }
    if success { 0 } else { 1 }
}

fn capture_context() -> Result<FileEffectContext, CaptureFailure> {
    crate::sandbox::parent_lifetime().map_err(|_| CaptureFailure::Unavailable)?;
    let mut arguments = std::env::args_os().skip(1);
    if arguments
        .next()
        .is_none_or(|value| value != "--capture-file-effect")
        || arguments.next().is_some()
        || std::env::var_os("NERVA_CONNECTOR_FILE_EFFECT").is_some()
        || present(6)?
    {
        return Err(CaptureFailure::Invalid);
    }
    private_parent_pipe::validate(1, libc::O_WRONLY)?;
    let mut input = [0u8; 1];
    if std::io::stdin()
        .read(&mut input)
        .map_err(|_| CaptureFailure::Unavailable)?
        != 0
    {
        return Err(CaptureFailure::Invalid);
    }
    let staging = if present(5)? {
        Some(WorkspaceIdentity::capture(&duplicate(5)?)?)
    } else {
        None
    };
    let root = WorkspaceIdentity::capture(&duplicate(4)?)?;
    Ok(FileEffectContext { root, staging })
}

/// Read and close FD6 before any root duplication could reuse its numeric slot.
pub fn read_context() -> Result<Option<FileEffectContext>, Failure> {
    match std::env::var_os("NERVA_CONNECTOR_FILE_EFFECT") {
        None => {
            if present(6).map_err(file_failure)? {
                return Err(Failure::Invalid);
            }
            Ok(None)
        }
        Some(value) if value == "required" => {
            private_parent_pipe::validate(6, libc::O_RDONLY)
                .map_err(|error| file_failure(error.into()))?;
            // SAFETY: This selected mode takes ownership exactly once of the validated inherited context pipe.
            let input = unsafe { File::from_raw_fd(6) };
            let mut bytes = Vec::new();
            input
                .take((MAXIMUM_CONTEXT + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| Failure::Unavailable)?;
            if bytes.len() > MAXIMUM_CONTEXT {
                return Err(Failure::Invalid);
            }
            serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| Failure::Invalid)
        }
        _ => Err(Failure::Invalid),
    }
}

/// Compare the same owned descriptors that will be confined and used; no pathname is reopened.
pub fn verify(
    context: Option<&FileEffectContext>,
    root: &File,
    staging: Option<&File>,
) -> Result<(), Failure> {
    let Some(context) = context else {
        return Ok(());
    };
    if context.staging.is_some() != staging.is_some() {
        return Err(Failure::Invalid);
    }
    if WorkspaceIdentity::capture(root).map_err(file_failure)? != context.root {
        return Err(Failure::Changed);
    }
    if let (Some(expected), Some(staging)) = (&context.staging, staging)
        && WorkspaceIdentity::capture(staging).map_err(file_failure)? != *expected
    {
        return Err(Failure::Changed);
    }
    Ok(())
}

fn file_failure(error: CaptureFailure) -> Failure {
    match error {
        CaptureFailure::Invalid => Failure::Invalid,
        CaptureFailure::Changed => Failure::Changed,
        CaptureFailure::Unavailable | CaptureFailure::Unsupported => Failure::Unavailable,
    }
}

fn present(descriptor: i32) -> Result<bool, CaptureFailure> {
    // SAFETY: F_GETFD only inspects the fixed inherited descriptor; it opens no ambient path.
    if unsafe { libc::fcntl(descriptor, libc::F_GETFD) } >= 0 {
        return Ok(true);
    }
    if std::io::Error::last_os_error().raw_os_error() == Some(libc::EBADF) {
        Ok(false)
    } else {
        Err(CaptureFailure::Unavailable)
    }
}

fn duplicate(descriptor: i32) -> Result<File, CaptureFailure> {
    // SAFETY: Duplicating above all fixed bootstrap FDs preserves absent FD5/FD6 detection and caller ownership.
    let copied = unsafe { libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, 7) };
    if copied < 0 {
        return Err(CaptureFailure::Invalid);
    }
    // SAFETY: Successful F_DUPFD_CLOEXEC returns one new descriptor owned solely by this File.
    Ok(unsafe { File::from_raw_fd(copied) })
}
