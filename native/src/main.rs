// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

#[cfg(target_os = "linux")]
mod connector_files;
#[cfg(target_os = "linux")]
mod file_effect;
#[cfg(target_os = "linux")]
mod opened_root_diagnostic;
#[cfg(target_os = "linux")]
mod opened_root_identity;
#[cfg(target_os = "linux")]
mod private_parent_pipe;
#[cfg(target_os = "linux")]
mod sandbox;
#[cfg(target_os = "linux")]
mod workspace_identity;

/// The confined file lane depends on Landlock, seccomp and openat2, so other systems refuse every request.
#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("NERVA_FILES_SETUP unsupported-platform");
    std::process::exit(125);
}

/// Communication-only local file helper: the caller selects an approved root before any request is read.
#[cfg(target_os = "linux")]
fn main() {
    if opened_root_diagnostic::selected() {
        std::process::exit(opened_root_diagnostic::run());
    }
    if file_effect::capture_selected() {
        std::process::exit(file_effect::capture());
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = if args.is_empty() {
        connector_files::run()
    } else {
        Err(connector_files::Failure::Invalid)
    };
    if let Err(error) = result {
        connector_files::failure(error);
        std::process::exit(1);
    }
}
