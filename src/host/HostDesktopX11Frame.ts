// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { HostApplication, type HostDesktopFrame } from './HostApplication.js';
import { HostDesktopCommand } from './HostDesktopCommand.js';
import { HostDesktopError } from './HostDesktopError.js';
import { HostDesktopLimits, type HostDesktopInfo } from './HostDesktopTypes.js';

/**
 * One X11 screen image sized to travel inline in a signed host result.
 *
 * @remarks
 * Matches the Windows helper's encoding ladder: native pixels at JPEG quality 90, then 80, and only then
 * fewer pixels, scaled by the measured overshoot. Each attempt is a fresh ImageMagick `import` of the root
 * window written to its pipe, so no image touches the disk and every returned frame is one capture.
 */
export class HostDesktopX11Frame {
    static readonly #attempts: number = 10;
    static readonly #qualities: readonly number[] = [90, 80];
    static readonly #startOfFrame: ReadonlySet<number> = new Set([
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
    ]);

    /** Capture the whole reported desktop as a bounded JPEG and its source geometry. */
    public static async capture(
        desktop: HostDesktopInfo,
        environment: NodeJS.ProcessEnv,
    ): Promise<HostDesktopFrame> {
        if (
            desktop.width < 1 ||
            desktop.height < 1 ||
            desktop.width * desktop.height > HostDesktopLimits.sourcePixels
        ) {
            throw new HostDesktopError('snapshot', 'source-pixels', null);
        }
        let scale: number = Math.min(
            1,
            HostDesktopLimits.dimension / desktop.width,
            HostDesktopLimits.dimension / desktop.height,
        );
        for (let attempt: number = 0; attempt < this.#attempts; attempt += 1) {
            const width: number = Math.max(1, Math.floor(desktop.width * scale));
            const height: number = Math.max(1, Math.floor(desktop.height * scale));
            let encodedBytes: number = 0;
            for (const quality of this.#qualities) {
                const bytes: Buffer = await this.#encode(
                    width === desktop.width && height === desktop.height
                        ? null
                        : `${width.toString()}x${height.toString()}!`,
                    quality,
                    environment,
                );
                encodedBytes = bytes.length;
                if (encodedBytes > HostDesktopLimits.inlineBytes) {
                    continue;
                }
                const size: readonly [number, number] | null = this.size(bytes);
                if (size === null || size[0] !== width || size[1] !== height) {
                    throw new HostDesktopError('snapshot', 'source-geometry', null);
                }
                return HostApplication.frame({
                    mimeType: 'image/jpeg',
                    data: bytes.toString('base64'),
                    width,
                    height,
                    sourceX: desktop.x,
                    sourceY: desktop.y,
                    sourceWidth: desktop.width,
                    sourceHeight: desktop.height,
                });
            }
            scale *= Math.min(
                0.8,
                Math.sqrt(HostDesktopLimits.inlineBytes / Math.max(1, encodedBytes)) * 0.95,
            );
        }
        throw new HostDesktopError('snapshot', 'inline-image-limit', null);
    }

    /**
     * The pixel size a baseline or progressive JPEG declares in its start-of-frame segment.
     *
     * @returns `[width, height]`, or `null` when the bytes are not a well-formed JPEG header
     */
    public static size(bytes: Buffer): readonly [number, number] | null {
        if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
            return null;
        }
        let offset: number = 2;
        while (offset + 4 <= bytes.length) {
            if (bytes[offset] !== 0xff) {
                return null;
            }
            const marker: number | undefined = bytes[offset + 1];
            if (marker === undefined || marker === 0xd9 || marker === 0xda) {
                return null;
            }
            if (marker === 0xff) {
                offset += 1;
                continue;
            }
            const length: number = bytes.readUInt16BE(offset + 2);
            if (length < 2 || offset + 2 + length > bytes.length) {
                return null;
            }
            if (this.#startOfFrame.has(marker)) {
                if (length < 7) {
                    return null;
                }
                return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
            }
            offset += 2 + length;
        }
        return null;
    }

    static async #encode(
        resize: string | null,
        quality: number,
        environment: NodeJS.ProcessEnv,
    ): Promise<Buffer> {
        return await HostDesktopCommand.run(
            'import',
            [
                '-limit',
                'memory',
                '256MiB',
                '-limit',
                'map',
                '0',
                '-limit',
                'disk',
                '0',
                '-window',
                'root',
                ...(resize === null ? [] : ['-resize', resize]),
                '-strip',
                '-quality',
                quality.toString(),
                'jpeg:-',
            ],
            environment,
            HostDesktopLimits.imageBytes,
        );
    }
}
