// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

//! The trusted outer helper blocks on input until its owner has attached it to the exact bounded cgroup.

use super::configuration::{WorkspaceAccess, invalid};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::process::CommandExt;
use std::process::Command;

pub fn run() -> io::Result<()> {
    crate::sandbox::parent_lifetime()?;
    let mut bytes = Vec::new();
    std::io::stdin()
        .take((super::limits::LAUNCH_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > super::limits::LAUNCH_BYTES {
        return Err(invalid());
    }
    let configuration = super::launch_configuration::decode(&bytes)?;
    let launcher = configuration.apparmor_profile.replacen(
        "nerva-connector-exec-",
        "nerva-connector-launch-",
        1,
    );
    std::fs::write("/proc/self/attr/exec", format!("exec {launcher}"))?;
    // SAFETY: The terminated constant and supported flag create a new sealable anonymous descriptor.
    let descriptor =
        unsafe { libc::memfd_create(c"nerva-execution".as_ptr(), libc::MFD_ALLOW_SEALING) };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: Successful memfd_create returns a new descriptor owned by this scope.
    let mut file = unsafe { File::from_raw_fd(descriptor) };
    file.write_all(&serde_json::to_vec(&configuration).map_err(|_| invalid())?)?;
    file.seek(SeekFrom::Start(0))?;
    // SAFETY: These seals prevent all future content/length changes; the owned descriptor is live.
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
    let mut command = Command::new("/proc/self/fd/4");
    command.args([
        "--unshare-user",
        "--unshare-pid",
        "--unshare-net",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup",
        "--disable-userns",
        "--uid",
        "0",
        "--gid",
        "0",
        "--hostname",
        "nerva-task",
        "--new-session",
        "--die-with-parent",
        "--cap-drop",
        "ALL",
        "--clearenv",
        "--ro-bind-fd",
        "5",
        "/",
        match configuration.workspace_access {
            WorkspaceAccess::ReadOnly => "--ro-bind-fd",
            WorkspaceAccess::ReadWrite => "--bind-fd",
        },
        "6",
        "/workspace",
        "--ro-bind-fd",
        "7",
        "/nerva-limits",
        "--ro-bind-fd",
        "3",
        "/nerva-exec",
        "--ro-bind-data",
        &file.as_raw_fd().to_string(),
        "/nerva-execution.json",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--chdir",
        "/workspace",
    ]);
    for executable in &configuration.executable_descriptors {
        command.args([
            "--ro-bind-fd",
            &executable.descriptor.to_string(),
            &executable.path,
        ]);
    }
    if configuration.input.pipe() {
        super::pipe_broker::verify(8)?;
        // SAFETY: The finite bootstrap pipe has reached EOF and its sealed data is independent. The explicit Pipe-only broker is a separate inherited socket, never appended bootstrap bytes.
        if unsafe { libc::dup2(8, libc::STDIN_FILENO) } != libc::STDIN_FILENO {
            return Err(invalid());
        }
    }
    let error = command.args(["--", "/nerva-exec"]).env_clear().exec();
    Err(error)
}
