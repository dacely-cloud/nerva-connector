# Deploying Nerva Connector

How to build signed connector releases, publish them and install them on the machines you manage. Replace every
example host, path and identifier with your deployment's own values. Keep signing keys and release configuration
outside the repository and outside the directories you publish.

## Windows

### Setup program

Install NSIS 3 (`makensis`), then build with the .NET Framework compiler on Windows or Mono on Linux/macOS.
`NERVA_MAKENSIS` can select an absolute path to the installed NSIS compiler:

```sh
npm ci
npm run build:windows-installer                # build/Nerva-Connector-Setup-<version>-x64.exe
npm run build:windows-installer -- --arch arm64
```

The setup program bundles the Windows connector, its native helpers and the official Node.js `node.exe`, pinned by
SHA-256 in `script/ConnectorWindowsNodeRuntime.ts`. It installs into `%LOCALAPPDATA%\Programs\Nerva Connector`
without administrator rights and adds the Start menu entry, the shortcuts and the Settings → Apps entry.
The setup window also accepts another writable installation folder; updates remember the selected location.
A fresh destination must be empty so setup cannot replace unrelated files. To select it from the command line,
use `Setup.exe "/D=D:\Apps\Nerva Connector"`.

The standard NSIS uninstaller removes the installed program files and preserves account links and settings
in their separate data directory.

| Command                                      | Effect                 |
| -------------------------------------------- | ---------------------- |
| `Nerva-Connector-Setup-<version>-x64.exe /S` | Install without asking |
| `"Uninstall Nerva Connector.exe" /S`         | Remove without asking  |

`Nerva Connector.exe` is the background program. It runs the connector in a console window that it hides and shows
from the notification-area icon, starts it again if it crashes, and installs updates.

### Signed updates

Installed copies update themselves from a feed you host. Create the update key once and commit
`assets/windows/updates.json`, which holds the feed URL and the public key:

```sh
npm run create:windows-update-key -- --key /secure/update-key.pem --feed https://downloads.example.com/connector/windows/
```

For each release, raise `version` in `package.json`, then build and sign it:

```sh
npm run release:windows -- --key /secure/update-key.pem
```

Upload the contents of `build/windows-update` to the feed URL, the setup programs before `latest.json` and
`latest.json.sig`. Installed copies take only a newer version whose `latest.json` was signed by that key. A build
without `assets/windows/updates.json` never checks for updates.

## Linux

### Prepare a release

A Linux release is a signed set of files that installs without a checkout, npm or a compiler: its own Node runtime,
the bundled connector, the two native helpers and an installer. Prepare it on a trusted publisher machine:

```sh
npm ci
CARGO_TARGET_DIR=/path/to/cargo-target npm run build:native
npm run check
npm run prepare:release -- --config /secure/connector-release.json
```

The configuration has exactly these fields:

```json
{
    "releaseId": "2026-11-17",
    "revision": "1",
    "expiresAtMs": "<UTC epoch milliseconds, at most 90 days ahead>",
    "platform": "linux",
    "releaseKeyFile": "/secure/release-private.json",
    "nodeFile": "/path/to/node",
    "nodeLicenseFile": "/path/to/NODE-LICENSE",
    "authorityId": "connector-cloud",
    "authorityPublicKeyFile": "/secure/gateway-public.json",
    "endpoints": ["wss://connect.example.com/v1/connector/tunnel"],
    "verificationUri": "https://nervalabs.com/chat/connectors",
    "serverCaFile": null,
    "downloadBaseUrl": "https://downloads.example.com/connector/linux/2026-11-17/",
    "npmVersion": "0.1.0"
}
```

The release key is a dedicated offline key in the connector's private identity format, separate from the gateway's
key. The Node runtime must be Node 26.3.1 or newer in the 26.x line, or Node 24.17 or newer in the 24.x line.
Preparation checks the runtime's actual Node and Undici versions, then signs the release manifest.

Serve exactly these files from `downloadBaseUrl`, and never change a published URL while installations may still
download from it: `node`, `NODE-LICENSE`, `nerva-connector.mjs`, `nerva-connector-files`,
`nerva-connector-exec`, `nerva-connector-host-worker.mjs`, `THIRD-PARTY-NOTICES.txt`, `release.json` and
`install-connector.sh`.

`install-connector.sh` pins the signed manifest and the release key, so it is what users trust. Hand it out through
a channel you control, such as your own HTTPS site, and never take it, or a key, from an untrusted copy.

### Install

```sh
sh ./install-connector.sh
```

The installer downloads the pinned files, checks their sizes and SHA-256 digests and verifies the release
signatures before running anything. It then creates the device key, shows a code to approve at `verificationUri`
and runs the connector in the foreground. It installs into `$HOME/.local/share/nerva-connector` and does not
replace the system Node.

| Option                       | Effect                                                                      |
| ---------------------------- | --------------------------------------------------------------------------- |
| `--destination <directory>`  | Install somewhere else; works with `HOME` unset                             |
| `--release-directory <path>` | Install from a local copy of the release files instead of downloading them  |
| `--install-only`             | Install without linking or starting; cannot be combined with `--service`    |
| `--service system`           | Run as a system service (run as root)                                       |
| `--service user`             | Run as a service of the current user's systemd user manager                 |
| `--native-config <file>`     | Also prepare native file and command access ([Native setup](#native-setup)) |
| `--quiet`                    | Print only the structured result                                            |

After `--install-only`, link and run the installed copy:

```sh
root="$HOME/.local/share/nerva-connector"
"$root/node" "$root/nerva-connector.mjs" pair --config "$root/pairing.json"
"$root/node" "$root/nerva-connector.mjs" run --config "$root/state/device.json"
```

If the approval code expires, request a new one with
`"$root/node" "$root/nerva-connector.mjs" renew-pairing --config "$root/pairing.json"`. It keeps the device key and
history.

### Run as a service

`--service system` or `--service user` links the machine, then registers, enables and starts one systemd unit that
keeps the connector running. A user service survives logout only if the machine's user-manager or lingering policy
allows it. Manage an existing service with the installed copy:

```sh
"$root/node" "$root/nerva-connector.mjs" service status --scope system --directory "$root"
```

| Operation | Effect                                                              |
| --------- | ------------------------------------------------------------------- |
| `status`  | Show the unit's load, active and enabled state, PID and restarts    |
| `connect` | Link using the existing device key, then install and start the unit |
| `install` | Install and enable the unit for an already linked installation      |
| `start`   | Start the unit                                                      |
| `stop`    | Stop the unit and wait until it has exited                          |
| `remove`  | Stop, disable and remove the unit; the device key and settings stay |

`--scope` must match the scope the service was installed with. To switch scope, `remove` the service first.

### Native setup

`--native-config` sets up file and command access while the service is installed. It needs `--service system`,
root and Ubuntu Server 26.04, and loads the connector's AppArmor profiles when the service starts. The file is a
JSON request prepared by an administrator:

| Field                   | Meaning                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `installationDirectory` | The signed installation directory                                                    |
| `sourceDirectory`       | A protected directory holding the runtime files, outside every workspace             |
| `runtimeFiles`          | Each runtime file's path, `sizeBytes`, `sha256` and `mode` (`executable` or `data`)  |
| `files`                 | File access: `mode` (`read-only` or `read-write`), `revision` and `roots`, or `null` |
| `execution`             | Allowed programs, argument rules, roots and resource limits, or `null`               |

A runtime file such as `/usr/bin/tool` is copied from `<sourceDirectory>/usr/bin/tool`; only paths under `/usr`,
`/opt`, `/lib`, `/lib64` and `/etc` are allowed. A request names at most 256 runtime files, each at most 256 MiB and 1 GiB in total. Every allowed program must be one of the listed executable files.
Without `--native-config`, file and command access stay off.

### npm package

`prepare:release` also writes an npm package to `build/npm/`. Installing it gives the `nexa` command; the first
`nexa connector` runs the release installer. Check what it contains before packing it:

```sh
npm pack ./build/npm --dry-run --ignore-scripts --json
npm pack ./build/npm --ignore-scripts --pack-destination /path/to/output
```

## Editing and checking native source

C# and Rust use four spaces, LF line endings and a 100-column formatting width. The
repository's `.editorconfig`, CSharpier configuration and `native/rustfmt.toml` are the
shared formatting rules. VS Code recommends the CSharpier and Rust Analyzer extensions
and formats both languages on save.

Restore the pinned C# formatter with `dotnet tool restore` using a .NET 10 SDK. The
formatter runs only during development; Windows helpers still compile as C# 5 for
.NET Framework 4.x. `script/ConnectorWindowsSources.ts` lists each complete source group
for builds and tests; include new helper files there.

```sh
npm run format:csharp
npm run format:rust
npm run format:native:check
npm run benchmark:csharp
```

The benchmark runs the actual state parser on plain requests, escaped Windows paths and
128 KiB write data, after checking valid and malformed requests. It prints seven timed
rounds per workload and removes its temporary compiler output. Windows runs the fixture
directly; other development hosts need Mono and `mcs`.

Before opening the Rust workspace or running Cargo builds, tests or Clippy, export
`CARGO_TARGET_DIR` pointing to an existing reusable target directory. Rust Analyzer
inherits that environment, so editor checks and command-line builds share the same
artifacts. Formatting alone creates no Cargo target directory.
