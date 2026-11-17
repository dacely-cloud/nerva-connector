/* SPDX-FileCopyrightText: 2026 Nerva contributors
 * SPDX-License-Identifier: LicenseRef-Proprietary */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/ioctl.h>
#include <sys/ptrace.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static void failed(const char *name) {
    fprintf(stderr, "probe failed: %s (%d)\n", name, errno);
    exit(1);
}

static void effect(void) {
    int fd = open("/workspace/effects", O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (fd < 0 || write(fd, "x", 1) != 1 || close(fd) != 0) failed("command effect");
}

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    if (!strcmp(argv[1], "machine-input")) {
        char cwd[1024];
        const char *mode = getenv("APP_MODE");
        if (!getcwd(cwd, sizeof(cwd)) || strcmp(cwd, "/workspace/nested")) failed("captured cwd");
        if (!mode || strcmp(mode, "fixture") || getenv("NERVA_CONNECTOR_PARENT_PID") || getenv("NERVA_TEST_PRIVATE")) failed("explicit environment");
        for (int fd = 3; fd < 64; fd++) if (fcntl(fd, F_GETFD) != -1 || errno != EBADF) failed("application inherited descriptor");
        const unsigned char expected[] = {'b','e','f','o','r','e',0,'a','f','t','e','r','\n'};
        unsigned char actual[sizeof(expected) + 1];
        size_t copied = 0;
        for (;;) {
            ssize_t count = read(0, actual + copied, sizeof(actual) - copied);
            if (count < 0) failed("application input");
            if (count == 0) break;
            copied += (size_t)count;
            if (copied == sizeof(actual)) failed("application input bound");
        }
        if (copied != sizeof(expected) || memcmp(actual, expected, sizeof(expected))) failed("exact application input");
        int seals = fcntl(0, F_GET_SEALS);
        if (seals != (F_SEAL_WRITE | F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_SEAL)) failed("sealed application input");
        if (write(0, "x", 1) != -1 || errno != EPERM) failed("immutable application input");
        if (socket(AF_INET, SOCK_STREAM, 0) >= 0 || errno != EPERM) failed("machine network confinement");
        int effect = open("relative-effect", O_WRONLY | O_CREAT | O_EXCL, 0600);
        if (effect < 0 || write(effect, "native", 6) != 6 || close(effect) != 0) failed("relative command effect");
        puts("machine inputs verified");
        return 0;
    }
    if (!strcmp(argv[1], "forbidden")) {
        puts("FORBIDDEN_EXECUTED");
        return 0;
    }
    if (!strcmp(argv[1], "effect")) {
        effect();
        puts("effect applied");
        return 0;
    }
    if (!strcmp(argv[1], "detached-output")) {
        if (write(1, "retained", 8) != 8) failed("detached output");
        pid_t child = fork();
        if (child < 0) failed("detached descendant");
        if (child == 0) {
            close(0); close(1); close(2);
            for (;;) __asm__ volatile("" ::: "memory");
        }
        return 0;
    }
    if (!strcmp(argv[1], "loop")) {
        for (;;) __asm__ volatile("" ::: "memory");
    }
    if (!strcmp(argv[1], "output")) {
        char buffer[4096];
        memset(buffer, 'x', sizeof(buffer));
        for (;;) if (write(1, buffer, sizeof(buffer)) < 0) return 1;
    }
    if (!strcmp(argv[1], "memory")) {
        volatile char *bytes = malloc(268435456);
        if (!bytes) failed("allocation");
        for (size_t i = 0; i < 268435456; i += 4096) bytes[i] = 1;
        puts("UNBOUNDED_MEMORY");
        return 1;
    }
    if (!strcmp(argv[1], "hold-a") || !strcmp(argv[1], "hold-b") || !strcmp(argv[1], "effect-hold") || !strcmp(argv[1], "output-hold")) {
        pid_t child = fork();
        if (child < 0) failed("held descendant");
        if (child == 0) for (;;) pause();
        if (!strcmp(argv[1], "effect-hold") || !strcmp(argv[1], "output-hold")) effect();
        if (!strcmp(argv[1], "output-hold")) {
            unsigned char out[4096];
            memset(out, 'O', sizeof(out));
            memcpy(out, "\xef\xbb\xbf\x00\xff", 5);
            const unsigned char err[] = {0x00, 0xfe, 'E'};
            if (write(1, out, sizeof(out)) != (ssize_t)sizeof(out) || write(2, err, sizeof(err)) != (ssize_t)sizeof(err)) failed("output prefix");
        }
        char marker[64];
        if (snprintf(marker, sizeof(marker), "/workspace/%s", argv[1]) >= (int)sizeof(marker)) failed("held marker");
        int fd = open(marker, O_WRONLY | O_CREAT | O_EXCL, 0600);
        if (fd < 0 || write(fd, "running", 7) != 7 || close(fd) != 0) failed("held marker");
        for (;;) pause();
    }
    if (!strcmp(argv[1], "tasks")) {
        pid_t children[80];
        int count = 0;
        for (; count < 80; count++) {
            pid_t child = fork();
            if (child < 0) break;
            if (child == 0) for (;;) pause();
            children[count] = child;
        }
        int bounded = count < 64 && errno == EAGAIN;
        for (int i = 0; i < count; i++) if (kill(children[i], SIGKILL) != 0) failed("task signal");
        for (int i = 0; i < count; i++) if (waitpid(children[i], NULL, 0) != children[i]) failed("task join");
        if (!bounded) failed("task limit");
        puts("tasks bounded");
        return 0;
    }
    if (!strcmp(argv[1], "descendant")) {
        pid_t child = fork();
        if (child < 0) failed("fork");
        if (child == 0) for (;;) __asm__ volatile("" ::: "memory");
        puts("parent exited");
        return 0;
    }
    if (!strcmp(argv[1], "file-limit")) {
        int fd = open("/workspace/large", O_WRONLY | O_CREAT, 0600);
        if (fd < 0) failed("bounded file open");
        char buffer[4096];
        memset(buffer, 'x', sizeof(buffer));
        for (;;) if (write(fd, buffer, sizeof(buffer)) < 0) return 1;
    }
    int writable = !strcmp(argv[1], "read-write");
    if (!writable && strcmp(argv[1], "read-only")) return 2;
    for (int fd = 3; fd < 64; fd++) if (fcntl(fd, F_GETFD) != -1 || errno != EBADF) failed("inherited descriptor");
    if (getenv("NERVA_TEST_PRIVATE") || getenv("LD_PRELOAD") || getenv("NODE_OPTIONS")) failed("inherited environment");
    int fd = open("/workspace/input", O_RDONLY);
    char bytes[4];
    if (fd < 0 || read(fd, bytes, 4) != 4 || memcmp(bytes, "safe", 4)) failed("authorized read");
    close(fd);
    fd = open("/workspace/output", O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (writable) {
        if (fd < 0 || write(fd, "sandboxed", 9) != 9) failed("authorized write");
        close(fd);
    } else if (fd >= 0) failed("read-only mutation");
    char host_path[4096] = {0};
    fd = open("/workspace/host-path", O_RDONLY);
    if (fd < 0) failed("host canary reference");
    ssize_t path_length = read(fd, host_path, sizeof(host_path)-1);
    close(fd);
    if (path_length <= 0 || path_length >= (ssize_t)sizeof(host_path)-1 || host_path[0] != '/') failed("host canary reference");
    if (open(host_path, O_RDONLY) >= 0) failed("ambient host read");
    char parent_path[8192];
    if (snprintf(parent_path, sizeof(parent_path), "/proc/1/root%s", host_path) >= (int)sizeof(parent_path)) failed("host canary reference");
    if (open(parent_path, O_RDONLY) >= 0) failed("proc parent host read");
    if (open("/usr/bin/forbidden", O_WRONLY | O_TRUNC) >= 0) failed("runtime mutation");
    if (socket(AF_INET, SOCK_STREAM, 0) != -1 || socket(AF_INET6, SOCK_STREAM, 0) != -1 || socket(AF_UNIX, SOCK_STREAM, 0) != -1) failed("socket");
    if (unshare(CLONE_NEWUSER) != -1 || mount("none", "/tmp", "tmpfs", 0, NULL) != -1 || setns(-1, 0) != -1) failed("namespace");
    if (ptrace(PTRACE_TRACEME, 0, NULL, NULL) != -1 || chmod("/workspace/input", 0600) != -1) failed("privileged syscall");
    char injected = 'x';
    if (ioctl(0, TIOCSTI, &injected) != -1 || errno != EPERM) failed("terminal injection");
    char *arguments[] = {"/usr/bin/forbidden", "forbidden", NULL};
    char *environment[] = {NULL};
    if (execve(arguments[0], arguments, environment) != -1 || errno != EACCES) failed("forbidden executable");
    char *loader_arguments[] = {"/lib64/ld-linux-x86-64.so.2", "/usr/bin/forbidden", "forbidden", NULL};
    if (execve(loader_arguments[0], loader_arguments, environment) != -1 || errno != EACCES) failed("direct loader executable");
    if (syscall(SYS_execveat, -1, loader_arguments[0], loader_arguments, environment, AT_EMPTY_PATH) != -1 || errno != EACCES) failed("absolute execveat loader bypass");
    int loader = open(loader_arguments[0], O_RDONLY);
    if (loader < 0 || syscall(SYS_execveat, loader, "", loader_arguments, environment, AT_EMPTY_PATH) != -1 || errno != EACCES) failed("descriptor loader bypass");
    close(loader);
    puts("filesystem, executable, environment, namespace and network denials verified");
    return 0;
}
