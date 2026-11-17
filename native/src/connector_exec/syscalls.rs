// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

//! Explicit syscall admission complements mount, capability, cgroup and Landlock enforcement.

use seccompiler::{
    BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
    SeccompRule,
};
use std::collections::BTreeMap;
use std::io;

pub fn install() -> io::Result<()> {
    let mut unavailable: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();
    unavailable.insert(libc::SYS_clone3, Vec::new());
    apply(
        unavailable,
        SeccompAction::Allow,
        SeccompAction::Errno(libc::ENOSYS as u32),
    )?;
    let mut calls: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();
    for call in [
        libc::SYS_read,
        libc::SYS_write,
        libc::SYS_readv,
        libc::SYS_writev,
        libc::SYS_pread64,
        libc::SYS_pwrite64,
        libc::SYS_openat,
        libc::SYS_openat2,
        libc::SYS_close,
        libc::SYS_close_range,
        libc::SYS_fstat,
        libc::SYS_newfstatat,
        libc::SYS_statx,
        libc::SYS_statfs,
        libc::SYS_fstatfs,
        libc::SYS_faccessat,
        libc::SYS_faccessat2,
        libc::SYS_getdents64,
        libc::SYS_lseek,
        libc::SYS_readlinkat,
        libc::SYS_dup,
        libc::SYS_dup3,
        libc::SYS_fcntl,
        libc::SYS_pipe2,
        libc::SYS_mmap,
        libc::SYS_munmap,
        libc::SYS_mremap,
        libc::SYS_mprotect,
        libc::SYS_madvise,
        libc::SYS_brk,
        libc::SYS_futex,
        libc::SYS_set_tid_address,
        libc::SYS_set_robust_list,
        libc::SYS_get_robust_list,
        libc::SYS_rseq,
        libc::SYS_clock_gettime,
        libc::SYS_clock_getres,
        libc::SYS_clock_nanosleep,
        libc::SYS_nanosleep,
        libc::SYS_gettimeofday,
        libc::SYS_getrandom,
        libc::SYS_rt_sigaction,
        libc::SYS_rt_sigprocmask,
        libc::SYS_rt_sigreturn,
        libc::SYS_rt_sigtimedwait,
        libc::SYS_rt_sigsuspend,
        libc::SYS_sigaltstack,
        libc::SYS_getpid,
        libc::SYS_getppid,
        libc::SYS_gettid,
        libc::SYS_getuid,
        libc::SYS_geteuid,
        libc::SYS_getgid,
        libc::SYS_getegid,
        libc::SYS_getgroups,
        libc::SYS_getresuid,
        libc::SYS_getresgid,
        libc::SYS_getpgid,
        libc::SYS_getsid,
        libc::SYS_wait4,
        libc::SYS_waitid,
        libc::SYS_kill,
        libc::SYS_tgkill,
        libc::SYS_execve,
        libc::SYS_execveat,
        libc::SYS_exit,
        libc::SYS_exit_group,
        libc::SYS_sched_yield,
        libc::SYS_sched_getaffinity,
        libc::SYS_getrusage,
        libc::SYS_getrlimit,
        libc::SYS_prlimit64,
        libc::SYS_uname,
        libc::SYS_sysinfo,
        libc::SYS_chdir,
        libc::SYS_fchdir,
        libc::SYS_getcwd,
        libc::SYS_umask,
        libc::SYS_fsync,
        libc::SYS_fdatasync,
        libc::SYS_ftruncate,
        libc::SYS_truncate,
        libc::SYS_mkdirat,
        libc::SYS_unlinkat,
        libc::SYS_renameat,
        libc::SYS_renameat2,
        libc::SYS_linkat,
        libc::SYS_symlinkat,
        libc::SYS_flock,
        libc::SYS_ppoll,
        libc::SYS_pselect6,
        libc::SYS_epoll_create1,
        libc::SYS_epoll_ctl,
        libc::SYS_epoll_pwait,
        libc::SYS_eventfd2,
        libc::SYS_timerfd_create,
        libc::SYS_timerfd_settime,
        libc::SYS_timerfd_gettime,
        libc::SYS_sendfile,
        libc::SYS_copy_file_range,
        libc::SYS_shutdown,
        libc::SYS_getsockname,
        libc::SYS_getpeername,
        libc::SYS_getsockopt,
        libc::SYS_clone3,
    ] {
        calls.insert(call, Vec::new());
    }
    #[cfg(target_arch = "x86_64")]
    for call in [
        libc::SYS_arch_prctl,
        libc::SYS_open,
        libc::SYS_stat,
        libc::SYS_lstat,
        libc::SYS_access,
        libc::SYS_readlink,
        libc::SYS_dup2,
        libc::SYS_pipe,
        libc::SYS_select,
        libc::SYS_epoll_wait,
        libc::SYS_fork,
        libc::SYS_vfork,
        libc::SYS_mkdir,
        libc::SYS_unlink,
        libc::SYS_rename,
        libc::SYS_rmdir,
        libc::SYS_time,
        libc::SYS_poll,
        libc::SYS_getpgrp,
        libc::SYS_pause,
    ] {
        calls.insert(call, Vec::new());
    }
    let namespaces = (libc::CLONE_NEWUSER
        | libc::CLONE_NEWNS
        | libc::CLONE_NEWPID
        | libc::CLONE_NEWNET
        | libc::CLONE_NEWIPC
        | libc::CLONE_NEWUTS
        | libc::CLONE_NEWCGROUP
        | libc::CLONE_PTRACE) as u64;
    let condition = SeccompCondition::new(
        0,
        SeccompCmpArgLen::Qword,
        SeccompCmpOp::MaskedEq(namespaces),
        0,
    )
    .map_err(io::Error::other)?;
    calls.insert(
        libc::SYS_clone,
        vec![SeccompRule::new(vec![condition]).map_err(io::Error::other)?],
    );
    let pair = SeccompRule::new(vec![
        SeccompCondition::new(
            0,
            SeccompCmpArgLen::Dword,
            SeccompCmpOp::Eq,
            libc::AF_UNIX as u64,
        )
        .map_err(io::Error::other)?,
        SeccompCondition::new(2, SeccompCmpArgLen::Dword, SeccompCmpOp::Eq, 0)
            .map_err(io::Error::other)?,
    ])
    .map_err(io::Error::other)?;
    calls.insert(libc::SYS_socketpair, vec![pair]);
    let mut ioctls = Vec::new();
    for request in [
        libc::FIONBIO,
        libc::FIONREAD,
        libc::FIOCLEX,
        libc::FIONCLEX,
        libc::TCGETS,
        libc::TIOCGWINSZ,
    ] {
        let condition =
            SeccompCondition::new(1, SeccompCmpArgLen::Dword, SeccompCmpOp::Eq, request)
                .map_err(io::Error::other)?;
        ioctls.push(SeccompRule::new(vec![condition]).map_err(io::Error::other)?);
    }
    calls.insert(libc::SYS_ioctl, ioctls);
    apply(
        calls,
        SeccompAction::Errno(libc::EPERM as u32),
        SeccompAction::Allow,
    )
}

fn apply(
    calls: BTreeMap<i64, Vec<SeccompRule>>,
    default: SeccompAction,
    matched: SeccompAction,
) -> io::Result<()> {
    let filter = SeccompFilter::new(
        calls,
        default,
        matched,
        std::env::consts::ARCH
            .try_into()
            .map_err(io::Error::other)?,
    )
    .map_err(io::Error::other)?;
    let program: BpfProgram = filter.try_into().map_err(io::Error::other)?;
    seccompiler::apply_filter(&program).map_err(io::Error::other)
}
