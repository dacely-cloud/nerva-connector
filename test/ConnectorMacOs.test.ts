// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HostDesktop } from '../src/host/HostDesktop.js';
import { HostDesktopCommand } from '../src/host/HostDesktopCommand.js';
import { HostDesktopMac } from '../src/host/HostDesktopMac.js';
import { HostWriteMode } from '../src/host/HostWorkspaceTypes.js';
import { HostDesktopMacScript } from '../src/host/HostDesktopMacScript.js';
import {
    HostDesktopBackend,
    HostDesktopButton,
    HostDesktopKeyAction,
    HostDesktopPointerAction,
    HostDesktopUnavailable,
    type HostDesktopInfo,
} from '../src/host/HostDesktopTypes.js';
import {
    ConnectorDirectoryPurpose,
    ConnectorPrivateDirectory,
} from '../src/runtime/ConnectorPrivateDirectory.js';
import { ConnectorDarwinStateLock } from '../src/runtime/ConnectorDarwinStateLock.js';
import { ConnectorNativeExecutable } from '../src/runtime/ConnectorNativeExecutable.js';

/** One faked desktop program invocation as the backend issued it. */
interface DesktopCall {
    readonly program: string;
    readonly arguments: readonly string[];
    readonly input: string | undefined;
}

/** These tests run on Linux, so the platform, architecture and home directory are replaced and restored. */
const platform: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
    process,
    'platform',
);
const architecture: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
    process,
    'arch',
);
const home: string | undefined = process.env['HOME'];
let root: string = '';

beforeEach(async (): Promise<void> => {
    root = await mkdtemp(join(homedir(), '.nerva-macos-'));
    process.env['HOME'] = root;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
});

afterEach(async (): Promise<void> => {
    vi.restoreAllMocks();
    if (platform !== undefined) {
        Object.defineProperty(process, 'platform', platform);
    }
    if (architecture !== undefined) {
        Object.defineProperty(process, 'arch', architecture);
    }
    if (home === undefined) {
        delete process.env['HOME'];
    } else {
        process.env['HOME'] = home;
    }
    await rm(root, { recursive: true, force: true });
});

/** A PNG with only the signature and header chunk, enough for the geometry checks. */
function png(width: number, height: number): Buffer {
    const header: Buffer = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write('IHDR', 12, 'ascii');
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    return header;
}

/** Replaces every desktop program with a recorder that answers like macOS would. */
function desktop(probe: Readonly<Record<string, unknown>>): DesktopCall[] {
    const calls: DesktopCall[] = [];
    vi.spyOn(HostDesktopCommand, 'run').mockImplementation(
        async (
            program: string,
            arguments_: readonly string[],
            _environment: NodeJS.ProcessEnv,
            _maximum: number,
            input?: string,
        ): Promise<Buffer> => {
            calls.push({ program, arguments: arguments_, input });
            const file: string | undefined = arguments_.at(-1);
            if (program === '/usr/sbin/screencapture' && file !== undefined) {
                await writeFile(file, png(3024, 1964));
            } else if (program === '/usr/bin/sips' && file !== undefined) {
                await writeFile(file, png(Number(arguments_[2]), Number(arguments_[1])));
            } else if (arguments_[3] === HostDesktopMacScript.info) {
                return Buffer.from(JSON.stringify(probe));
            }
            return Buffer.alloc(0);
        },
    );
    return calls;
}

/** The decimal arguments after the fixed script of one osascript call. */
function numbers(call: DesktopCall | undefined): readonly string[] {
    return call?.arguments.slice(4) ?? [];
}

it('state directories on macOS take a kernel lock file outside the directory and detect a swapped directory', async (): Promise<void> => {
    const state: string = join(root, 'state');
    await mkdir(state, { mode: 0o700 });
    {
        await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            state,
            ConnectorDirectoryPurpose.Runtime,
        );
        expect(await owner.empty()).toBe(true);
        await owner.write('record', Buffer.from('one'), 64, true);
        expect((await owner.read('record', 64)).toString()).toBe('one');
        await owner.write('record', Buffer.from('two'), 64, false);
        expect((await owner.read('record', 64)).toString()).toBe('two');
        expect(await owner.list()).toEqual(['record']);
        await using second: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            state,
            ConnectorDirectoryPurpose.Identity,
        );
        expect(await second.exists('record')).toBe(true);
    }
    const locks: string = ConnectorDarwinStateLock.directory();
    expect(locks).toBe(join(root, '.local/state/nerva-connector-locks'));
    expect((await lstat(locks)).mode & 0o777).toBe(0o700);
    const files: readonly string[] = await readdir(locks);
    expect(files).toHaveLength(2);
    for (const file of files) {
        expect(file).toMatch(/^nerva-state-[a-f0-9]{64}\.lock$/u);
        expect((await lstat(join(locks, file))).mode & 0o777).toBe(0o600);
    }
    await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
        state,
        ConnectorDirectoryPurpose.Runtime,
    );
    await rename(state, join(root, 'moved'));
    await mkdir(state, { mode: 0o700 });
    await expect(owner.read('record', 64)).rejects.toThrow('Connector state directory changed');
    await expect(owner.list()).rejects.toThrow('Connector state directory changed');
    await expect(ConnectorDarwinStateLock.acquire('../escape')).rejects.toThrow(
        'Invalid macOS connector state lock',
    );
});

it('every fixed macOS desktop script is valid JavaScript for osascript', (): void => {
    for (const source of [
        HostDesktopMacScript.info,
        HostDesktopMacScript.pointer,
        HostDesktopMacScript.key,
        HostDesktopMacScript.text,
    ]) {
        expect((): Script => new Script(source)).not.toThrow();
    }
});

it('the desktop reports missing Screen Recording and Accessibility, and asks macOS only once', async (): Promise<void> => {
    const calls: DesktopCall[] = desktop({
        x: 0,
        y: 0,
        width: 1512,
        height: 982,
        screen: false,
        input: false,
    });
    const driver: HostDesktopMac = new HostDesktopMac({});
    const quiet: HostDesktopInfo = await driver.info();
    expect(quiet.available).toBe(false);
    expect(quiet.backend).toBe(HostDesktopBackend.MacOs);
    expect(quiet.reason).toBe(HostDesktopUnavailable.ConsentRequired);
    expect(quiet.prerequisites).toHaveLength(2);
    expect(quiet.prerequisites[0]).toContain('Screen Recording');
    expect(quiet.prerequisites[1]).toContain('Accessibility');
    await driver.info(true);
    await driver.info(true);
    expect(calls.map((call: DesktopCall): string | undefined => call.arguments[4])).toEqual([
        'check',
        'prompt',
        'check',
    ]);
    expect(calls.every((call: DesktopCall): boolean => call.program === '/usr/bin/osascript')).toBe(
        true,
    );
});

it('pointer drags, modifier chords and typed text become exact CoreGraphics events', async (): Promise<void> => {
    const calls: DesktopCall[] = desktop({
        x: 0,
        y: 0,
        width: 1512,
        height: 982,
        screen: true,
        input: true,
    });
    const driver: HostDesktopMac = new HostDesktopMac({});
    expect((await driver.info()).available).toBe(true);
    calls.length = 0;
    await driver.pointer({
        x: 10,
        y: 20,
        action: HostDesktopPointerAction.Down,
        button: HostDesktopButton.Left,
    });
    await driver.pointer({ x: 30, y: 40, action: HostDesktopPointerAction.Move, button: null });
    await driver.pointer({
        x: 30,
        y: 40,
        action: HostDesktopPointerAction.Up,
        button: HostDesktopButton.Left,
    });
    await driver.pointer({ x: 50, y: 60, action: HostDesktopPointerAction.Move, button: null });
    await driver.pointer({
        x: 5,
        y: 6,
        action: HostDesktopPointerAction.Click,
        button: HostDesktopButton.Right,
    });
    expect(calls.map(numbers)).toEqual([
        ['10', '20', '1', '0'],
        ['30', '40', '6', '0'],
        ['30', '40', '2', '0'],
        ['50', '60', '5', '0'],
        ['5', '6', '3', '1', '4', '1'],
    ]);
    calls.length = 0;
    await driver.key({ key: 'Meta', action: HostDesktopKeyAction.Down });
    await driver.key({ key: 'c', action: HostDesktopKeyAction.Press });
    await driver.key({ key: 'Meta', action: HostDesktopKeyAction.Up });
    await driver.key({ key: 'A', action: HostDesktopKeyAction.Press });
    await driver.key({ key: 'Enter', action: HostDesktopKeyAction.Press });
    expect(calls.map(numbers)).toEqual([
        ['55', '1', '1048576'],
        ['8', '1', '1048576', '8', '0', '1048576'],
        ['55', '0', '0'],
        ['0', '1', '131072', '0', '0', '131072'],
        ['36', '1', '0', '36', '0', '0'],
    ]);
    calls.length = 0;
    await driver.text('héllo\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('héllo\n');
    expect(numbers(calls[0])).toEqual([]);
    await expect(driver.key({ key: 'F13', action: HostDesktopKeyAction.Press })).rejects.toThrow(
        'Unsupported desktop key',
    );
});

it('a Retina screenshot is scaled to the requested bound and its temporary file is removed', async (): Promise<void> => {
    const calls: DesktopCall[] = desktop({
        x: 0,
        y: 0,
        width: 1512,
        height: 982,
        screen: true,
        input: true,
    });
    await using session: HostDesktop = new HostDesktop({});
    const target: string = join(root, 'screen.png');
    const shot: Awaited<ReturnType<HostDesktop['screenshot']>> = await session.screenshot(
        target,
        HostWriteMode.Create,
        1024,
        1024,
    );
    expect([shot.width, shot.height]).toEqual([1024, 665]);
    expect(shot.desktop.width).toBe(1512);
    const capture: DesktopCall | undefined = calls.find(
        (call: DesktopCall): boolean => call.program === '/usr/sbin/screencapture',
    );
    expect(capture?.arguments.slice(0, 4)).toEqual(['-x', '-m', '-t', 'png']);
    const scale: DesktopCall | undefined = calls.find(
        (call: DesktopCall): boolean => call.program === '/usr/bin/sips',
    );
    expect(scale?.arguments.slice(0, 3)).toEqual(['-z', '665', '1024']);
    const temporary: string | undefined = capture?.arguments.at(-1);
    await expect(lstat(temporary ?? '')).rejects.toThrow();
});

it('a reviewed Mach-O helper for this Mac is accepted and an ELF or wrong-CPU binary is refused', async (): Promise<void> => {
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    const directory: string = join(root, 'helpers');
    await mkdir(directory, { mode: 0o700 });
    const write: (name: string, header: Buffer) => Promise<readonly [string, string]> = async (
        name: string,
        header: Buffer,
    ): Promise<readonly [string, string]> => {
        const bytes: Buffer = Buffer.concat([header, Buffer.alloc(256)]);
        const path: string = join(directory, name);
        await writeFile(path, bytes, { mode: 0o700 });
        await chmod(path, 0o700);
        return [path, createHash('sha256').update(bytes).digest('hex')];
    };
    const mach: (cpu: number) => Buffer = (cpu: number): Buffer => {
        const header: Buffer = Buffer.alloc(64);
        header.writeUInt32LE(0xfeedfacf, 0);
        header.writeUInt32LE(cpu, 4);
        header.writeUInt32LE(2, 12);
        return header;
    };
    const [arm, armDigest]: readonly [string, string] = await write('arm', mach(0x0100000c));
    await using handle: Awaited<ReturnType<typeof ConnectorNativeExecutable.open>> =
        await ConnectorNativeExecutable.open(arm, armDigest);
    expect(await ConnectorNativeExecutable.verifiedPath(handle, arm)).toBe(arm);
    const [intel, intelDigest]: readonly [string, string] = await write('intel', mach(0x01000007));
    await expect(ConnectorNativeExecutable.open(intel, intelDigest)).rejects.toThrow(
        'reviewed native executable',
    );
    const elf: Buffer = Buffer.alloc(64);
    Buffer.from('7f454c460201', 'hex').copy(elf, 0);
    elf.writeUInt16LE(2, 16);
    elf.writeUInt16LE(183, 18);
    const [linux, linuxDigest]: readonly [string, string] = await write('linux', elf);
    await expect(ConnectorNativeExecutable.open(linux, linuxDigest)).rejects.toThrow(
        'reviewed native executable',
    );
    await writeFile(arm, Buffer.concat([mach(0x0100000c), Buffer.alloc(257)]));
    await expect(ConnectorNativeExecutable.verifiedPath(handle, arm)).rejects.toThrow(
        'changed after verification',
    );
});
