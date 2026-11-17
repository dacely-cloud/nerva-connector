// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Local parent-only inspection of fixed inherited FD4, independent of remote file/command actions.

use crate::private_parent_pipe;
use crate::workspace_identity::{CaptureFailure, WorkspaceIdentity};
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::FromRawFd;

#[derive(Serialize)]
#[serde(untagged)]
enum Response<T> {
    Success { ok: bool, identity: T },
    Failure { ok: bool, error: CaptureFailure },
}

/// Only this exact local selector enters the diagnostic; ordinary helper modes retain their own parser.
pub fn selected() -> bool {
    selected_mode("--inspect-root")
}

/// Fixed local selectors cannot be negotiated through remote operation input.
pub fn selected_mode(mode: &str) -> bool {
    std::env::args_os()
        .nth(1)
        .is_some_and(|value| value == mode)
}

/// Emit one finite private-parent response; no path, JSON action or FD selector can be supplied.
pub fn run() -> i32 {
    run_capture("--inspect-root", WorkspaceIdentity::capture)
}

/// Local identity modes share one bounded private-parent envelope and lifetime boundary.
pub fn run_capture<T: Serialize>(
    mode: &str,
    inspector: fn(&File) -> Result<T, CaptureFailure>,
) -> i32 {
    let response = match capture(mode, inspector) {
        Ok(identity) => Response::Success { ok: true, identity },
        Err(error) => Response::Failure { ok: false, error },
    };
    let success = matches!(response, Response::Success { .. });
    let bytes = match serde_json::to_vec(&response) {
        Ok(bytes) if bytes.len() <= 1024 => bytes,
        _ => return 1,
    };
    let mut output = std::io::stdout().lock();
    if output.write_all(&bytes).is_err() || output.flush().is_err() {
        return 1;
    }
    if success { 0 } else { 1 }
}

fn capture<T>(
    mode: &str,
    inspector: fn(&File) -> Result<T, CaptureFailure>,
) -> Result<T, CaptureFailure> {
    crate::sandbox::parent_lifetime().map_err(|_| CaptureFailure::Unavailable)?;
    let mut arguments = std::env::args_os().skip(1);
    if arguments.next().is_none_or(|value| value != mode) || arguments.next().is_some() {
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
    // SAFETY: Fixed inherited FD4 is borrowed; F_DUPFD_CLOEXEC returns a distinct owned descriptor.
    let descriptor = unsafe { libc::fcntl(4, libc::F_DUPFD_CLOEXEC, 6) };
    if descriptor < 0 {
        return Err(CaptureFailure::Invalid);
    }
    // SAFETY: Successful duplication produced a fresh descriptor owned solely by this File.
    let root = unsafe { File::from_raw_fd(descriptor) };
    inspector(&root)
}
