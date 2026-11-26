// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Check actual namespace, mount, capability and cgroup state before allowing any payload instruction.

use super::configuration::{Configuration, WorkspaceAccess, invalid};
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;

/// The exact explicit profile must already be installed and enforcing; normal runtime never installs or relaxes it.
pub fn apparmor(profile: &str) -> io::Result<()> {
    let launcher = profile.replacen("nerva-connector-exec-", "nerva-connector-launch-", 1);
    if bounded("/proc/self/attr/current", 512)?.trim() != format!("{launcher} (enforce)") {
        return Err(invalid());
    }
    fs::write("/proc/self/attr/current", format!("stack {profile}"))?;
    let label = bounded("/proc/self/attr/current", 512)?;
    let profiles = label
        .trim()
        .strip_suffix(" (enforce)")
        .ok_or_else(invalid)?;
    let profiles: Vec<&str> = profiles.split("//&").collect();
    if profiles.len() != 2 || !profiles.contains(&profile) || !profiles.contains(&launcher.as_str())
    {
        return Err(invalid());
    }
    Ok(())
}

/// Every supported namespace must differ from the exact host namespace captured by the trusted launcher.
pub fn namespaces(value: &Configuration) -> io::Result<()> {
    let names = ["mnt", "user", "pid", "net", "ipc", "uts", "cgroup"];
    if value.parent_namespaces.len() != names.len() {
        return Err(invalid());
    }
    for name in names {
        let parent = value.parent_namespaces.get(name).ok_or_else(invalid)?;
        let current = fs::read_link(format!("/proc/self/ns/{name}"))?;
        let suffix = parent
            .strip_prefix(&format!("{name}:["))
            .and_then(|s| s.strip_suffix(']'));
        if suffix
            .is_none_or(|digits| digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()))
            || current.as_os_str().as_bytes() == parent.as_bytes()
        {
            return Err(invalid());
        }
    }
    for capability in 0..=40 {
        // SAFETY: The process-local bounding-set query has no pointers and cannot grant capabilities.
        if unsafe { libc::prctl(libc::PR_CAPBSET_READ, capability, 0, 0, 0) } != 0 {
            return Err(invalid());
        }
    }
    let status = bounded("/proc/self/status", 16384)?;
    if !["CapInh:", "CapPrm:", "CapEff:", "CapAmb:"]
        .iter()
        .all(|name| {
            status.lines().any(|line| {
                line.strip_prefix(name)
                    .is_some_and(|n| n.trim() == "0000000000000000")
            })
        })
    {
        return Err(invalid());
    }
    Ok(())
}

fn bounded(path: &str, limit: u64) -> io::Result<String> {
    use std::io::Read;
    let file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(invalid());
    }
    String::from_utf8(bytes).map_err(|_| invalid())
}

fn decimal(value: &str) -> io::Result<u64> {
    let value = value.trim();
    if value.is_empty() || value.len() > 16 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid());
    }
    value.parse().map_err(|_| invalid())
}

/// A real read-only cgroup2 bind must contain this process and independently bound aggregate memory, CPU and tasks.
pub fn cgroup() -> io::Result<()> {
    let mut status = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: The fixed path is terminated and the syscall initializes the output on success.
    if unsafe { libc::statfs(c"/nerva-limits".as_ptr(), status.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: statfs returned success and initialized the complete structure.
    if unsafe { status.assume_init() }.f_type != libc::CGROUP2_SUPER_MAGIC {
        return Err(invalid());
    }
    let tasks = decimal(&bounded("/nerva-limits/pids.max", 32)?)?;
    let memory = decimal(&bounded("/nerva-limits/memory.max", 32)?)?;
    let swap = decimal(&bounded("/nerva-limits/memory.swap.max", 32)?)?;
    let cpu = bounded("/nerva-limits/cpu.max", 64)?;
    let cpu: Vec<&str> = cpu.split_whitespace().collect();
    if !(2..=64).contains(&tasks)
        || !(33554432..=1073741824).contains(&memory)
        || swap != 0
        || cpu.len() != 2
        || decimal(cpu[0])? == 0
        || decimal(cpu[0])? > decimal(cpu[1])?
        || !(1000..=1000000).contains(&decimal(cpu[1])?)
    {
        return Err(invalid());
    }
    // SAFETY: getpid has no arguments and returns this process's namespace-local PID.
    let pid = unsafe { libc::getpid() }.to_string();
    if !bounded("/nerva-limits/cgroup.procs", 4096)?
        .lines()
        .any(|line| line == pid)
    {
        return Err(invalid());
    }
    Ok(())
}

pub fn mounts(value: &Configuration) -> io::Result<()> {
    let root = flags(c"/")?;
    let workspace = flags(c"/workspace")?;
    if root & libc::ST_RDONLY == 0
        || flags(c"/nerva-limits")? & libc::ST_RDONLY == 0
        || (workspace & libc::ST_RDONLY != 0)
            != matches!(value.workspace_access, WorkspaceAccess::ReadOnly)
    {
        return Err(invalid());
    }
    Ok(())
}

fn flags(path: &std::ffi::CStr) -> io::Result<libc::c_ulong> {
    let mut status = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: The caller supplies a valid C string and the syscall initializes output on success.
    if unsafe { libc::statvfs(path.as_ptr(), status.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: statvfs returned success and initialized the complete structure.
    Ok(unsafe { status.assume_init() }.f_flag)
}
