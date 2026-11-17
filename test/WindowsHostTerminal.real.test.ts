// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { WindowsHostTerminal, type WindowsTerminalReport } from './support/WindowsHostTerminal.js';

/** Poll the actual terminal bytes without decoding or modifying transport data in the fixture. */
async function contains(terminal: WindowsHostTerminal, text: string): Promise<void> {
    for (let attempt: number = 0; attempt < 500; attempt += 1) {
        if (stripVTControlCharacters(terminal.output.toString('utf8')).includes(text)) {
            return;
        }
        await delay(20);
    }
    throw new Error('Native terminal output did not contain the expected observation');
}

it.skipIf(process.platform !== 'win32' || process.env['NERVA_WINDOWS_TERMINAL_SMOKE'] !== '1')(
    'actual ConPTY preserves native terminal bytes, input acceptance, geometry and verified Job shutdown',
    async (): Promise<void> => {
        const source: string = [
            "if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('real terminal required');",
            'process.stdin.setRawMode(true);process.stdin.resume();',
            "process.stdout.write('TTY:1,1;UNICODE:€𝄞\\n');",
            "process.stdin.on('data',b=>process.stdout.write('INPUT:'+b.toString('base64')+'\\n'));",
            'let previous="";setInterval(()=>{const size=[];if(process.stdout._handle.getWindowSize(size)!==0)throw Error("size");const value=size.join(",");if(value!==previous){previous=value;process.stdout.write("SIZE:"+value+"\\n")}},30);',
        ].join('');
        await using terminal: WindowsHostTerminal = await WindowsHostTerminal.create(source);
        await contains(terminal, 'TTY:1,1;UNICODE:€𝄞');
        await contains(terminal, 'SIZE:80,24');
        const input: Buffer = Buffer.from('hello-terminal', 'utf8');
        await terminal.write(input);
        const accepted: WindowsTerminalReport = await terminal.report(
            (value: WindowsTerminalReport): boolean =>
                value.kind === 'input' && value.acceptedBytes === BigInt(input.length),
        );
        expect(accepted.kind).toBe('input');
        await contains(terminal, 'INPUT:' + input.toString('base64'));
        terminal.resize(1n, 112, 37);
        await terminal.report(
            (value: WindowsTerminalReport): boolean =>
                value.kind === 'control' && value.id === 1n && value.ok,
        );
        await contains(terminal, 'SIZE:112,37');
        await terminal.stop();
        const finished: WindowsTerminalReport = await terminal.report(
            (value: WindowsTerminalReport): boolean =>
                value.kind === 'state' && value.treeRunning === false && value.outputComplete,
        );
        if (finished.kind !== 'state') {
            throw new Error('Native terminal completion was not a state');
        }
        expect(finished.running).toBe(false);
        expect(finished.outputFinalBytes).toBe(BigInt(terminal.output.length));
    },
    60000,
);

it.skipIf(process.platform !== 'win32' || process.env['NERVA_WINDOWS_TERMINAL_SMOKE'] !== '1')(
    'a ConPTY root exit keeps its live detached descendant under the same Job until explicit stop',
    async (): Promise<void> => {
        const source: string =
            "const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});process.stdout.write('CHILD:'+child.pid+'\\n');child.unref();process.exit(7);";
        await using terminal: WindowsHostTerminal = await WindowsHostTerminal.create(source);
        const exited: WindowsTerminalReport = await terminal.report(
            (value: WindowsTerminalReport): boolean =>
                value.kind === 'state' &&
                !value.running &&
                value.treeRunning === true &&
                value.exitCode === 7,
        );
        expect(exited.kind).toBe('state');
        await terminal.stop();
        const finished: WindowsTerminalReport = await terminal.report(
            (value: WindowsTerminalReport): boolean =>
                value.kind === 'state' && value.treeRunning === false,
        );
        if (finished.kind !== 'state') {
            throw new Error('Native terminal completion was not a state');
        }
        expect(finished.exitCode).toBe(7);
    },
    60000,
);
