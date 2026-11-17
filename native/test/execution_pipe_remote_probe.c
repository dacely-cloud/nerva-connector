// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary
#define main base_pipe_probe_main
#include "execution_pipe_probe.c"
#undef main

static int mark_remote(const char *name) {
    int fd = open(name, O_CREAT | O_EXCL | O_WRONLY, 0600);
    if (fd < 0) return 1;
    int failed = write_all(fd, "observed", 8);
    close(fd);
    return failed;
}

int main(int argc, char **argv) {
    if (argc != 2 || strcmp(argv[1], "descendant-eof")) return base_pipe_probe_main(argc, argv);
    int checked = verify();
    if (checked) return checked;
    pid_t child = fork();
    if (child < 0) return 20;
    if (child > 0) { for (;;) pause(); }
    errno = 0;
    if (setsid() != -1 || errno != EPERM) return 21;
    errno = 0;
    if (setpgid(0, 0) != -1 || errno != EPERM) return 22;
    if (mark_remote("descendant-ready")) return 23;
    char bytes[1024];
    for (;;) {
        ssize_t count = read(0, bytes, sizeof(bytes));
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) return 24;
        if (!count) break;
    }
    if (mark_remote("descendant-eof")) return 25;
    return write_all(2, "DESCENDANT EOF\n", 15);
}
