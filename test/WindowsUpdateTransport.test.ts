// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { ConnectorWindowsCompiler } from '../script/ConnectorWindowsCompiler.ts';

const mono: boolean =
    process.platform === 'linux' && existsSync('/usr/bin/mcs') && existsSync('/usr/bin/mono');

/** A UTF-8 child result remains text at the process boundary. */
interface WindowsUpdateTransportOutput {
    readonly stdout: string;
    readonly stderr: string;
}

it.skipIf(!mono)(
    'the native bridge preserves UTF-8 paths, clears unsafe Node environment and bounds/redacts failed child output',
    async (): Promise<void> => {
        const directory: string = await mkdtemp(join(tmpdir(), 'nerva-windows-update-Åda 私-'));
        try {
            const executable: string = join(directory, 'fixture.exe');
            await ConnectorWindowsCompiler.compile({
                sources: [
                    'test/support/WindowsUpdateTransportFixture.cs',
                    'native/windows/installer/SupervisorUpdateTransport.cs',
                    'native/windows/installer/SupervisorLog.cs',
                    'native/windows/installer/UpdateFeed.cs',
                ].map((path: string): string => resolve(path)),
                entrypoint: 'NexaConnectorWindowsUpdateTransportFixture',
                destination: executable,
            });
            const node: string = join(directory, 'node.exe');
            await writeFile(
                node,
                "#!/bin/sh\nexec '" + process.execPath.replaceAll("'", "'\\''") + '\' "$@"\n',
            );
            await chmod(node, 0o700);
            await writeFile(
                join(directory, 'nerva-connector.mjs'),
                `
import {writeFileSync} from 'node:fs';
let input='';for await(const chunk of process.stdin){input+=chunk;}
const value=JSON.parse(input);
if(process.argv[2]!=='--windows-update-fetch'||process.argv.length!==3||process.env.NODE_OPTIONS||process.env.NODE_PATH||process.env.NODE_EXTRA_CA_CERTS||process.env.NODE_TLS_REJECT_UNAUTHORIZED!=='1'||!value.destination.includes('私の更新.partial'))process.exit(71);
writeFileSync(value.destination,'signed payload');
const mode=process.env.NERVA_WINDOWS_UPDATE_FIXTURE;
if(mode==='tls-error'){process.stderr.write('windows-update-fetch code=ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION\\n');process.exitCode=1;}
else if(mode==='noise'){process.stderr.write('private URL=https://secret.example/private');process.exitCode=1;}
else if(mode==='overflow'){process.stdout.write('x'.repeat(9000));}
else {process.stdout.write(JSON.stringify({bytes:'14',protocol:mode==='tls-old'?'TLSv1.2':'TLSv1.3'})+'\\n');}
`,
            );
            const environment: NodeJS.ProcessEnv = {
                ...process.env,
                NODE_OPTIONS: '--invalid-option-must-not-reach-child',
                NODE_PATH: '/private/injection',
                NODE_EXTRA_CA_CERTS: '/private/ca',
                NODE_TLS_REJECT_UNAUTHORIZED: '0',
            };
            const run: (mode: string) => Promise<string> = async (
                mode: string,
            ): Promise<string> => {
                try {
                    const result: WindowsUpdateTransportOutput = await promisify(execFile)(
                        '/usr/bin/mono',
                        [executable, directory],
                        {
                            encoding: 'utf8',
                            timeout: 15000,
                            maxBuffer: 16384,
                            env: { ...environment, NERVA_WINDOWS_UPDATE_FIXTURE: mode },
                        },
                    );
                    return result.stdout.trim();
                } catch (caught: unknown) {
                    if (
                        caught !== null &&
                        typeof caught === 'object' &&
                        'stdout' in caught &&
                        typeof caught.stdout === 'string'
                    ) {
                        return caught.stdout.trim();
                    }
                    throw caught;
                }
            };
            expect(await run('ok')).toBe('transport=ok');
            const partial: string = join(directory, '私の更新.partial');
            expect(await readFile(partial, 'utf8')).toBe('signed payload');
            await rm(partial);
            for (const [mode, code] of [
                ['tls-error', 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION'],
                ['noise', 'CHILD_FAILED'],
                ['tls-old', 'RECEIPT_INVALID'],
                ['overflow', 'OUTPUT_LIMIT'],
            ] as const) {
                expect(await run(mode)).toBe(
                    `update fetch stage=manifest code=${code} tls-min=TLSv1.3`,
                );
                expect(await readdir(directory)).not.toContain('私の更新.partial');
            }
            const log: string = await readFile(join(directory, 'supervisor.log'), 'utf8');
            expect(log).toContain('protocol=TLSv1.3 bytes=14');
            expect(log).toContain('code=ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION');
            expect(log).not.toContain('secret.example');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
