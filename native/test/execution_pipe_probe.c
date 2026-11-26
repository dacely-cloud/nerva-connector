// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

static int write_all(int fd, const void *buffer, size_t count) {
    const unsigned char *bytes = buffer;
    while (count) {
        ssize_t wrote = write(fd, bytes, count);
        if (wrote < 0 && errno == EINTR) continue;
        if (wrote <= 0) return 1;
        bytes += wrote; count -= (size_t)wrote;
    }
    return 0;
}

static int verify(void) {
    struct stat input;
    char cwd[512];
    if (fstat(0, &input) || !S_ISFIFO(input.st_mode)) return 10;
    if (isatty(0)) return 11;
    if (!getcwd(cwd, sizeof(cwd)) || strcmp(cwd, "/workspace/nested")) return 12;
    if (!getenv("APP_MODE") || strcmp(getenv("APP_MODE"), "fixture")) return 13;
    FILE *status = fopen("/proc/self/status", "r");
    if (!status) return 14;
    char state[16384];
    size_t length = fread(state, 1, sizeof(state) - 1, status);
    fclose(status); state[length] = 0;
    char *privileges = strstr(state, "NoNewPrivs:");
    if (!privileges) return 14;
    privileges += strlen("NoNewPrivs:");
    while (*privileges == ' ' || *privileges == '\t') privileges++;
    if (privileges[0] != '1' || privileges[1] != '\n') return 14;
    for (int fd = 3; fd < 128; fd++) {
        errno = 0;
        if (fcntl(fd, F_GETFD) != -1 || errno != EBADF) return 2;
    }
    errno = 0;
    int descriptor = socket(AF_INET, SOCK_STREAM, 0);
    if (descriptor >= 0 || errno != EPERM) return 3;
    errno = 0;
    if (ptrace(PTRACE_TRACEME, 0, 0, 0) != -1 || errno != EPERM) return 4;
    errno = 0;
    if (kill(getppid(), SIGTERM) != -1 || (errno != EPERM && errno != EACCES)) return 5;
    return 0;
}

int main(int argc, char **argv) {
    int bootstrap_bounds = argc == 33 && !strcmp(argv[1], "bootstrap-bounds");
    if (argc != 2 && !bootstrap_bounds) return 2;
    if (bootstrap_bounds) {
        size_t argument_bytes = strlen(argv[1]);
        for (int index = 2; index < argc; index++) {
            argument_bytes += strlen(argv[index]);
            for (const char *value = argv[index]; *value; value++) {
                if (*value != 1) return 20;
            }
        }
        if (argument_bytes != 8192) return 21;
    }
    int checked = verify();
    if (checked) { dprintf(2, "pipe confinement check %d\n", checked); return 1; }
    if (!strcmp(argv[1], "exit")) return 0;
    if (!strcmp(argv[1], "hold")) { for (;;) pause(); }
    if (!strcmp(argv[1], "descendant")) {
        pid_t child = fork();
        if (child < 0) return 1;
        if (!child) { for (;;) pause(); }
        return write_all(1, "descendant started\n", 19);
    }
    if (!strcmp(argv[1], "closed-input")) {
        close(0);
        int marker = open("input-is-closed", O_CREAT | O_EXCL | O_WRONLY, 0600);
        if (marker < 0 || write_all(marker, "closed", 6)) return 1;
        close(marker);
        if (write_all(1, "input closed\n", 13)) return 1;
        for (;;) pause();
    }
    if (!strcmp(argv[1], "slow")) usleep(250000);
    unsigned char bytes[1024];
    size_t total = 0;
    for (;;) {
        ssize_t count = read(0, bytes, sizeof(bytes));
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) return 1;
        if (!count) break;
        total += (size_t)count;
        if (strcmp(argv[1], "discard") && write_all(1, bytes, (size_t)count)) return 1;
    }
    if (!strcmp(argv[1], "write")) {
        int output = open("pipe-effect", O_CREAT | O_EXCL | O_WRONLY, 0600);
        if (output < 0) return write_all(1, "write denied\n", 13);
        int failed = write_all(output, "native", 6);
        close(output);
        if (failed) return 1;
    }
    if (!strcmp(argv[1], "discard")) return dprintf(1, "%zu\n", total) < 0;
    return write_all(2, "real EOF\n", 9);
}
