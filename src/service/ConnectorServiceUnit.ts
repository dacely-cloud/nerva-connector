// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { ConnectorServiceScope, type ConnectorServiceLayout } from './ConnectorServiceTypes.js';

/** A unit has one deterministic name and literal argv; no shell or command template enters systemd. */
export class ConnectorServiceUnit {
    /** Scope fixes the manager and unit directory; callers cannot select another unit or privilege identity. */
    public static layout(directory: string, scope: ConnectorServiceScope): ConnectorServiceLayout {
        if (
            process.platform !== 'linux' ||
            resolve(ProtectedFiles.path(directory)) !== directory ||
            /[\u007f]/u.test(directory)
        ) {
            throw new Error('Canonical Linux service installation required');
        }
        if (scope === ConnectorServiceScope.System && process.getuid?.() !== 0) {
            throw new Error('System service installation requires an explicit root invocation');
        }
        if (!Object.values(ConnectorServiceScope).includes(scope)) {
            throw new Error('Unsupported service scope');
        }
        const unitDirectory: string =
            scope === ConnectorServiceScope.System
                ? '/etc/systemd/system'
                : join(homedir(), '.config', 'systemd', 'user');
        const unitName: string =
            'nerva-connector-' + createHash('sha256').update(directory).digest('hex') + '.service';
        const quote: (path: string) => string = (path: string): string =>
            '"' + path.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
        const source: string = [
            '[Unit]',
            'Description=Nerva Connector',
            'After=network.target',
            'StartLimitIntervalSec=60',
            'StartLimitBurst=5',
            '',
            '[Service]',
            'Type=exec',
            ...(scope === ConnectorServiceScope.System ? ['Slice=system.slice'] : []),
            'ExecStart=:' +
                quote(join(directory, 'node')) +
                ' ' +
                quote(join(directory, 'nerva-connector.mjs')) +
                ' service-run --directory ' +
                quote(directory) +
                ' --scope ' +
                scope.valueOf(),
            'WorkingDirectory=/',
            'Environment=PATH=/usr/bin:/bin LANG=C LC_ALL=C UV_THREADPOOL_SIZE=4',
            'UnsetEnvironment=NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED NODE_V8_COVERAGE NODE_DEBUG NODE_DEBUG_NATIVE LD_PRELOAD LD_LIBRARY_PATH',
            'UMask=0077',
            'Restart=on-failure',
            'RestartSec=5',
            'KillMode=control-group',
            'TimeoutStopSec=45',
            'Delegate=cpu memory pids',
            'DelegateSubgroup=supervisor',
            'TasksMax=512',
            'LimitNOFILE=4096',
            '',
            '[Install]',
            'WantedBy=' +
                (scope === ConnectorServiceScope.System ? 'multi-user.target' : 'default.target'),
            '',
        ].join('\n');
        return {
            scope,
            installationDirectory: directory,
            unitDirectory,
            unitName,
            unitFile: join(unitDirectory, unitName),
            source,
            sha256: createHash('sha256').update(source).digest('hex'),
        };
    }
}
