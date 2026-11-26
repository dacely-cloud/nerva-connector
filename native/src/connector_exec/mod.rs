// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

//! No payload runs until independently checked namespace, resource, mount and syscall restrictions are active.

mod admission;
mod bootstrap;
mod configuration;
mod confinement;
mod launch_configuration;
mod launch_window;
mod limits;
mod pipe;
mod pipe_broker;
mod pipe_group;
mod pipe_input;
mod pipe_mac;
mod pipe_process;
mod pipe_protocol;
mod runtime_input;
mod syscalls;

use std::os::unix::process::CommandExt;
use std::process::Command;

#[derive(Clone, Copy)]
pub enum SetupFailure {
    Bootstrap,
    Configuration,
    Namespaces,
    Cgroup,
    Mounts,
    Apparmor,
    Confinement,
    Execute,
}

impl SetupFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::Bootstrap => "bootstrap",
            Self::Configuration => "configuration",
            Self::Namespaces => "namespaces",
            Self::Cgroup => "cgroup",
            Self::Mounts => "mounts",
            Self::Apparmor => "apparmor",
            Self::Confinement => "confinement",
            Self::Execute => "execute",
        }
    }
}

pub fn run() -> Result<(), SetupFailure> {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "--launch" {
        return bootstrap::run().map_err(|_| SetupFailure::Bootstrap);
    }
    if std::env::args_os().len() != 1 {
        return Err(SetupFailure::Configuration);
    }
    let value = configuration::load().map_err(|_| SetupFailure::Configuration)?;
    admission::namespaces(&value).map_err(|_| SetupFailure::Namespaces)?;
    admission::cgroup().map_err(|_| SetupFailure::Cgroup)?;
    admission::mounts(&value).map_err(|_| SetupFailure::Mounts)?;
    if value.input.pipe() {
        return pipe::run(value);
    }
    runtime_input::PreparedInput::prepare(&value.input)
        .and_then(runtime_input::PreparedInput::install)
        .map_err(|_| SetupFailure::Configuration)?;
    admission::apparmor(&value.apparmor_profile).map_err(|_| SetupFailure::Apparmor)?;
    confinement::install(&value).map_err(|_| SetupFailure::Confinement)?;
    use std::io::Write;
    std::io::stdout()
        .write_all(b"NERVA_EXEC_READY\n")
        .map_err(|_| SetupFailure::Execute)?;
    std::io::stdout()
        .flush()
        .map_err(|_| SetupFailure::Execute)?;
    execute(&value)
}

/// Both explicit launch modes share the same exact arguments and clean declared environment.
fn execute(value: &configuration::Configuration) -> Result<(), SetupFailure> {
    let mut command = Command::new(&value.program);
    command.args(&value.arguments);
    if matches!(&value.input, runtime_input::RuntimeInput::Fixed {}) {
        command.current_dir("/workspace");
    }
    command
        .env_clear()
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .env("HOME", "/tmp")
        .env("TMPDIR", "/tmp")
        .env("PATH", "/usr/bin");
    value.input.environment(&mut command);
    let expiry = value.admission_expires_at_ms;
    // SAFETY: The last trusted pre-exec check performs only async-signal-safe host clock access and inline integer/error operations.
    unsafe {
        command.pre_exec(move || launch_window::check(expiry));
    }
    let _error = command.exec();
    Err(SetupFailure::Execute)
}
