// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { WindowsStateArtifact } from '../windows/WindowsStateArtifact.js';
import {
    ConnectorReleasePlatform,
    type ConnectorReleaseArchitecture,
    type ConnectorSignedRelease,
} from './ConnectorRelease.js';
import { ConnectorReleaseCodec } from './ConnectorReleaseCodec.js';
import { ConnectorReleaseDownload } from './ConnectorReleaseDownload.js';

/** npm retains a private cancellation pipe; a standalone redirected config has no ongoing input channel. */
export const ConnectorWindowsBootstrapControl = { None: 'none', Stdin: 'stdin-v1' } as const;
/** Runtime-accessible bootstrap cancellation modes. */
export type ConnectorWindowsBootstrapControl =
    (typeof ConnectorWindowsBootstrapControl)[keyof typeof ConnectorWindowsBootstrapControl];

/** Bootstrap framing changes require a new explicit trusted protocol. */
export const ConnectorWindowsBootstrapProtocol = {
    Current: 'nerva-connector-windows-bootstrap-v1',
} as const;

/** This public configuration is part of the trusted installer, never a network-selected source of executable pins. */
export interface ConnectorWindowsBootstrapConfiguration {
    readonly protocol: typeof ConnectorWindowsBootstrapProtocol.Current;
    readonly architecture: ConnectorReleaseArchitecture;
    readonly manifestBase64: string;
    readonly releasePublicKey: string;
    readonly baseUrl: string;
    readonly argumentsJson: string;
    readonly control: ConnectorWindowsBootstrapControl;
}

/** Windows delivery uses an ordinary precompiled helper before downloaded Node or application code can run. */
export class ConnectorWindowsBootstrap {
    /** Generate one bounded trusted bootstrap request with the complete dual-signed per-platform manifest. */
    public static configuration(
        release: ConnectorSignedRelease,
        publicKey: string,
        baseUrl: string,
    ): ConnectorWindowsBootstrapConfiguration {
        if (release.manifest.platform !== ConnectorReleasePlatform.Windows) {
            throw new Error('Windows bootstrap requires an explicit Windows release');
        }
        ConnectorReleaseCodec.read(
            JSON.parse(ConnectorReleaseCodec.encode(release).toString('utf8')),
            publicKey,
            BigInt(Date.now()),
        );
        const download: string = ConnectorReleaseDownload.directory(baseUrl).href;
        if (Buffer.byteLength(download) > 2048) {
            throw new Error('Windows bootstrap download directory exceeds its native bound');
        }
        const configuration: ConnectorWindowsBootstrapConfiguration = {
            protocol: ConnectorWindowsBootstrapProtocol.Current,
            architecture: release.manifest.architecture,
            manifestBase64: ConnectorReleaseCodec.encode(release).toString('base64'),
            releasePublicKey: publicKey,
            baseUrl: download,
            argumentsJson: JSON.stringify(['connect']),
            control: ConnectorWindowsBootstrapControl.None,
        };
        if (Buffer.byteLength(JSON.stringify(configuration)) > 131072) {
            throw new Error('Windows bootstrap configuration exceeds its bound');
        }
        return configuration;
    }

    /** A standalone administrator-distributed launcher requires neither npm nor a system Node installation. */
    public static command(): string {
        return [
            '@echo off',
            'setlocal',
            'if not "%~1"=="" (echo This trusted installer accepts no command-line options. Use the Windows npm launcher for offline setup and status. 1>&2 & exit /b 2)',
            '"%~dp0nerva-connector-bootstrap.exe" < "%~dp0release-bootstrap.json"',
            'exit /b %errorlevel%',
            '',
        ].join('\r\n');
    }

    /** npm's existing trusted Node launches only the pinned package helper; installed Node execution stays inside its native private-path owner. */
    public static launcher(
        configuration: ConnectorWindowsBootstrapConfiguration,
        artifact: WindowsStateArtifact,
        version: string,
    ): string {
        if (
            !Number.isSafeInteger(artifact.bytes) ||
            artifact.bytes < 512 ||
            artifact.bytes > 262144 ||
            !/^[a-f0-9]{64}$/u.test(artifact.sha256)
        ) {
            throw new Error('Windows bootstrap requires a pinned bounded executable');
        }
        return [
            '#!/usr/bin/env node',
            "'use strict';",
            "const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');",
            'const configuration=' + JSON.stringify(configuration) + ';',
            'const pin=' + JSON.stringify({ bytes: artifact.bytes, sha256: artifact.sha256 }) + ';',
            'const version=' + JSON.stringify(version) + ';',
            'function fail(message){process.stderr.write("Nerva Connector: "+message+"\\n");process.exitCode=1;}',
            'function help(){process.stdout.write("Nerva Connector for Windows\\n\\nUsage: nexa connector [install|connect|pair|run|status|logout|renew-pairing|system-info]\\nOptions: --directory PROTECTED_INSTALLATION_FOLDER, --release-directory OFFLINE_RELEASE, --help, --version\\nThe installation folder stores connector programs and private state. Choose the default task working directory in first-run setup.\\nRun nexa connector to install and display a pairing code. No configuration files or public keys need to be pasted.\\nForeground mode stops with Ctrl-C. File and command access require explicit local grants.\\nWindows service setup is unavailable in this release.\\n");}',
            'async function main(){',
            '  const args=process.argv.slice(2);',
            '  if(args.length>7||args.some(value=>Buffer.byteLength(value)>4096||/[\\x00-\\x1f]/u.test(value)||Buffer.from(value).toString()!==value))throw new Error("Invalid bounded connector arguments");',
            '  if(args.length===0){help();return;}',
            '  if(args[0]==="connector")args.shift();else if(args[0]!=="--help"&&args[0]!=="--version")throw new Error("Use nexa connector");',
            '  if(args[0]==="--help"||args[0]==="--version"){if(args.length!==1)throw new Error("Use help or version alone");if(args[0]==="--help")help();else process.stdout.write(version+"\\n");return;}',
            '  if(process.platform!=="win32"||process.arch!==configuration.architecture)throw new Error("This package requires its declared Windows CPU architecture");',
            '  const commands=new Set(["install","connect","pair","run","status","logout","renew-pairing","system-info"]);',
            '  let command="connect";if(commands.has(args[0]))command=args.shift();',
            '  const nativeArgs=[command],seen=new Set();',
            '  while(args.length){const option=args.shift(),value=args.shift();if((option!=="--directory"&&option!=="--release-directory")||value===undefined||seen.has(option))throw new Error("Unknown or duplicate connector option");seen.add(option);nativeArgs.push(option,value);}',
            '  const executable=path.join(__dirname,"nerva-connector-bootstrap.exe");',
            '  const leaf=fs.lstatSync(executable,{bigint:true});if(!leaf.isFile()||leaf.isSymbolicLink()||leaf.nlink!==1n||leaf.size!==BigInt(pin.bytes))throw new Error("Untrusted package bootstrap");',
            '  const fd=fs.openSync(executable,fs.constants.O_RDONLY);',
            '  try{const before=fs.fstatSync(fd,{bigint:true});if(before.dev!==leaf.dev||before.ino!==leaf.ino||before.size!==leaf.size)throw new Error("Package bootstrap changed");const bytes=Buffer.alloc(pin.bytes+1);let count=0;while(count<bytes.length){const part=fs.readSync(fd,bytes,count,bytes.length-count,null);if(part===0)break;count+=part;}const after=fs.fstatSync(fd,{bigint:true});if(count!==pin.bytes||after.size!==before.size||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs||crypto.createHash("sha256").update(bytes.subarray(0,count)).digest("hex")!==pin.sha256)throw new Error("Package bootstrap does not match its reviewed pin");}finally{fs.closeSync(fd);}',
            '  configuration.argumentsJson=JSON.stringify(nativeArgs);configuration.control="stdin-v1";const input=JSON.stringify(configuration)+"\\n";if(Buffer.byteLength(input)>131072)throw new Error("Bootstrap request exceeds its bound");',
            '  const child=cp.spawn(executable,[],{stdio:["pipe","inherit","inherit"],windowsHide:false,env:{...process.env,NODE_OPTIONS:"",NODE_PATH:"",NODE_EXTRA_CA_CERTS:"",NODE_TLS_REJECT_UNAUTHORIZED:"1"}});',
            '  let inputError=null,stopTimer=null,interrupted=0,forced=false,closed=false;',
            '  const force=()=>{if(!closed&&stopTimer===null){stopTimer=setTimeout(()=>{forced=true;child.kill();},15000);stopTimer.unref();}};',
            '  child.stdin.on("error",error=>{if(!closed){inputError=error;force();}});',
            '  const stop=code=>{if(interrupted!==0)return;interrupted=code;force();if(!child.stdin.destroyed)child.stdin.write("cancel\\n");};',
            '  const interrupt=()=>stop(130),terminate=()=>stop(143);process.once("SIGINT",interrupt);process.once("SIGTERM",terminate);',
            '  try{const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",(code,signal)=>{closed=true;if(forced)reject(new Error("Bootstrap required forced termination; private setup work or effects may remain. Retain the installation and use the same approved release for recovery"));else if(inputError!==null)reject(inputError);else if(signal!==null)reject(new Error("Bootstrap interrupted; retain the installation and retry its exact release"));else resolve(interrupted!==0?interrupted:(code===null?1:code));});child.stdin.write(input);});process.exitCode=code;}finally{closed=true;if(stopTimer!==null)clearTimeout(stopTimer);process.removeListener("SIGINT",interrupt);process.removeListener("SIGTERM",terminate);child.stdin.destroy();}',
            '}',
            'void(async()=>{try{await main();}catch(error){fail(error instanceof Error?error.message:"Bootstrap unavailable");}})();',
            '',
        ].join('\n');
    }
}
