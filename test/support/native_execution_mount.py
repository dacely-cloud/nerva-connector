#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Nerva contributors
# SPDX-License-Identifier: LicenseRef-Proprietary

"""Qualify the current TypeScript pinned-file preflight in private owned exec/noexec mounts."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import shutil
import signal
import sys
from types import FrameType
from urllib.parse import quote

REPOSITORY = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "nerva_owned_mount_fixture", Path(__file__).resolve().parent / "opened_root_identity.py"
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Owned mount fixture support is unavailable")
FIXTURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FIXTURE)

HOOK = r"""
import {registerHooks} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {pathToFileURL,fileURLToPath} from 'node:url';
const {transformSync}=await import(pathToFileURL(process.argv[2]+'/node_modules/rolldown/dist/utils-index.mjs').href);
const source=pathToFileURL(process.argv[2]+'/src/').href;
registerHooks({resolve(specifier,context,next){
 if(context.parentURL?.startsWith(source)&&specifier.startsWith('.')&&specifier.endsWith('.js')){
  const candidate=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);
  if(existsSync(candidate))return next(candidate.href,context);
 }
 return next(specifier,context);
},load(url,context,next){
 if(url.startsWith(source)&&url.endsWith('.ts')){
  const result=transformSync(fileURLToPath(url),readFileSync(new URL(url),'utf8'));
  if(result.errors.length)throw new Error('Source qualification transform failed');
  return{format:'module',shortCircuit:true,source:result.code};
 }
 return next(url,context);
}});
"""

PROBE = r"""
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,rename,writeFile,chmod} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const [owned,repo]=process.argv.slice(1);
const {ConnectorNativeExecutable:Verifier}=await import(pathToFileURL(repo+'/src/runtime/ConnectorNativeExecutable.ts').href);
const {ConnectorNativeExecutionError:Failure}=await import(pathToFileURL(repo+'/src/runtime/ConnectorNativeExecutionError.ts').href);
const good=owned+'/exec/program',bad=owned+'/noexec/program';
const digest=createHash('sha256').update(await readFile(good)).digest('hex');
const expected=new Failure().message;
const deny=async file=>{
 await assert.rejects(Verifier.assertRunnable(file),error=>error instanceof Failure&&error.message===expected&&!error.message.includes(owned));
 assert((await file.stat()).isFile());
};
await using executable=await Verifier.open(good,digest);
await Verifier.assertRunnable(executable);
const archive=await Verifier.open(bad,digest);
try{await deny(archive);}finally{await archive.close();}
await assert.rejects(archive.stat(),{code:'EBADF'});
await rename(good,good+'-pinned');
await writeFile(good,'not an executable',{mode:0o600});
await Verifier.assertRunnable(executable);
await chmod(good+'-pinned',0o600);
await deny(executable);
await chmod(good+'-pinned',0o700);
await Verifier.assertRunnable(executable);
console.log('NERVA_NATIVE_EXEC_PREFLIGHT '+JSON.stringify({execAccepted:true,noexecSourceVerified:true,noexecRuntimeDenied:true,pinnedObjectRetained:true,permissionsRechecked:true,borrowedOwnershipRetained:true}));
"""


def child(root: Path, node: str, original_namespace: str) -> None:
    if os.readlink("/proc/self/ns/mnt") == original_namespace:
        raise RuntimeError("An independent mount namespace is required")
    mounted: list[Path] = []
    try:
        for name, execution in [("exec", "exec"), ("noexec", "noexec")]:
            target = root / name
            target.mkdir(mode=0o700)
            FIXTURE.command(["mount", "--types", "tmpfs", "--options",
                             f"size=1m,mode=0700,nodev,nosuid,{execution}", "tmpfs", str(target)])
            mounted.append(target)
            shutil.copyfile("/usr/bin/true", target / "program")
            (target / "program").chmod(0o700)
        hook = "data:text/javascript," + quote(HOOK)
        FIXTURE.command([node, "--disable-warning=ExperimentalWarning",
                         "--import", hook, "--input-type=module", "--eval", PROBE,
                         str(root), str(REPOSITORY)], output=True)
    finally:
        failures = 0
        for target in reversed(mounted):
            try:
                FIXTURE.command(["umount", str(target)])
            except BaseException:
                failures += 1
        if failures:
            raise RuntimeError("Owned native preflight mount cleanup failed")


def main() -> None:
    if len(sys.argv) == 5 and sys.argv[1] == "--child":
        child(Path(sys.argv[2]), sys.argv[3], sys.argv[4])
        return
    if len(sys.argv) != 2:
        raise RuntimeError("One current Node executable reference is required")
    owner = FIXTURE.OwnedQualification(Path.home())
    try:
        FIXTURE.command(["unshare", "--mount", "--propagation", "private", "--",
                         sys.executable, "-I", "-B", str(Path(__file__).resolve()),
                         "--child", str(owner.root), sys.argv[1], os.readlink("/proc/self/ns/mnt")],
                        output=True, group=True, receipt=owner.namespace)
    finally:
        owner.cleanup()
    print("NERVA_NATIVE_EXEC_PREFLIGHT_CLEANUP namespace_joined=true mounts_removed=true temporary_files_removed=true")


def interrupted(_signal: int, _frame: FrameType | None) -> None:
    raise RuntimeError("Owned native preflight qualification interrupted")


if __name__ == "__main__":
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    main()
