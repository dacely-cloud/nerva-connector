# Windows native confinement qualification

This is an offline, fixed-operation probe for the next Windows filesystem boundary.
It does **not** enable Windows connector files or commands. Those capabilities remain
disabled. Pairing and system inventory keep their existing implementation.

From the connector source checkout:

```sh
npm run build:windows:qualification
```

This creates four stable outputs in the existing `build/` directory:

| Output                                     | Purpose                                                      |
| ------------------------------------------ | ------------------------------------------------------------ |
| `nerva-connector-file-worker.exe`          | Fixed canary worker; no state-owner or DPAPI implementation  |
| `nerva-connector-file-worker.json`         | Worker executable size, SHA-256 and source SHA-256           |
| `nerva-connector-files-qualification.exe`  | Trusted local broker with the worker digest compiled into it |
| `nerva-connector-files-qualification.json` | Broker executable size, SHA-256 and source SHA-256           |

Compilation uses the existing build-time .NET Framework compiler on Windows, or Mono's
C#5 compiler for Linux cross-compilation. The normal connector does not invoke a compiler,
PowerShell or this probe. No packages or additional runtime dependencies are copied.
These are development qualification artifacts, **not** a signed Windows capability release.
Changing either the broker or its compiled-in worker pin requires another reviewed build.

On an actual Windows machine, run:

```sh
npm run qualify:windows
```

Or run the already compiled broker beside its pinned worker:

```text
build\nerva-connector-files-qualification.exe --qualify
```

The broker launches only the fixed worker, with zero requested AppContainer capabilities,
the less-privileged AppContainer policy and child-process restriction. It supplies a
fresh environment and an explicit handle list containing only a readonly canary handle
and the output pipe; no root directory, identity, controller credential, job or process
handle is inherited. It independently reads the suspended child's token, package SID,
effective child-process policy, job membership and configured limits **before resuming it**.

Pinning the original handles alone does not prove what a pathname-based `CreateProcess`
actually selected. Before creation, the broker captures the pinned image's physical native
name and volume/128-bit file ID. While the child is still suspended, it queries that child's
actual native image name, requires an exact match, reopens that physical NT name without a
DOS-drive lookup or reparse traversal, and compares both its identity and the original
pinned snapshot. A different physical volume, file ID, path or unexpected case/short-name
representation is refused before resume. These checks use
[GetFinalPathNameByHandleW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew)
and [QueryFullProcessImageNameW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew).
Portable tests model matching identities, substituted images, drive remaps, case and 8.3
name mismatches; actual NT image naming and live alias-race tests still require Windows.

The first worker must successfully read its granted handle and prove that the same
readonly handle cannot write, an omitted inheritable handle is unavailable, a private
ambient canary cannot be opened for reading or writing, an owned loopback listener
cannot be reached, and its own harmless child cannot be created. The broker first
checks that its ordinary token can reach that listener. The worker must return the exact
fresh canary digest, exit normally, and leave all three canary files unchanged.
Child creation counts as denied only for `ERROR_ACCESS_DENIED` (5) or
`ERROR_CHILD_PROCESS_BLOCKED` (367), as defined by the
[Windows SDK error header](https://raw.githubusercontent.com/microsoft/win32metadata/main/generation/WinSDK/RecompiledIdlHeaders/shared/winerror.h).
The unrelated service-SID error 1290 and other launch errors cannot satisfy the probe.

A second worker reports readiness and waits indefinitely. Closing its job must terminate
that already running process. Each worker has a 5-second wall deadline, 2 seconds of
process/job CPU time, 128 MiB of process/job committed-memory limits, one active process
and at most 512 bytes of output. These configured resource limits are read back;
CPU and memory exhaustion stress tests are still separate work. Workers run sequentially.
Every normal failure terminates and joins the owned process before releasing profile state.

The probe uses only `%LOCALAPPDATA%\Nerva\Connector\qualification`, plus a fresh owned
AppContainer profile. State directories retain the existing owner/SYSTEM private DACL
policy. Physical-volume anchoring, component-relative opens, reparse rejection and
single-link regular-file checks pin image and fixture paths. The worker is copied only
into its own new AppContainer profile; customer folders and system ACLs are not changed.
That profile is not a customer's workspace or a general program sandbox.

Successful cleanup removes canaries, the profile, its worker copy and the intent. The
private qualification directory and one stable kernel-lock file are intentionally retained.
An owned completed profile intent can be reconciled after a process crash. An unconfirmed
intent refuses further attempts, avoiding deletion of unproven ownership or an accumulation
of replacement profiles; investigate that owned slot before retrying. Existing device keys,
pairing state, policies and mutation journals are never reset or edited.

Success is an exact `qualified: true` receipt with `scope: "lpac-canaries-only"` and the
worker digest. Startup, CLR loading, token verification, any denied-canary ambiguity,
deadline or cleanup failure returns a nonzero exit and a fixed failure phase. There is
no full-user fallback. A Linux or Mono run returns `windows-required`, never success.

## What this does not qualify

Linux cross-compilation and portable policy/ABI tests cannot establish NTFS, LPAC, process,
job or ACL behavior. **No actual Windows run has been observed in this environment.** In
particular, whether the chosen .NET Framework runtime starts under this zero-capability
LPAC policy remains a real runtime gate. A refusal must be diagnosed without removing
the restrictions merely to produce a green receipt.

Even a successful probe is only the first boundary test. Windows file operations still
need granted-root enrollment and physical identity/overlap rules; bounded directory
resolution; Windows metadata and permission semantics; readonly kernel enforcement;
durable signed mutation journals; atomic create/replace, staged uploads and crash recovery;
hostile rename/reparse/hardlink/ACL race tests; and signed Windows release/install support.
Arbitrary command execution requires a separate sandbox and executable/dependency policy.
An argv allowlist or a readonly label does not provide that isolation.

The implementation follows Microsoft's [AppContainer launch guidance](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer),
[process attribute API](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
and [job limits](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-setinformationjobobject).
The broker's canary tests are project qualification requirements; the references alone
do not establish that this implementation is secure.
