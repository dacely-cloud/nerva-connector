// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Finite application input and descriptor-pinned cwd are prepared before irreversible confinement.

use super::configuration::invalid;
use serde::{Deserialize, Serialize};
use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io::{self, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::process::Command;

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum RuntimeInput {
    Fixed {},
    Machine {
        cwd: String,
        environment: Vec<EnvironmentValue>,
        stdin: String,
    },
    Pipe {
        cwd: String,
        environment: Vec<EnvironmentValue>,
        stdin: String,
        incarnation: String,
        #[serde(rename = "executionDeadlineMs", with = "super::launch_window")]
        execution_deadline_ms: u64,
        #[serde(rename = "guardianProfile")]
        guardian_profile: String,
        #[serde(rename = "maximumInputBytes")]
        maximum_input_bytes: String,
        #[serde(rename = "maximumControls")]
        maximum_controls: u64,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentValue {
    pub name: String,
    pub value: String,
}

impl RuntimeInput {
    /// These independent hard ceilings cannot be expanded by a malformed local bootstrap.
    pub fn validate(&self) -> io::Result<()> {
        if let Self::Machine {
            cwd,
            environment,
            stdin,
        }
        | Self::Pipe {
            cwd,
            environment,
            stdin,
            ..
        } = self
        {
            if !relative_cwd(cwd) || environment.len() > 16 || stdin.len() > 1024 {
                return Err(invalid());
            }
            let mut previous: Option<&str> = None;
            let mut bytes = 0usize;
            for entry in environment {
                if !environment_name(&entry.name)
                    || entry.value.contains('\0')
                    || previous.is_some_and(|value| value >= entry.name.as_str())
                {
                    return Err(invalid());
                }
                bytes += entry.name.len() + entry.value.len();
                previous = Some(&entry.name);
            }
            if bytes > 1024 {
                return Err(invalid());
            }
        }
        if let Self::Pipe {
            incarnation,
            guardian_profile,
            ..
        } = self
            && (!super::pipe_protocol::hash(incarnation)
                || guardian_profile.len() != "nerva-connector-guard-".len() + 97
                || !guardian_profile.starts_with("nerva-connector-guard-"))
        {
            return Err(invalid());
        }
        if let Self::Pipe {
            maximum_input_bytes,
            maximum_controls,
            stdin,
            ..
        } = self
            && (!(1..=super::pipe_protocol::CONTROLS).contains(maximum_controls)
                || stdin.len() as u64
                    > super::pipe_protocol::quantity(
                        maximum_input_bytes,
                        super::pipe_protocol::TOTAL_BYTES,
                    )?)
        {
            return Err(invalid());
        }
        Ok(())
    }

    /// Defaults remain process-local; only the declared Machine variant can add resolved overrides.
    pub fn environment(&self, command: &mut Command) {
        if let Self::Machine { environment, .. } | Self::Pipe { environment, .. } = self {
            for entry in environment {
                command.env(&entry.name, &entry.value);
            }
        }
    }

    pub fn pipe(&self) -> bool {
        matches!(self, Self::Pipe { .. })
    }
}

fn relative_cwd(value: &str) -> bool {
    value == "."
        || (!value.is_empty()
            && value.len() <= 512
            && !value.contains('\\')
            && !value.contains(':')
            && value.split('/').all(|part| {
                !part.is_empty()
                    && part != "."
                    && part != ".."
                    && !part.chars().any(char::is_control)
            }))
}

fn environment_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && !value.starts_with("NERVA_")
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphabetic() || byte == b'_' || (index > 0 && byte.is_ascii_digit())
        })
}

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

fn cwd(root: &File, path: &str) -> io::Result<File> {
    if !relative_cwd(path) {
        return Err(invalid());
    }
    let path = CString::new(path).map_err(|_| invalid())?;
    let how = OpenHow {
        flags: (libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
        mode: 0,
        resolve: 0x01 | 0x02 | 0x04 | 0x08,
    };
    // SAFETY: The root is borrowed and live, path is terminated, and OpenHow has the kernel's exact layout.
    let descriptor = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            root.as_raw_fd(),
            path.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        )
    };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: Successful openat2 returns a fresh owned descriptor representable as the OS descriptor type.
    let file = unsafe { File::from_raw_fd(descriptor as i32) };
    if file.as_raw_fd() < 3 {
        return Err(invalid());
    }
    Ok(file)
}

fn sealed_stdin(value: &str) -> io::Result<File> {
    if value.len() > 1024 {
        return Err(invalid());
    }
    // SAFETY: The constant is terminated; these flags create a fresh private sealable descriptor.
    let descriptor = unsafe {
        libc::memfd_create(
            c"nerva-application-input".as_ptr(),
            libc::MFD_ALLOW_SEALING | libc::MFD_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: Successful memfd_create returns a fresh descriptor owned by this File.
    let mut file = unsafe { File::from_raw_fd(descriptor) };
    if file.as_raw_fd() < 3 {
        return Err(invalid());
    }
    file.write_all(value.as_bytes())?;
    file.seek(SeekFrom::Start(0))?;
    // SAFETY: The owned descriptor is live; all content, size and future-seal changes are disabled.
    if unsafe {
        libc::fcntl(
            file.as_raw_fd(),
            libc::F_ADD_SEALS,
            libc::F_SEAL_WRITE | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_SEAL,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(file)
}

/// Owned setup handles are consumed before confinement closes every nonstandard descriptor.
pub struct PreparedInput {
    directory: Option<File>,
    stdin: Option<File>,
}

impl PreparedInput {
    /// The fixed variant cannot acquire caller input or a different cwd by missing a field.
    pub fn prepare(input: &RuntimeInput) -> io::Result<Self> {
        input.validate()?;
        match input {
            RuntimeInput::Fixed {} => Ok(Self {
                directory: None,
                stdin: None,
            }),
            RuntimeInput::Machine {
                cwd: path, stdin, ..
            } => {
                let root = OpenOptions::new()
                    .read(true)
                    .custom_flags(
                        libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                    .open("/workspace")?;
                Ok(Self {
                    directory: Some(cwd(&root, path)?),
                    stdin: Some(sealed_stdin(stdin)?),
                })
            }
            RuntimeInput::Pipe { cwd: path, .. } => {
                let root = OpenOptions::new()
                    .read(true)
                    .custom_flags(
                        libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                    .open("/workspace")?;
                Ok(Self {
                    directory: Some(cwd(&root, path)?),
                    stdin: None,
                })
            }
        }
    }

    /// Kernel references pin cwd and application bytes; the launcher channel is never application stdin.
    pub fn install(self) -> io::Result<()> {
        if let Some(directory) = self.directory {
            // SAFETY: This process owns the verified directory and changes only its own working directory.
            if unsafe { libc::fchdir(directory.as_raw_fd()) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        if let Some(stdin) = self.stdin {
            // SAFETY: The owned source is above standard descriptors; dup2 transfers an independent reference to fd zero.
            if unsafe { libc::dup2(stdin.as_raw_fd(), libc::STDIN_FILENO) } != libc::STDIN_FILENO {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "runtime_input_tests.rs"]
mod tests;
