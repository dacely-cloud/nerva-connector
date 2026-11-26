#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
# SPDX-License-Identifier: LicenseRef-Proprietary

"""Run the private descriptor test ELF in owned disposable filesystem mounts.

Build only `--test opened_root_identity` into the existing Cargo target first. This
runner never builds/copies installed helpers, changes signed profiles or reads keys.
"""

from __future__ import annotations

import argparse
import fcntl
from enum import StrEnum
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time
from types import FrameType


class CleanupPhase(StrEnum):
    OWNER = "verify-owned-root"
    NAMESPACE = "join-owned-namespace"
    LOOPS = "release-owned-image-loops"
    FILES = "remove-proven-idle-files"
    COMPLETE = "complete"


class NamespaceReceipt:
    """Only the process owner can record that its entire namespace group exited."""

    def __init__(self) -> None:
        self.started = False
        self.group: int | None = None
        self.joined = False


class OwnedQualification:
    """Uncertain cleanup retains its private root and both backing files."""

    def __init__(self, parent: Path) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="nerva-root-identity-", dir=parent))
        status = self.root.lstat()
        self.identity = (status.st_dev, status.st_ino)
        self.namespace = NamespaceReceipt()
        self.phase = CleanupPhase.NAMESPACE

    def cleanup(self) -> None:
        try:
            self._cleanup()
        except BaseException:
            self.retained()
            raise

    def _cleanup(self) -> None:
        self.phase = CleanupPhase.OWNER
        status = self.root.lstat()
        if not stat.S_ISDIR(status.st_mode) or (status.st_dev, status.st_ino) != self.identity:
            raise RuntimeError("Qualification root no longer matches its owned directory")
        self.phase = CleanupPhase.NAMESPACE
        if (self.namespace.started or self.namespace.group is not None) and not self.namespace.joined:
            raise RuntimeError("Owned namespace exit was not proven")
        self.phase = CleanupPhase.LOOPS
        failures = 0
        for name in ["source.img", "clone.img"]:
            image = self.root / name
            if image.exists():
                try:
                    release_loops(image)
                except (OSError, RuntimeError, subprocess.SubprocessError):
                    failures += 1
        if failures:
            raise RuntimeError("Owned loop cleanup was not proven; backing files retained")
        self.phase = CleanupPhase.FILES
        shutil.rmtree(self.root)
        self.phase = CleanupPhase.COMPLETE

    def retained(self) -> None:
        print("NERVA_ROOT_IDENTITY_RECOVERY " + json.dumps({
            "root": str(self.root), "phase": self.phase,
            "namespaceStarted": self.namespace.started,
            "namespaceGroup": self.namespace.group,
            "action": "Join the owned namespace group, resolve only loops whose backing inode/device match these images, and prove both images have no loop associations before removing this root.",
        }), file=sys.stderr)


def joined_group(group: int) -> bool:
    """A vanished owned group cannot retain this private namespace's mounted files."""
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            os.killpg(group, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.01)
    return False


def command(arguments: list[str], *, environment: dict[str, str] | None = None,
            output: bool = False, group: bool = False,
            receipt: NamespaceReceipt | None = None) -> None:
    """Keep the group leader unreaped until its exact owned group has been stopped."""
    if receipt is not None:
        if not group:
            raise RuntimeError("Namespace receipt requires an owned process group")
        # A signal between child creation and PID registration must retain backing files.
        receipt.started = True
    blocked = {signal.SIGINT, signal.SIGTERM}
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, blocked)
    child: subprocess.Popen[bytes] | None = None
    try:
        child = subprocess.Popen(
            arguments, env=environment, stdin=subprocess.DEVNULL,
            stdout=None if output else subprocess.DEVNULL,
            stderr=None if output else subprocess.DEVNULL,
            start_new_session=group,
        )
        if receipt is not None:
            receipt.group = child.pid
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)
        timeout = 45 if group else 15
        deadline = time.monotonic() + timeout
        while True:
            # WNOWAIT pins the leader PID/PGID even if it exits before its descendants.
            observed = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if observed is not None:
                if observed.si_code != os.CLD_EXITED or observed.si_status != 0:
                    raise RuntimeError("A bounded qualification subprocess failed")
                break
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(arguments, timeout)
            time.sleep(0.01)
    finally:
        # Deliver pending cancellation only after the owned process/group has been joined.
        signal.pthread_sigmask(signal.SIG_BLOCK, blocked)
        try:
            if child is not None:
                try:
                    if group:
                        os.killpg(child.pid, signal.SIGKILL)
                    else:
                        os.kill(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait(timeout=5)
                # No group signal is sent after wait() releases the pinned leader PID.
                if receipt is not None:
                    receipt.joined = joined_group(child.pid)
                    if not receipt.joined:
                        raise RuntimeError("Owned namespace descendants did not exit")
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous)


def associated(image: Path) -> list[Path]:
    """Query only this exact owned image; output is finite and never printed."""
    result = subprocess.run(
        ["losetup", "--associated", str(image), "--noheadings", "--output", "NAME"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        timeout=5, check=True,
    )
    if len(result.stdout) > 4096:
        raise RuntimeError("Loop association output exceeded its budget")
    values = result.stdout.decode("ascii", errors="strict").splitlines()
    if len(values) > 16 or any(re.fullmatch(r"/dev/loop[0-9]{1,6}", value.strip()) is None for value in values):
        raise RuntimeError("Invalid owned loop association")
    return [Path(value.strip()) for value in values]


def release_loops(image: Path) -> None:
    """Any emergency detach verifies the open loop's backing inode/device first."""
    expected = image.stat()
    for name in associated(image):
        descriptor = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        try:
            if not stat.S_ISBLK(os.fstat(descriptor).st_mode):
                raise RuntimeError("Owned loop reference is not a block device")
            status = fcntl.ioctl(descriptor, 0x4C05, bytes(232))  # LOOP_GET_STATUS64
            device, inode = struct.unpack_from("=QQ", status)
            if (device, inode) != (expected.st_dev, expected.st_ino):
                raise RuntimeError("Loop device no longer belongs to this qualification")
            fcntl.ioctl(descriptor, 0x4C01, 0)  # LOOP_CLR_FD; no unrelated device is selected.
        finally:
            os.close(descriptor)
    if associated(image):
        raise RuntimeError("Owned loop cleanup did not finish")


def namespace(root: Path, executable: Path) -> None:
    """All mounts are private; only fixed task-owned paths can be mounted/unmounted."""
    if os.readlink("/proc/self/ns/mnt") == os.readlink(f"/proc/{os.getppid()}/ns/mnt"):
        raise RuntimeError("Qualification mounts require an independent private mount namespace")
    if (root / "owner").read_text(encoding="ascii") != "nerva-root-identity-qualification\n":
        raise RuntimeError("Qualification ownership marker is unavailable")
    mounts: list[Path] = []
    try:
        for image, target, options in [
            (root / "source.img", root / "left", "loop,noload,nodev,nosuid,noexec"),
            (root / "clone.img", root / "right", "loop,ro,noload,nodev,nosuid,noexec"),
        ]:
            command(["mount", "--types", "ext4", "--options", options, str(image), str(target)])
            mounts.append(target)
        command(["mount", "--bind", str(root / "left"), str(root / "alias")])
        mounts.append(root / "alias")
        command(["mount", "--types", "tmpfs", "--options", "size=1m,nodev,nosuid,noexec", "tmpfs", str(root / "unsupported")])
        mounts.append(root / "unsupported")
        environment = {
            **os.environ,
            "NERVA_ROOT_IDENTITY_TEST_PARENT": str(root / "left"),
            "NERVA_ROOT_IDENTITY_CLONE_LEFT": str(root / "left"),
            "NERVA_ROOT_IDENTITY_CLONE_RIGHT": str(root / "right"),
            "NERVA_ROOT_IDENTITY_BIND_ALIAS": str(root / "alias"),
            "NERVA_ROOT_IDENTITY_UNSUPPORTED": str(root / "unsupported"),
        }
        command([str(executable), "--ignored", "--nocapture", "--test-threads=1"], environment=environment, output=True)
    finally:
        failures = 0
        for target in reversed(mounts):
            try:
                command(["umount", "--", str(target)])
            except (OSError, RuntimeError, subprocess.SubprocessError):
                failures += 1
        if failures:
            raise RuntimeError("Private mount cleanup failed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test-executable", type=Path, required=True)
    parser.add_argument("--parent", type=Path, default=Path("/root"))
    parser.add_argument("--mount-owner", type=Path, help=argparse.SUPPRESS)
    arguments = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError("Private mount qualification requires local administrator authority")
    executable = arguments.test_executable.resolve(strict=True)
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise RuntimeError("The existing descriptor test executable is unavailable")
    os.umask(0o077)
    if arguments.mount_owner is not None:
        namespace(arguments.mount_owner.resolve(strict=True), executable)
        return
    owner = OwnedQualification(arguments.parent)
    root = owner.root
    try:
        (root / "owner").write_text("nerva-root-identity-qualification\n", encoding="ascii")
        for name in ["left", "right", "alias", "unsupported"]:
            (root / name).mkdir(mode=0o700)
        source = root / "source.img"
        with source.open("xb") as image:
            image.truncate(16 * 1024 * 1024)
        # Only this disposable image permits generation mutation; installed filesystems are unchanged.
        command(["mkfs.ext4", "-q", "-F", "-O", "^metadata_csum", str(source)])
        clone = root / "clone.img"
        shutil.copyfile(source, clone)
        command(["unshare", "--mount", "--propagation", "private", "--", sys.executable,
                 "-I", "-B", str(Path(__file__).resolve()), "--test-executable", str(executable),
                 "--mount-owner", str(root)], output=True, group=True, receipt=owner.namespace)
    finally:
        owner.cleanup()
    print("NERVA_ROOT_IDENTITY_QUALIFICATION mounts_removed=true loops_removed=true temporary_files_removed=true")


if __name__ == "__main__":
    def interrupted(_signum: int, _frame: FrameType | None) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError, KeyboardInterrupt):
        print("Root identity qualification failed; no protocol or installed helper was changed", file=sys.stderr)
        sys.exit(1)
