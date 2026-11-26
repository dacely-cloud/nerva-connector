#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
# SPDX-License-Identifier: LicenseRef-Proprietary
"""Produce one reviewed lock/target-bound notice asset using the existing offline Cargo cache."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "x86_64-apple-darwin", "aarch64-apple-darwin"])
    args = parser.parse_args()
    target = os.environ.get("CARGO_TARGET_DIR")
    if target is None or not Path(target).is_dir():
        raise RuntimeError("Set CARGO_TARGET_DIR to the approved existing target directory")
    result = subprocess.run(
        ["cargo", "metadata", "--offline", "--locked", "--format-version", "1", "--manifest-path", "native/Cargo.toml", "--filter-platform", args.target],
        check=True, capture_output=True, text=True, timeout=30,
    )
    if len(result.stdout.encode()) > 4194304:
        raise RuntimeError("Cargo metadata exceeds the notice-generation bound")
    metadata = json.loads(result.stdout)
    nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
    selected = set()
    pending = [metadata["resolve"]["root"]]
    while pending:
        identity = pending.pop()
        if identity in selected:
            continue
        selected.add(identity)
        for dependency in nodes[identity]["deps"]:
            if any(kind["kind"] != "dev" for kind in dependency["dep_kinds"]):
                pending.append(dependency["pkg"])
    packages = sorted(
        [package for package in metadata["packages"] if package["id"] in selected and package["source"] is not None],
        key=lambda package: (package["name"], package["version"]),
    )
    # Reviewed new RustCrypto dependencies offer the complete MIT alternative.
    # Existing dependencies retain every previously collected license text.
    mit_choices = {("block-buffer", "0.10.4"), ("cfg-if", "1.0.5"),
                   ("cpufeatures", "0.2.17"), ("crypto-common", "0.1.7"),
                   ("digest", "0.10.7"), ("sha2", "0.10.9"), ("typenum", "1.20.1")}
    texts = {}
    entries = []
    for package in packages:
        root = Path(package["manifest_path"]).parent
        files = sorted(path for path in root.iterdir() if path.is_file() and path.name.upper().startswith(("LICENSE", "COPYING", "NOTICE", "COPYRIGHT")))
        if package["license_file"]:
            declared = root / package["license_file"]
            if declared not in files:
                files.append(declared)
        if not files or package["license"] is None:
            raise RuntimeError("Review missing license metadata/text for " + package["name"])
        license_name = package["license"]
        if (package["name"], package["version"]) in mit_choices:
            chosen = root / "LICENSE-MIT"
            if license_name != "MIT OR Apache-2.0" or chosen not in files:
                raise RuntimeError("Review changed explicit MIT license choice")
            # Omit only the unchosen alternative; keep LICENSE, NOTICE and COPYRIGHT assets.
            files = [path for path in files if path.name != "LICENSE-APACHE"]
            license_name = "MIT (selected from MIT OR Apache-2.0)"
        references = []
        for path in files:
            with path.open('rb') as handle:
                data = handle.read(131073)
            if len(data) > 131072 or b"*/" in data:
                raise RuntimeError("Unsupported embedded license text")
            # Embedded product notices use canonical LF while preserving full license text.
            data = data.replace(b"\r\n", b"\n")
            digest = hashlib.sha256(data).hexdigest()
            texts.setdefault(digest, data.decode("utf8"))
            references.append(digest)
        entries.append((package["name"], package["version"], license_name, references))
    lines = [
        "Native helper third-party notices",
        "Cargo.lock SHA-256: " + hashlib.sha256(Path("native/Cargo.lock").read_bytes().replace(b"\r\n", b"\n")).hexdigest(),
        "Target: " + args.target, "",
        "Locked non-development dependency graph for the " + ("macOS" if args.target.endswith("-apple-darwin") else "Linux") + " helpers.", "",
    ]
    for name, version, license_name, references in entries:
        lines.extend([name + " " + version + " (" + license_name + ")", "License text SHA-256: " + ", ".join(references), ""])
    for digest, text in texts.items():
        lines.extend(["===== License text " + digest + " =====", text, ""])
    output = "\n".join(lines).encode()
    if len(output) > 65536:
        raise RuntimeError("Review native notice size before publication")
    # Intel Linux keeps the original release file name; every other target has its own notice file.
    destination = Path("native/THIRD-PARTY-NOTICES.txt" if args.target == "x86_64-unknown-linux-gnu" else "native/THIRD-PARTY-NOTICES." + args.target + ".txt")
    temporary = destination.with_name(destination.name + ".partial")
    owned = False
    try:
        with temporary.open("xb") as handle:
            owned = True
            handle.write(output)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        directory = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if owned:
            temporary.unlink(missing_ok=True)
    print(json.dumps({"packages": len(entries), "licenseTexts": len(texts), "noticeBytes": len(output)}))


if __name__ == "__main__":
    main()
