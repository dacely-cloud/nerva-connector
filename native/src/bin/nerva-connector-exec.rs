// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Confined execution retains its namespace checks; the separately selected host PTY uses ordinary OS-user authority.
//! On macOS only the host PTY exists: confined execution depends on Linux namespaces, cgroups and seccomp.

#[cfg(all(test, target_os = "linux"))]
#[path = "../../tests/support/cgroup_fixture.rs"]
mod cgroup_fixture;
#[cfg(target_os = "linux")]
#[path = "../cgroup_identity.rs"]
mod cgroup_identity;
#[cfg(target_os = "linux")]
#[path = "../connector_exec/mod.rs"]
mod connector_exec;
#[path = "../host_terminal/mod.rs"]
mod host_terminal;
#[cfg(target_os = "linux")]
#[path = "../opened_root_diagnostic.rs"]
mod opened_root_diagnostic;
#[cfg(target_os = "linux")]
#[path = "../opened_root_identity.rs"]
mod opened_root_identity;
#[cfg(target_os = "linux")]
#[path = "../private_parent_pipe.rs"]
mod private_parent_pipe;
#[cfg(target_os = "linux")]
#[path = "../sandbox/mod.rs"]
mod sandbox;
#[cfg(target_os = "linux")]
#[path = "../workspace_identity.rs"]
mod workspace_identity;

/// The macOS helper serves only the host PTY modes, selected by the first argument.
#[cfg(target_os = "macos")]
fn main() {
    let mode = std::env::args_os().nth(1);
    if mode.as_deref() == Some(std::ffi::OsStr::new("--host-terminal-probe")) {
        println!("{{\"supported\":{}}}", host_terminal::probe());
        return;
    }
    if mode.as_deref() == Some(std::ffi::OsStr::new("--host-terminal")) {
        if host_terminal::run().is_err() {
            eprintln!("NERVA_HOST_TERMINAL operation-failed");
            std::process::exit(70);
        }
        return;
    }
    eprintln!("NERVA_EXEC_SETUP unsupported-platform");
    std::process::exit(125);
}

#[cfg(target_os = "linux")]
fn main() {
    if opened_root_diagnostic::selected_mode("--host-terminal-probe") {
        println!("{{\"supported\":{}}}", host_terminal::probe());
        return;
    }
    if opened_root_diagnostic::selected_mode("--host-terminal") {
        if host_terminal::run().is_err() {
            eprintln!("NERVA_HOST_TERMINAL operation-failed");
            std::process::exit(70);
        }
        return;
    }
    if opened_root_diagnostic::selected() {
        std::process::exit(opened_root_diagnostic::run());
    }
    if opened_root_diagnostic::selected_mode("--capture-cgroup") {
        std::process::exit(opened_root_diagnostic::run_capture(
            "--capture-cgroup",
            cgroup_identity::CgroupIdentity::capture,
        ));
    }
    if let Err(error) = connector_exec::run() {
        eprintln!("NERVA_EXEC_SETUP {}", error.code());
        std::process::exit(125);
    }
}
