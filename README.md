<div align="center">

<img src="https://raw.githubusercontent.com/dacely-cloud/nerva-connector/main/assets/windows/nerva-connector-logo.png" alt="Nerva" width="128" height="128" />

# Nerva Connector

### Your computer, connected to Nexa.

<sub>Open apps, work with files and use the desktop on Windows, macOS and Linux, with the access you choose.</sub>

<br/>

[![Windows native runtime](https://github.com/dacely-cloud/nerva-connector/actions/workflows/windows-state.yml/badge.svg)](https://github.com/dacely-cloud/nerva-connector/actions/workflows/windows-state.yml)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-ff7a00?labelColor=0e1520)](#install)
[![Node.js](https://img.shields.io/badge/Node.js-26-5fa04e?labelColor=0e1520&logo=nodedotjs&logoColor=white)](https://nodejs.org/)

<br/>

<img src="https://img.shields.io/badge/TypeScript-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
<img src="https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white" alt="Rust" />
<img src="https://img.shields.io/badge/C%23-512bd4?style=for-the-badge" alt="C#" />

<br/>
<br/>

[Install](#install) · [First start](#first-start) · [Development & deployment](DEPLOYMENT.md)

</div>

---

## Introduction

Nerva Connector lets Nexa use your computer when you ask it to: open programs, read and write files, look at the
screen and use the mouse and keyboard. Link your computer to your Nerva account, choose what Nexa can do and
pick a folder for its work. Access lasts while the connector runs, and you can turn off full computer access
at any time.

## Install

### Windows

1. Download `Nerva-Connector-Setup-<version>-x64.exe` (`-arm64.exe` for ARM PCs).
2. Run it. If Windows says **Windows protected your PC**, click **More info**, then **Run anyway**.
3. Choose a writable installation folder with **Browse…** if you want a custom location, then click **Install**. No administrator rights are needed. Check **Start Nerva Connector in the background when I
   sign in** if Nexa should be able to use this computer whenever it is on.

Nerva Connector is added to the Start menu (and the desktop, if you leave that checked) and opens when setup
finishes. Continue with [First start](#first-start).

### macOS

1. Download `Nerva-Connector-Setup-<version>-arm64.dmg` for Apple Silicon, or `-x64.dmg` for an Intel Mac.
2. Open the disk image and drag **Nerva Connector** to **Applications**, or another folder you choose.
3. Open **Nerva Connector**. It opens its setup and connection console in Terminal. Node is included.

Current macOS builds are signed locally for bundle integrity. Public distribution with Gatekeeper trust requires
the publisher's Developer ID signature and notarization; the build does not claim those are present.

So Nexa can see the screen and use the mouse and keyboard, allow **Screen Recording** and **Accessibility** for
Terminal in **System Settings → Privacy & Security**, then quit and reopen the connector.

### Linux

Download `Nerva-Connector-Setup-<version>-x64.run` (`-arm64.run` on ARM64 Linux), then run:

```sh
sh ./Nerva-Connector-Setup-0.1.2-x64.run
```

It installs for your account without administrator rights, Node, npm or a compiler. Open **Nerva Connector** from
the applications menu, or run `~/.local/lib/nerva-connector/nerva-connector`. A desktop terminal emulator is needed
for the menu shortcut. To choose another program location, add `--destination "/absolute/path/Nerva Connector"`.
Use `--no-shortcuts` on a machine without a desktop. Close the connector before manually running another installer.

## First start

The connector asks a few questions. Use the arrow keys and Enter; Esc goes back.

1. **Get started.**
2. **Name** this computer. This is the name you see in Nerva.
3. **What Nexa can do:**
    - **Just connect for now**: Nexa sees that the computer is online, nothing more.
    - **Full computer**: Nexa can open programs, read and write files, see the screen and use the mouse and
      keyboard. You can turn this off at any time with `/disable-host`.
4. **Folder** Nexa works in. Press Enter to keep `Nexa Tasks` in your home folder.
5. **At sign-in** (Windows): start in the background when you sign in, or only when you open it.
6. **Review** your choices and press Enter.
7. **Link** the computer to your account: the connector shows a code. Open
   **https://nervalabs.com/chat/connectors**, enter the code and approve.

The screen then shows **Connected**. Nexa can use the computer while the connector runs: on Windows, while its icon
is next to the clock; on macOS and Linux, while the window is open.

## Everyday use

Open the connector:

- **Windows:** click the Nerva icon next to the clock (it may be under the **^** arrow), or Start menu →
  **Nerva Connector**.
- **macOS:** Applications → **Nerva Connector**.
- **Linux:** open **Nerva Connector** from the applications menu, or run its installed `nerva-connector` launcher.

On Windows, Nerva Connector opens its own classic console window. Minimize it to keep the connection running
in the background. Click the Nerva icon next to the clock to reopen it. Right-click the icon to check for
updates, turn **Start when I sign in** on or off, or quit. You can also type `/quit` to stop the connector.

The console header shows the installed version. The screen also shows whether the computer is connected,
what Nexa is doing, which programs it started are still running, and the latest 100 completed requests
from this run. Press Tab or type `/activity` to
browse history. Use ↑/↓ to scroll line by line, Page Up/Page Down to move a page, and Home/End to jump
to the newest or oldest lines. In terminals that send arrow keys for mouse-wheel scrolling in full-screen
apps, the wheel scrolls the history too.

Type `/` to open the menu:

| Command         | What it does                                        |
| --------------- | --------------------------------------------------- |
| `/activity`     | Browse recent activity on this computer             |
| `/settings`     | Change the name, the folder or what Nexa can do     |
| `/disable-host` | Turn off full computer access                       |
| `/reconnect`    | Connect again now                                   |
| `/startup`      | Windows: start in the background at sign-in, or not |
| `/update`       | Check for an update and install it automatically    |
| `/log`          | Why recent connections ended, and the log file      |
| `/system`       | This computer's processor, memory and graphics      |
| `/pair`         | Link the computer, if it is not linked              |
| `/logout`       | Unlink this computer from your account              |
| `/quit`         | Close the connector                                 |

## Update

- **Windows:** updates install by themselves. Nerva Connector checks at startup and every hour, installs a new
  version and starts again, keeping this computer's link and settings. Right-click its icon and choose **Check for
  updates**, or type `/update`, to check now. The result appears where you requested it. If an older installer has
  a TLS error in `supervisor.log`, run the current setup file once to repair the updater.
- **macOS and Linux:** current desktop installers check after one minute and every hour while the connector
  is open. Use `/update` to check now. They verify the publisher's signature, download in the background, then
  restart the connector on the newer version. Custom installation locations are preserved. A failed installation
  restores the previous program; your account link, permissions and history remain separate.

Older Mac and Linux packages need one manual installation of the current package to enable automatic updates.
On macOS, quit the connector and replace the app from the disk image. On Linux, close it and run the newer
installer with the same `--destination`, if customized. Install the Mac app on your writable local disk first;
an app opened directly from its read-only disk image cannot update itself.

## Uninstall

To remove the computer from your account as well, open the connector and type `/logout` first.

- **Windows:** Settings → Apps → Installed apps → **Nerva Connector** → Uninstall. The link and settings stay in
  `%LOCALAPPDATA%\Nerva\Connector`; delete that folder to remove them.
- **macOS:** delete **Nerva Connector.app**.
- **Linux:** delete the installed program folder (`~/.local/lib/nerva-connector` by default) and
  `~/.local/share/applications/nerva-connector.desktop`.

On macOS and Linux, the account link and settings stay in `~/.local/share/nerva-connector`.

## Troubleshooting

**A computer action failed or an app did not open.** Type `/log`. Failed native operations include their tool,
failure reason and Windows error code when available. The log does not include typed text or screenshot bytes.
An app is marked as opened only after its window is observed; missing, ambiguous and unconfirmed launches stay
explicit. Windows application lookup also checks Start menu shortcuts, App Paths and installed-package entries.

**Screen snapshots ask for an updated approval.** Install the latest connector, then open `/settings`,
choose **Full computer** and approve the review. Updates that add computer tools need a new local approval;
your account link and activity history stay in place.

**It keeps disconnecting.** Type `/log` to see why. The full log is at:

- Windows: `%LOCALAPPDATA%\Nerva Connector\Logs\connection.log`
- macOS: `~/Library/Logs/Nerva Connector/connection.log`
- Linux: `~/.local/state/nerva-connector/connection.log`

**It can't sign in or keeps dropping right after connecting.** Check the computer's clock. On Windows open
Settings → Time & language → Date & time and click **Sync now**. A clock more than a few seconds off cannot sign in.

**Windows: it does not start, or an update did not install.** See
`%LOCALAPPDATA%\Nerva Connector\Logs\supervisor.log`, which records each start, stop and update. An update
replaces the installation folder, which fails while another program has that folder as its current directory.
Before 0.1.21 every application Nexa opened started there, so close those applications and choose **Check for
updates** again. From 0.1.21 the connector and the applications it opens start in your user profile folder.

**"Nerva Connector is already running on this computer".** Close the other connector window, or stop it in Task
Manager, and open it again.

**"Windows folder permissions block the connector".** The connector could not verify its protected storage.
When another account has write access along the Connector's `AppData\Local` storage path, the connector uses
a protected `%USERPROFILE%\.nerva-connector-state` directory and keeps using it on later starts.
It leaves the old directory and its files in place. If your pairing was saved there, pair once in the protected directory.

Startup also checks the former `%USERPROFILE%\\.local\\share\\nerva-connector` location for an existing
identity. Shared permissions on unrelated `.local` or `share` folders do not block startup when that
identity is absent. This check never reads or imports legacy credentials. An existing identity requires
explicit migration; inaccessible paths and junctions remain errors, and existing permissions are never rewritten.

The outer installation folder (`Nerva\Connector` or `.nerva-connector-state`) may have additional
read-only directory permissions, such as those reapplied by Codex's Windows sandbox. These permissions
can expose entry names and folder metadata, but do not grant access to file contents. Every state file
and child directory still requires protected user/SYSTEM-only permissions and is created without
inheriting the outer folder's grants. Extra create, write, delete, ownership or permission-changing
rights on the outer folder remain errors, as does extra read access on private files or child directories.

The connector names the rejected folder and how to fix it below this message, followed by its
`storageCheck`, which also appears in `%LOCALAPPDATA%\Nerva Connector\Logs\connection.log`. It identifies which
part of the path was rejected and which check failed. These Command Prompt commands show the permissions for the
default storage:

```bat
icacls "%LOCALAPPDATA%"
icacls "%USERPROFILE%\AppData"
icacls "%USERPROFILE%"
icacls "%LOCALAPPDATA%\Nerva"
icacls "%LOCALAPPDATA%\Nerva\Connector"
icacls "%USERPROFILE%\.nerva-connector-state"
```

Share the storage check and the relevant permissions with support or your Windows administrator. Keep the
existing Connector folder intact so that any saved pairing and credentials are preserved.

**"A local check stopped this computer's connector access".** A part of the connector that holds full-computer,
file or program access stopped itself because a storage write failed or the saved approval could not be read, was
changed or was removed. Programs it had started are stopped. The connector reloads its saved approval and history
by itself and reconnects; an operation that started but has no result is reported as interrupted and never runs
again. If the cause remains, the reload stops with its own explanation, such as a folder permission. A
`host-consent-check-failed` line in `connection.log` names what the full-computer approval check found and, for a
Windows storage refusal, its `storageCheck`.

**"The connector's Windows storage helper stopped".** The helper that guards the connector's private files exited
or stopped answering for 30 seconds. The connector starts a new one and reconnects by itself, and your saved pairing
and keys stay as they were. Time the connector's own event loop spent blocked (a `stall` line in `connection.log`)
does not count toward those 30 seconds. A `stall` line's `cpuMs` tells the two kinds of stall apart: close to
`blockedMs` means the connector was computing; near zero means it was not running at all, because the computer
slept, Windows suspended it, or its console window was waiting, as while text is selected in it. **"The compiled Windows helper could not start"** means the helper exited
before it answered at all. Check that .NET Framework 4.x is installed and that security software allows
`nerva-connector-state.exe`.

**Nexa can't see the screen on a Mac.** Allow **Screen Recording** and **Accessibility** for Terminal (see
[macOS](#macos)), then restart the connector.

## For developers

```sh
npm ci
npm run build     # build/nerva-connector.mjs and its helpers
npm test
npm run check     # typecheck, lint, format, build and tests
```

Building desktop installers, signed managed releases, the Windows update feed and running the connector as a Linux service
are covered in [DEPLOYMENT.md](DEPLOYMENT.md).
