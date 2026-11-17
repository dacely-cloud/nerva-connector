//! Landlock constrains path access; seccomp denies execution/networking and removes mutation from read-only helpers.

use super::Failure;
use crate::sandbox::{self, Grant};
use seccompiler::{
    BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
    SeccompRule,
};
use std::collections::BTreeMap;

fn landlock(root: i32, stage: Option<i32>) -> Result<(), Failure> {
    let read_access = (1 << 2) | (1 << 3);
    let write_access =
        read_access | (1 << 1) | (1 << 4) | (1 << 5) | (1 << 7) | (1 << 8) | (1 << 13) | (1 << 14);
    let grants: Vec<Grant> = [Some(root), stage]
        .into_iter()
        .flatten()
        .map(|descriptor| Grant {
            descriptor,
            access: if stage.is_some() {
                write_access
            } else {
                read_access
            },
        })
        .collect();
    sandbox::restrict(&grants).map_err(|_| Failure::Unavailable)
}

fn condition(argument: u8, value: u64) -> Result<SeccompCondition, Failure> {
    SeccompCondition::new(argument, SeccompCmpArgLen::Dword, SeccompCmpOp::Eq, value)
        .map_err(|_| Failure::Unavailable)
}
fn descriptor(fd: u64) -> Result<SeccompRule, Failure> {
    SeccompRule::new(vec![condition(0, fd)?]).map_err(|_| Failure::Unavailable)
}

fn seccomp(root: i32, writable: bool) -> Result<(), Failure> {
    let mut calls: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();
    for syscall in [
        libc::SYS_pread64,
        libc::SYS_fstat,
        libc::SYS_getdents64,
        libc::SYS_lseek,
        libc::SYS_close,
        libc::SYS_brk,
        libc::SYS_munmap,
        libc::SYS_mremap,
        libc::SYS_madvise,
        libc::SYS_futex,
        libc::SYS_clock_gettime,
        libc::SYS_rt_sigreturn,
        libc::SYS_rt_sigprocmask,
        libc::SYS_exit,
        libc::SYS_exit_group,
        libc::SYS_getrandom,
    ] {
        calls.insert(syscall, Vec::new());
    }
    calls.insert(libc::SYS_read, vec![descriptor(0)?]);
    for syscall in [libc::SYS_write, libc::SYS_writev] {
        calls.insert(
            syscall,
            if writable {
                Vec::new()
            } else {
                vec![descriptor(1)?, descriptor(2)?]
            },
        );
    }
    calls.insert(
        libc::SYS_openat2,
        if writable {
            Vec::new()
        } else {
            vec![descriptor(root as u64)?]
        },
    );
    if writable {
        let mut modes = Vec::new();
        for mode in [0o600, 0o700] {
            modes.push(
                SeccompRule::new(vec![
                    condition(1, mode)?,
                    SeccompCondition::new(0, SeccompCmpArgLen::Dword, SeccompCmpOp::Ge, 3)
                        .map_err(|_| Failure::Unavailable)?,
                    SeccompCondition::new(
                        0,
                        SeccompCmpArgLen::Dword,
                        SeccompCmpOp::Ne,
                        root as u64,
                    )
                    .map_err(|_| Failure::Unavailable)?,
                    SeccompCondition::new(
                        0,
                        SeccompCmpArgLen::Dword,
                        SeccompCmpOp::Ne,
                        (root + 1) as u64,
                    )
                    .map_err(|_| Failure::Unavailable)?,
                ])
                .map_err(|_| Failure::Unavailable)?,
            );
        }
        calls.insert(libc::SYS_fchmod, modes);
        calls.insert(
            libc::SYS_flock,
            vec![
                SeccompRule::new(vec![condition(1, (libc::LOCK_EX | libc::LOCK_NB) as u64)?])
                    .map_err(|_| Failure::Unavailable)?,
            ],
        );
        calls.insert(
            libc::SYS_mkdirat,
            vec![SeccompRule::new(vec![condition(2, 0o700)?]).map_err(|_| Failure::Unavailable)?],
        );
        for syscall in [
            libc::SYS_fsync,
            libc::SYS_renameat2,
            libc::SYS_unlinkat,
            libc::SYS_pwrite64,
        ] {
            calls.insert(syscall, Vec::new());
        }
    }
    for syscall in [libc::SYS_mmap, libc::SYS_mprotect] {
        let argument = 2;
        let mut rules = Vec::new();
        for protection in [
            libc::PROT_NONE,
            libc::PROT_READ,
            libc::PROT_READ | libc::PROT_WRITE,
        ] {
            rules.push(
                SeccompRule::new(vec![
                    SeccompCondition::new(
                        argument,
                        SeccompCmpArgLen::Qword,
                        SeccompCmpOp::Eq,
                        protection as u64,
                    )
                    .map_err(|_| Failure::Unavailable)?,
                ])
                .map_err(|_| Failure::Unavailable)?,
            );
        }
        calls.insert(syscall, rules);
    }
    let filter = SeccompFilter::new(
        calls,
        SeccompAction::Errno(libc::EPERM as u32),
        SeccompAction::Allow,
        std::env::consts::ARCH
            .try_into()
            .map_err(|_| Failure::Unavailable)?,
    )
    .map_err(|_| Failure::Unavailable)?;
    let program: BpfProgram = filter.try_into().map_err(|_| Failure::Unavailable)?;
    seccompiler::apply_filter(&program).map_err(|_| Failure::Unavailable)
}

/// Unsupported kernels and any partial installation fail before untrusted input is read.
pub fn install(root: i32, stage: Option<i32>) -> Result<(), Failure> {
    if root < 3 || stage.is_some_and(|fd| fd != root + 1) {
        return Err(Failure::Unavailable);
    }
    if root > 3 {
        // SAFETY: This range excludes standard descriptors and the owned root; this finite helper has no threads.
        if unsafe { libc::syscall(libc::SYS_close_range, 3u32, (root - 1) as u32, 0u32) } != 0 {
            return Err(Failure::Unavailable);
        }
    }
    // SAFETY: All descriptors beyond root are inherited/unneeded and must not cross the sandbox boundary.
    if unsafe {
        libc::syscall(
            libc::SYS_close_range,
            (stage.unwrap_or(root) + 1) as u32,
            u32::MAX,
            0u32,
        )
    } != 0
    {
        return Err(Failure::Unavailable);
    }
    for (resource, value) in [
        (libc::RLIMIT_CPU, 2u64),
        (libc::RLIMIT_AS, 134217728u64),
        (libc::RLIMIT_NOFILE, 16u64),
        (libc::RLIMIT_NPROC, 0u64),
        (libc::RLIMIT_CORE, 0u64),
        (
            libc::RLIMIT_FSIZE,
            if stage.is_some() {
                i64::MAX as u64
            } else {
                0u64
            },
        ),
    ] {
        let limit = libc::rlimit {
            rlim_cur: value,
            rlim_max: value,
        };
        // SAFETY: setrlimit reads the valid structure and only reduces this owned helper's limits.
        if unsafe { libc::setrlimit(resource, &limit) } != 0 {
            return Err(Failure::Unavailable);
        }
    }
    // SAFETY: Disabling dumpability protects this process from same-user inspection and changes no other process.
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
        return Err(Failure::Unavailable);
    }
    landlock(root, stage)?;
    seccomp(root, stage.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::fs::File;
    use std::os::fd::AsRawFd;
    use std::process::Command;

    #[repr(C)]
    struct OpenHow {
        flags: u64,
        mode: u64,
        resolve: u64,
    }

    fn attempt(root: i32, path: &str, flags: i32) -> i32 {
        let path = CString::new(path).unwrap();
        let how = OpenHow {
            flags: flags as u64,
            mode: 0,
            resolve: 0,
        };
        // SAFETY: This deliberately omits path-resolution protections to independently test Landlock; all buffers are valid.
        unsafe {
            libc::syscall(
                libc::SYS_openat2,
                root,
                path.as_ptr(),
                &how,
                std::mem::size_of::<OpenHow>(),
            ) as i32
        }
    }

    fn probe(root: &str, outside: &str) -> bool {
        let root = File::open(root).unwrap();
        let fd = root.as_raw_fd();
        if install(fd, None).is_err() {
            return false;
        }
        let readable = attempt(fd, "inside", libc::O_RDONLY);
        if readable < 0 {
            return false;
        }
        let mut bytes = [0u8; 4];
        // SAFETY: pread64 receives an owned file descriptor and valid finite output buffer.
        let read = unsafe { libc::pread(readable, bytes.as_mut_ptr().cast(), bytes.len(), 0) };
        let forbidden_read = attempt(fd, outside, libc::O_RDONLY);
        let forbidden_write = attempt(fd, "inside", libc::O_WRONLY | libc::O_TRUNC);
        let executable = CString::new("/bin/true").unwrap();
        let empty: [*const libc::c_char; 1] = [std::ptr::null()];
        // SAFETY: These valid calls intentionally test kernel denials after confinement; no unsafe pointer is supplied.
        let denied = unsafe {
            libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) == -1
                && libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) == -1
                && libc::execve(executable.as_ptr(), empty.as_ptr(), empty.as_ptr()) == -1
                && libc::ftruncate(readable, 0) == -1
                && libc::pwrite(readable, bytes.as_ptr().cast(), bytes.len(), 0) == -1
                && libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) == -1
                && libc::write(readable, bytes.as_ptr().cast(), bytes.len()) == -1
                && libc::unlinkat(fd, c"inside".as_ptr(), 0) == -1
                && libc::unlinkat(fd, c"directory".as_ptr(), libc::AT_REMOVEDIR) == -1
                && libc::mkdirat(fd, c"forbidden-directory".as_ptr(), 0o700) == -1
                && libc::fchmod(readable, 0o777) == -1
                && libc::fchmod(readable, 0o600) == -1
                && libc::fchmod(readable, 0o700) == -1
                && libc::prctl(libc::PR_SET_DUMPABLE, 1, 0, 0, 0) == -1
                && libc::ptrace(
                    libc::PTRACE_TRACEME,
                    0,
                    std::ptr::null_mut::<u8>(),
                    std::ptr::null_mut::<u8>(),
                ) == -1
        };
        read == 4 && bytes == *b"safe" && forbidden_read == -1 && forbidden_write == -1 && denied
    }

    #[test]
    fn kernel_denies_ambient_read_write_network_and_execution() {
        if let Ok(root) = std::env::var("NERVA_CONNECTOR_SANDBOX_TEST_ROOT") {
            let outside = std::env::var("NERVA_CONNECTOR_SANDBOX_TEST_OUTSIDE").unwrap();
            let success = probe(&root, &outside);
            // SAFETY: This child is intentionally confined; exit avoids running the unrestricted harness's cleanup inside it.
            unsafe {
                libc::_exit(if success { 0 } else { 1 });
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("root");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("inside"), b"safe").unwrap();
        std::fs::create_dir(root.join("directory")).unwrap();
        let outside = directory.path().join("outside");
        std::fs::write(&outside, b"private").unwrap();
        let test_name = concat!(
            "connector_files::confinement::tests::",
            "kernel_denies_ambient_read_write_network_and_execution"
        );
        let result = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test_name, "--nocapture"])
            .env_clear()
            .env("NERVA_CONNECTOR_SANDBOX_TEST_ROOT", &root)
            .env("NERVA_CONNECTOR_SANDBOX_TEST_OUTSIDE", &outside)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "confinement child did not prove its kernel denials"
        );
        assert_eq!(std::fs::read(root.join("inside")).unwrap(), b"safe");
        assert!(root.join("directory").is_dir());
        assert_eq!(std::fs::read(&outside).unwrap(), b"private");
    }
}
