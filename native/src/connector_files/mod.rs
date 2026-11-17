//! Bounded connector file operations under a kernel-enforced, locally selected root and explicit write policy.

mod chmod;
mod confinement;
mod directory;
mod filesystem;
mod mutation;
mod removal;
mod rename;
mod upload;
mod upload_slot;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;

const MAXIMUM_INPUT: u64 = 8192;
pub const MAXIMUM_READ: u32 = 32768;
pub const MAXIMUM_WRITE: u32 = 16384;

/// Only named bounded file operations exist; additional executable or network fields are rejected.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    UploadBegin(upload::Target),
    UploadChunk(upload::Chunk),
    UploadStatus(upload::Target),
    UploadCommit(upload::Target),
    UploadAbort(upload::Target),
    Chmod {
        request_id: String,
        path: String,
        mode: u32,
    },
    Rename {
        request_id: String,
        path: String,
        destination: String,
        mode: WriteMode,
    },
    Mkdir {
        request_id: String,
        path: String,
    },
    Remove {
        request_id: String,
        path: String,
        recursive: bool,
    },
    Write {
        request_id: String,
        path: String,
        mode: WriteMode,
        data_base64: String,
        staging_id: String,
    },
    CleanupWrite {
        staging_id: String,
    },
    Read {
        request_id: String,
        path: String,
        offset: String,
        limit: u32,
    },
    Stat {
        request_id: String,
        path: String,
    },
    List {
        request_id: String,
        path: String,
        cursor: String,
    },
}

/// Only named full-file publication modes exist; callers cannot select rename flags.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WriteMode {
    Create,
    Replace,
}

/// Stable bounded errors contain no host path, private content or native diagnostics.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Failure {
    Invalid,
    Denied,
    Unavailable,
    Changed,
    Indeterminate,
}

/// File types are descriptive metadata, never executable permission grants.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileKind {
    File,
    Directory,
    SymbolicLink,
    Other,
}

/// Exact metadata omits host inode/device/owner identifiers.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub kind: FileKind,
    pub size_bytes: String,
    pub modified_at_ns: String,
    pub mode: u32,
}

/// Listing never follows a directory entry or reads the contents of a special file.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub kind: FileKind,
}

/// Response identity and exact offsets bind caller correlation to the original finite operation.
#[derive(Debug, Serialize)]
#[serde(
    tag = "action",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Output {
    UploadBegin {
        request_id: String,
        upload_id: String,
        received_bytes: String,
    },
    UploadChunk {
        request_id: String,
        upload_id: String,
        received_bytes: String,
    },
    UploadStatus {
        request_id: String,
        upload_id: String,
        received_bytes: String,
        sha256: String,
    },
    UploadCommit {
        request_id: String,
        upload_id: String,
        bytes_written: String,
        sha256: String,
        metadata: Metadata,
    },
    UploadAbort {
        request_id: String,
        upload_id: String,
        removed: bool,
    },
    Chmod {
        request_id: String,
        metadata: Metadata,
    },
    Rename {
        request_id: String,
        metadata: Metadata,
    },
    Mkdir {
        request_id: String,
    },
    Remove {
        request_id: String,
        entries_removed: String,
    },
    Write {
        request_id: String,
        bytes_written: String,
        metadata: Metadata,
    },
    CleanupWrite {
        removed: bool,
    },
    Read {
        request_id: String,
        offset: String,
        data_base64: String,
        metadata: Metadata,
    },
    Stat {
        request_id: String,
        metadata: Metadata,
    },
    List {
        request_id: String,
        entries: Vec<Entry>,
        next_cursor: Option<String>,
        metadata: Metadata,
    },
}

/// JSON has one current discriminated success/failure envelope.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Response {
    Success { ok: bool, result: Output },
    Failure { ok: bool, error: Failure },
}

fn decimal(value: &str) -> Result<u64, Failure> {
    if value.is_empty()
        || value.len() > 19
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(Failure::Invalid);
    }
    let parsed: u64 = value.parse().map_err(|_| Failure::Invalid)?;
    if parsed > i64::MAX as u64 {
        return Err(Failure::Invalid);
    }
    Ok(parsed)
}

fn request_id(value: &str) -> Result<(), Failure> {
    if value.is_empty()
        || value.len() > 128
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
    {
        return Err(Failure::Invalid);
    }
    Ok(())
}

fn operation(
    root: &std::fs::File,
    stage: Option<&std::fs::File>,
    request: Request,
) -> Result<Output, Failure> {
    match request {
        Request::UploadBegin(target) => upload::begin(root, stage.ok_or(Failure::Denied)?, target),
        Request::UploadChunk(chunk) => upload::chunk(root, stage.ok_or(Failure::Denied)?, chunk),
        Request::UploadStatus(target) => {
            upload::status(root, stage.ok_or(Failure::Denied)?, target)
        }
        Request::UploadCommit(target) => {
            upload::commit(root, stage.ok_or(Failure::Denied)?, target)
        }
        Request::UploadAbort(target) => upload::abort(root, stage.ok_or(Failure::Denied)?, target),
        Request::Chmod {
            request_id: id,
            path,
            mode,
        } => {
            request_id(&id)?;
            stage.ok_or(Failure::Denied)?;
            Ok(Output::Chmod {
                request_id: id,
                metadata: chmod::change(root, &path, mode)?,
            })
        }
        Request::Rename {
            request_id: id,
            path,
            destination,
            mode,
        } => {
            request_id(&id)?;
            stage.ok_or(Failure::Denied)?;
            Ok(Output::Rename {
                request_id: id,
                metadata: rename::publish(root, &path, &destination, mode)?,
            })
        }
        Request::Mkdir {
            request_id: id,
            path,
        } => {
            request_id(&id)?;
            stage.ok_or(Failure::Denied)?;
            directory::create(root, &path)?;
            Ok(Output::Mkdir { request_id: id })
        }
        Request::Remove {
            request_id: id,
            path,
            recursive,
        } => {
            request_id(&id)?;
            stage.ok_or(Failure::Denied)?;
            Ok(Output::Remove {
                request_id: id,
                entries_removed: removal::remove(root, &path, recursive)?.to_string(),
            })
        }
        Request::Write {
            request_id: id,
            path,
            mode,
            data_base64,
            staging_id,
        } => {
            request_id(&id)?;
            let stage = stage.ok_or(Failure::Denied)?;
            if data_base64.len() > (MAXIMUM_WRITE as usize).div_ceil(3) * 4 {
                return Err(Failure::Invalid);
            }
            let bytes = STANDARD
                .decode(&data_base64)
                .map_err(|_| Failure::Invalid)?;
            if bytes.len() > MAXIMUM_WRITE as usize || STANDARD.encode(&bytes) != data_base64 {
                return Err(Failure::Invalid);
            }
            let metadata = mutation::write(root, stage, &path, mode, &bytes, &staging_id)?;
            Ok(Output::Write {
                request_id: id,
                bytes_written: bytes.len().to_string(),
                metadata,
            })
        }
        Request::CleanupWrite { staging_id } => Ok(Output::CleanupWrite {
            removed: mutation::cleanup(stage.ok_or(Failure::Denied)?, &staging_id)?,
        }),
        Request::Read {
            request_id: id,
            path,
            offset,
            limit,
        } => {
            request_id(&id)?;
            if limit == 0 || limit > MAXIMUM_READ {
                return Err(Failure::Invalid);
            }
            let position: u64 = decimal(&offset)?;
            let (bytes, metadata): (Vec<u8>, Metadata) =
                filesystem::read(root, &path, position, limit)?;
            Ok(Output::Read {
                request_id: id,
                offset,
                data_base64: STANDARD.encode(bytes),
                metadata,
            })
        }
        Request::Stat {
            request_id: id,
            path,
        } => {
            request_id(&id)?;
            Ok(Output::Stat {
                request_id: id,
                metadata: filesystem::stat(root, &path)?,
            })
        }
        Request::List {
            request_id: id,
            path,
            cursor,
        } => {
            request_id(&id)?;
            let (entries, next_cursor, metadata) =
                filesystem::list(root, &path, decimal(&cursor)?)?;
            Ok(Output::List {
                request_id: id,
                entries,
                next_cursor,
                metadata,
            })
        }
    }
}

/// Open the trusted local root and install restrictions before accepting any external JSON.
pub fn run() -> Result<(), Failure> {
    crate::sandbox::parent_lifetime().map_err(|_| Failure::Unavailable)?;
    let effect = crate::file_effect::read_context()?;
    // SAFETY: This single-process helper sets only its own creation mask before confinement or untrusted input; fixed 0600/0700 modes remain exact.
    unsafe { libc::umask(0o077) };
    let directory: std::fs::File = filesystem::root()?;
    let writable = match std::env::var("NERVA_CONNECTOR_FILE_MODE").as_deref() {
        Ok("read-only") => false,
        Ok("read-write") => true,
        _ => return Err(Failure::Unavailable),
    };
    let stage = if writable {
        Some(filesystem::root_at(5)?)
    } else {
        None
    };
    if let Some(stage) = &stage {
        let main = filesystem::raw(&directory)?;
        let buffer = filesystem::raw(stage)?;
        // SAFETY: getuid has no arguments and returns this helper's real operating-system identity.
        let owner = unsafe { libc::getuid() };
        if main.st_dev != buffer.st_dev
            || main.st_ino == buffer.st_ino
            || buffer.st_mode & 0o077 != 0
            || buffer.st_uid != owner
        {
            return Err(Failure::Denied);
        }
    }
    crate::file_effect::verify(effect.as_ref(), &directory, stage.as_ref())?;
    confinement::install(
        directory.as_raw_fd(),
        stage.as_ref().map(AsRawFd::as_raw_fd),
    )?;
    let mut input: Vec<u8> = Vec::new();
    let response: Response = match std::io::stdin()
        .take(if writable { 131073 } else { MAXIMUM_INPUT + 1 })
        .read_to_end(&mut input)
    {
        Ok(_)
            if input.len()
                <= if writable {
                    131072
                } else {
                    MAXIMUM_INPUT as usize
                } =>
        {
            match serde_json::from_slice::<Request>(&input)
                .map_err(|_| Failure::Invalid)
                .and_then(|request: Request| operation(&directory, stage.as_ref(), request))
            {
                Ok(result) => Response::Success { ok: true, result },
                Err(error) => Response::Failure { ok: false, error },
            }
        }
        _ => Response::Failure {
            ok: false,
            error: Failure::Invalid,
        },
    };
    let output: Vec<u8> = serde_json::to_vec(&response).map_err(|_| Failure::Unavailable)?;
    if output.len() > 65536 {
        return Err(Failure::Unavailable);
    }
    std::io::stdout()
        .write_all(&output)
        .map_err(|_| Failure::Unavailable)
}

/// Startup failures also use the finite safe error envelope rather than raw OS diagnostics.
pub fn failure(error: Failure) {
    if let Ok(output) = serde_json::to_vec(&Response::Failure { ok: false, error }) {
        let _ = std::io::stdout().write_all(&output);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::os::unix::fs::MetadataExt;

    #[test]
    fn mutations_require_explicit_writable_admission_and_reject_unrecognized_authority() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("source"), b"preserved").unwrap();
        let root = File::open(directory.path()).unwrap();
        let original = std::fs::metadata(directory.path().join("source"))
            .unwrap()
            .mode();
        for encoded in [
            r#"{"action":"chmod","requestId":"mode","path":"source","mode":448}"#,
            r#"{"action":"rename","requestId":"move","path":"source","destination":"new","mode":"create"}"#,
        ] {
            let request: Request = serde_json::from_str(encoded).unwrap();
            assert!(matches!(
                operation(&root, None, request),
                Err(Failure::Denied)
            ));
        }
        for action in [
            "upload-begin",
            "upload-chunk",
            "upload-status",
            "upload-commit",
            "upload-abort",
        ] {
            let mut payload = serde_json::json!({
                "action": action,
                "requestId": "upload",
                "path": "destination",
                "uploadId": "a".repeat(64),
                "bindingSha256": "b".repeat(64),
                "mode": "create",
                "sizeBytes": "1",
                "sha256": "c".repeat(64)
            });
            if action == "upload-chunk" {
                payload["offset"] = serde_json::json!("0");
                payload["dataBase64"] = serde_json::json!("eA==");
            }
            let request: Request = serde_json::from_value(payload.clone()).unwrap();
            assert!(matches!(
                operation(&root, None, request),
                Err(Failure::Denied)
            ));
            payload["ambientRoot"] = serde_json::json!("/outside");
            assert!(serde_json::from_value::<Request>(payload).is_err());
        }
        for encoded in [
            r#"{"action":"chmod","requestId":"mode","path":"source","mode":"0600"}"#,
            r#"{"action":"chmod","requestId":"mode","path":"source","mode":384,"rootId":"other"}"#,
            r#"{"action":"rename","requestId":"move","path":"source","destination":"new","mode":"create","destinationRoot":"other"}"#,
            r#"{"action":"rename","requestId":"move","path":"source","destination":"new","mode":"replace-any"}"#,
        ] {
            assert!(serde_json::from_str::<Request>(encoded).is_err());
        }
        assert_eq!(
            std::fs::metadata(directory.path().join("source"))
                .unwrap()
                .mode(),
            original
        );
        assert_eq!(
            std::fs::read(directory.path().join("source")).unwrap(),
            b"preserved"
        );
        assert!(!directory.path().join("new").exists());
    }
}
