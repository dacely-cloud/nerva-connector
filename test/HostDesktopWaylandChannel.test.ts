// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi, type TestContext } from 'vitest';
import { HostOperationError } from '../src/host/HostOperationError.js';
import { HostDesktopLimits } from '../src/host/HostDesktopTypes.js';
import { HostDesktopWaylandChannel } from '../src/host/HostDesktopWaylandChannel.js';
import {
    HostDesktopWaylandOperation,
    HostDesktopWaylandResultKind,
    type HostDesktopWaylandResult,
} from '../src/host/HostDesktopWaylandProtocol.js';

/** Fixed subprocess fixtures exercise the real private transport without contacting a desktop. */
interface ScriptFixture {
    source: string;
}
const fixture: ScriptFixture = vi.hoisted((): ScriptFixture => ({ source: '' }));
vi.mock('../src/host/HostDesktopWaylandScript.js', (): ScriptModule => {
    class FixtureScript {
        public static get source(): string {
            return fixture.source;
        }
    }
    return { HostDesktopWaylandScript: FixtureScript };
});
/** The mock preserves the exact module's one static source contract. */
interface ScriptClass {
    readonly source: string;
}
/** The production channel receives fixed fixture source through module isolation only. */
interface ScriptModule {
    readonly HostDesktopWaylandScript: ScriptClass;
}

const reader: string = String.raw`
import sys,json,base64
for line in sys.stdin.buffer:
    request=json.loads(line)
    if request['operation']=='close': break
`;

it.skipIf(process.platform !== 'linux')(
    'the retained private pipe correlates requests and assembles a large split capture without lost bytes',
    async (): Promise<void> => {
        fixture.source =
            reader +
            String.raw`
    if request['operation']=='capture':
        result=dict(kind='capture',png=base64.b64encode(bytes(range(256))*8192).decode('ascii'),sourceWidth=1920,sourceHeight=1080)
    else: result=dict(kind='sent')
    output=json.dumps(dict(id=request['id'],result=result,error=None))+'\n'
    for index in range(0,len(output),4093):
        sys.stdout.write(output[index:index+4093]);sys.stdout.flush()
`;
        await using channel: HostDesktopWaylandChannel = await HostDesktopWaylandChannel.create(
            process.env,
        );
        const result: HostDesktopWaylandResult = await channel.request({
            operation: HostDesktopWaylandOperation.Capture,
            maximumWidth: 100,
            maximumHeight: 100,
        });
        if (result.kind !== HostDesktopWaylandResultKind.Capture) {
            throw new Error('Expected capture');
        }
        expect(result.png.length).toBe(2097152);
        expect(result.png.subarray(2096896)).toEqual(
            Buffer.from(
                Array.from({ length: 256 }, (_value: unknown, index: number): number => index),
            ),
        );
        expect(
            await channel.request({
                operation: HostDesktopWaylandOperation.Text,
                text: 'private data',
            }),
        ).toEqual({ kind: 'sent' });
    },
);

it.skipIf(process.platform !== 'linux')(
    'a response with another request ID fails and joins the exact helper instead of accepting or retrying its effect',
    async (): Promise<void> => {
        fixture.source =
            reader +
            String.raw`
    print(json.dumps(dict(id='999',result=dict(kind='sent'),error=None)),flush=True)
`;
        await using channel: HostDesktopWaylandChannel = await HostDesktopWaylandChannel.create(
            process.env,
        );
        await expect(
            channel.request({ operation: HostDesktopWaylandOperation.Text, text: 'once' }),
        ).rejects.toThrow('Invalid Wayland');
        await expect(
            channel.request({ operation: HostDesktopWaylandOperation.Text, text: 'never replay' }),
        ).rejects.toThrow();
    },
);

it.skipIf(process.platform !== 'linux')(
    'an oversized unterminated response is rejected before decoding and the helper is joined',
    async (): Promise<void> => {
        const maximum: number = Math.ceil(HostDesktopLimits.imageBytes / 3) * 4 + 4096;
        fixture.source = reader + `\n    sys.stdout.write('A'*${maximum + 1});sys.stdout.flush()\n`;
        await using channel: HostDesktopWaylandChannel = await HostDesktopWaylandChannel.create(
            process.env,
        );
        await expect(
            channel.request({ operation: HostDesktopWaylandOperation.Probe }),
        ).rejects.toThrow('exceeds its bound');
    },
);

it.skipIf(process.platform !== 'linux')(
    'cleanup interrupts an outstanding consent request through the private control pipe and observes closure',
    async (): Promise<void> => {
        fixture.source = reader;
        const channel: HostDesktopWaylandChannel = await HostDesktopWaylandChannel.create(
            process.env,
        );
        const pending: Promise<HostDesktopWaylandResult> = channel.request({
            operation: HostDesktopWaylandOperation.Open,
        });
        const rejected: Promise<void> = expect(pending).rejects.toThrow(
            'canceled by session cleanup',
        );
        await channel[Symbol.asyncDispose]();
        await rejected;
        await channel[Symbol.asyncDispose]();
    },
);

it.skipIf(process.platform !== 'linux')(
    'a declined consent request proves permission rejection before the requested desktop effect',
    async (): Promise<void> => {
        fixture.source =
            reader +
            String.raw`
    print(json.dumps(dict(id=request['id'],result=None,error='denied')),flush=True)
`;
        await using channel: HostDesktopWaylandChannel = await HostDesktopWaylandChannel.create(
            process.env,
        );
        const failed: Promise<HostDesktopWaylandResult> = channel.request({
            operation: HostDesktopWaylandOperation.Open,
        });
        await expect(failed).rejects.toBeInstanceOf(HostOperationError);
        await expect(failed).rejects.toMatchObject({ code: 'permission-denied', definitive: true });
    },
);

it.skipIf(process.platform !== 'linux')(
    'private registry output is isolated from the supplied user cache and removed after success, error and cancellation',
    async (): Promise<void> => {
        const directory: string = await mkdtemp(join(tmpdir(), 'nerva-wayland-cache-test-'));
        const sentinel: string = join(directory, 'user-cache');
        await writeFile(sentinel, 'preserved');
        const originalHome: string | undefined = process.env['HOME'];
        fixture.source = String.raw`
import sys,os,json
for line in sys.stdin.buffer:
    request=json.loads(line)
    if request['operation']=='close': break
    if request['operation']=='open': continue
    cache=os.environ['XDG_CACHE_HOME']
    assert os.environ['GST_REGISTRY']==os.environ['GST_REGISTRY_1_0']==os.path.join(cache,'registry.bin')
    assert os.environ['GST_REGISTRY_FORK']=='no' and 'GST_DEBUG_FILE' not in os.environ and 'GST_PLUGIN_SCANNER' not in os.environ
    with open(os.environ['GST_REGISTRY'],'wb') as output: output.write(b'private')
    if request['operation']=='text': print(json.dumps(dict(id='999',result=dict(kind='sent'),error=None)),flush=True)
    else: print(json.dumps(dict(id=request['id'],error=None,result=dict(kind='info',ready=False,reason='missing-tools',prerequisites=[cache,os.environ.get('HOME','unset')],width=0,height=0))),flush=True)
`;
        try {
            for (const scenario of ['success', 'error', 'cancel']) {
                const channel: HostDesktopWaylandChannel = await HostDesktopWaylandChannel.create({
                    ...process.env,
                    XDG_CACHE_HOME: directory,
                    GST_REGISTRY: sentinel,
                    GST_REGISTRY_1_0: sentinel,
                    GST_DEBUG_FILE: sentinel,
                    GST_PLUGIN_SCANNER: sentinel,
                    GST_REGISTRY_FORK: 'yes',
                });
                try {
                    const result: HostDesktopWaylandResult = await channel.request({
                        operation: HostDesktopWaylandOperation.Probe,
                    });
                    if (result.kind !== HostDesktopWaylandResultKind.Info) {
                        throw new Error('Expected cache fixture metadata');
                    }
                    const cache: string | undefined = result.prerequisites[0];
                    if (cache === undefined) {
                        throw new Error('Expected private registry path');
                    }
                    expect(cache).not.toBe(directory);
                    expect(result.prerequisites[1]).toBe(originalHome ?? 'unset');
                    expect(await readFile(join(cache, 'registry.bin'), 'utf8')).toBe('private');
                    if (scenario === 'error') {
                        await expect(
                            channel.request({
                                operation: HostDesktopWaylandOperation.Text,
                                text: 'invalid fixture response',
                            }),
                        ).rejects.toThrow('Invalid Wayland');
                    } else if (scenario === 'cancel') {
                        const rejected: Promise<void> = expect(
                            channel.request({ operation: HostDesktopWaylandOperation.Open }),
                        ).rejects.toThrow('canceled');
                        await channel[Symbol.asyncDispose]();
                        await rejected;
                    }
                    await channel[Symbol.asyncDispose]();
                    await expect(stat(cache)).rejects.toMatchObject({ code: 'ENOENT' });
                    expect(await readdir(directory)).toEqual(['user-cache']);
                    expect(await readFile(sentinel, 'utf8')).toBe('preserved');
                } finally {
                    await channel[Symbol.asyncDispose]();
                }
            }
            expect(process.env['HOME']).toBe(originalHome);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

it.skipIf(process.platform !== 'linux')(
    'the installed native GStreamer registry writes only into its ephemeral owner and leaves no cache after helper join',
    async (context: TestContext): Promise<void> => {
        fixture.source = String.raw`
import sys,os,json,ctypes
for line in sys.stdin.buffer:
    request=json.loads(line)
    if request['operation']=='close': break
    try: library=ctypes.CDLL('libgstreamer-1.0.so.0')
    except OSError:
        print(json.dumps(dict(id=request['id'],error=None,result=dict(kind='info',ready=False,reason='missing-tools',prerequisites=['native-gstreamer-unavailable'],width=0,height=0))),flush=True);continue
    library.gst_init_check.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p]
    library.gst_init_check.restype=ctypes.c_int
    assert library.gst_init_check(None,None,None)==1
    print(json.dumps(dict(id=request['id'],error=None,result=dict(kind='info',ready=False,reason='missing-tools',prerequisites=[os.environ['XDG_CACHE_HOME']],width=0,height=0))),flush=True)
`;
        await using channel: HostDesktopWaylandChannel = await HostDesktopWaylandChannel.create(
            process.env,
        );
        const result: HostDesktopWaylandResult = await channel.request({
            operation: HostDesktopWaylandOperation.Probe,
        });
        if (result.kind !== HostDesktopWaylandResultKind.Info) {
            throw new Error('Expected native registry metadata');
        }
        const cache: string | undefined = result.prerequisites[0];
        if (cache === 'native-gstreamer-unavailable') {
            context.skip();
        }
        if (cache === undefined) {
            throw new Error('Expected native registry path');
        }
        expect(
            (await readdir(cache)).every((name: string): boolean => name === 'registry.bin'),
        ).toBe(true);
        await channel[Symbol.asyncDispose]();
        await expect(stat(cache)).rejects.toMatchObject({ code: 'ENOENT' });
    },
);

it.skipIf(process.platform !== 'linux')(
    'native cleanup uncertainty remains a failed disposal even after helper closure and private cache cleanup',
    async (): Promise<void> => {
        fixture.source =
            reader +
            String.raw`
    print(json.dumps(dict(id=request['id'],result=dict(kind='sent'),error=None)),flush=True)
sys.exit(2)
`;
        const channel: HostDesktopWaylandChannel = await HostDesktopWaylandChannel.create(
            process.env,
        );
        await channel.request({
            operation: HostDesktopWaylandOperation.Text,
            text: 'owned effect',
        });
        await expect(channel[Symbol.asyncDispose]()).rejects.toThrow(
            'without confirmed held-input cleanup',
        );
        await expect(channel[Symbol.asyncDispose]()).rejects.toThrow(
            'without confirmed held-input cleanup',
        );
        await expect(stat(channel.cacheDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    },
);
