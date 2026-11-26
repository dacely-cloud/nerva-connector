// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { SignatureSuite } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorReleaseCodec } from './ConnectorReleaseCodec.js';
import { ConnectorInstallerPaths } from './ConnectorInstallerPaths.js';
import {
    ConnectorReleaseArchitecture,
    ConnectorReleaseFile,
    ConnectorReleasePlatform,
    type ConnectorSignedRelease,
} from './ConnectorRelease.js';

/** A dependency-free npm entry point bootstraps once and resumes only its exact trusted release. */
export class ConnectorNpmLauncher {
    /** Pins public installation intent and executable bytes before the downloaded runtime can execute. */
    public static create(
        release: ConnectorSignedRelease,
        publicKey: string,
        installer: string,
        version: string,
    ): string {
        if (release.manifest.platform !== ConnectorReleasePlatform.Linux) {
            throw new Error('POSIX npm launcher requires an explicit Linux release');
        }
        const lines: string[] = [
            '#!/bin/sh',
            'set -eu',
            'umask 077',
            'PATH=/usr/bin:/bin; export PATH',
            'fail() { echo "Nerva Connector: $*" >&2; exit 1; }',
            'help() {',
            "  cat <<'NERVA_HELP'",
            'Nerva Connector',
            '',
            'Usage: nexa connector [connect|pair|run|status|logout|renew-pairing|system-info]',
            '       nexa connector service connect|install|start|status|stop|remove [--scope user|system]',
            '',
            'Run nexa connector to set up this machine and display your pairing code.',
            'Enter the code at ' + release.manifest.deployment.verificationUri,
            'No configuration files or public keys need to be pasted.',
            'Foreground mode stops with Ctrl-C. File and command access require explicit local grants.',
            '',
            'Options: --directory /absolute/installation, --release-directory /offline/release, --help, --version',
            'NERVA_HELP',
            '}',
            '[ "$#" -le 13 ] || fail "Too many arguments"',
            'if [ "$#" -eq 0 ]; then help; exit 0; fi',
            'case "$1" in connector) shift ;; --help|--version) ;; *) fail "Use nexa connector" ;; esac',
            'case "${1:-}" in --help) [ "$#" -eq 1 ] || fail "Use --help alone"; help; exit 0 ;; --version) [ "$#" -eq 1 ] || exit 2; echo ' +
                this.#quote(version) +
                '; exit 0 ;; esac',
            'command=connect; action=; scope=user; destination=; source_directory=',
            'case "${1:-}" in connect|pair|run|status|logout|renew-pairing|system-info) command=$1; shift ;; service) command=service; shift; [ "$#" -gt 0 ] || fail "Choose a service action"; action=$1; shift; case "$action" in connect|install|start|status|stop|remove) ;; *) fail "Unknown service action" ;; esac ;; esac',
            'while [ "$#" -gt 0 ]; do',
            '  [ "$#" -ge 2 ] || fail "Option requires a value"',
            '  case "$1" in',
            '    --directory) [ -z "$destination" ] || fail "Duplicate directory"; destination=$2 ;;',
            '    --release-directory) [ -z "$source_directory" ] || fail "Duplicate release directory"; source_directory=$2 ;;',
            '    --scope) [ "$command" = service ] || fail "Scope is a service option"; case "$2" in user|system) scope=$2 ;; *) fail "Choose user or system scope" ;; esac ;;',
            '    *) fail "Unknown command or option; use --help" ;;',
            '  esac; shift 2',
            'done',
            'if [ -z "$destination" ]; then [ -n "${HOME:-}" ] || fail "Use --directory when HOME is unset"; destination="$HOME/.local/share/nerva-connector"; fi',
            '[ "$(uname -s)" = Linux ] || fail "This release requires Linux"',
            '[ "$(uname -m)" = ' +
                this.#quote(
                    release.manifest.architecture === ConnectorReleaseArchitecture.X64
                        ? 'x86_64'
                        : 'aarch64',
                ) +
                ' ] || fail "This release does not support this CPU architecture"',
            ...ConnectorInstallerPaths.definitions(),
            'ancestry "$destination"',
            'package_directory=$(dirname -- "$(readlink -f -- "$0")")',
            'verify() {',
            '  path=$1; expected_size=$2; expected_sha=$3',
            '  [ ! -L "$path" ] && [ -f "$path" ] || fail "Missing or substituted release file"',
            '  owner=$(stat -c %u -- "$path"); mode=$(stat -c %a -- "$path")',
            '  [ "$owner" = 0 ] || [ "$owner" = "$uid" ] || fail "Foreign release file owner"',
            '  [ "$((0$mode & 022))" -eq 0 ] && [ "$(stat -c %h -- "$path")" = 1 ] || fail "Unsafe release file"',
            '  [ "$(stat -c %s -- "$path")" = "$expected_size" ] || fail "Release file size changed"',
            '  actual=$(sha256sum -- "$path"); actual=${actual%% *}',
            '  [ "$actual" = "$expected_sha" ] || fail "Release changed; retain your installation and use an approved upgrade"',
            '}',
            'if [ ! -e "$destination/ready.json" ]; then',
            '  case "$command:$action" in status:*|logout:*|run:*|service:start|service:status|service:stop|service:remove) fail "Not set up. Run nexa connector first" ;; esac',
            '  ancestry "$package_directory"',
            this.#verify('"$package_directory/install-connector.sh"', Buffer.from(installer)),
            '  echo "Setting up your connector: downloading and verifying the signed runtime…"',
            '  if [ -n "$source_directory" ]; then',
            '    /bin/sh "$package_directory/install-connector.sh" --destination "$destination" --release-directory "$source_directory" --install-only --quiet >/dev/null',
            '  else',
            '    /bin/sh "$package_directory/install-connector.sh" --destination "$destination" --install-only --quiet >/dev/null',
            '  fi',
            'fi',
            'ancestry "$destination"',
            this.#verify('"$destination/release.json"', ConnectorReleaseCodec.encode(release)),
            this.#verify(
                '"$destination/release-public.json"',
                Buffer.from(JSON.stringify({ suite: SignatureSuite.MlDsa44Ed25519, publicKey })),
            ),
        ];
        for (const name of [ConnectorReleaseFile.Runtime, ConnectorReleaseFile.Application]) {
            const artifact: (typeof release.manifest.artifacts)[number] | undefined =
                release.manifest.artifacts.find((entry): boolean => entry.name === name);
            if (artifact === undefined) {
                throw new Error('Npm bootstrap requires the complete signed executable set');
            }
            lines.push(
                'verify "$destination/' +
                    name +
                    '" ' +
                    this.#quote(artifact.sizeBytes.toString()) +
                    ' ' +
                    this.#quote(artifact.sha256),
            );
        }
        lines.push(
            'export NODE_OPTIONS= NODE_PATH= NODE_EXTRA_CA_CERTS= NODE_TLS_REJECT_UNAUTHORIZED=1',
            'if [ "$command" = service ]; then exec "$destination/node" "$destination/nerva-connector.mjs" service "$action" --scope "$scope" --directory "$destination"; fi',
            'exec "$destination/node" "$destination/nerva-connector.mjs" "$command" --installation "$destination"',
            '',
        );
        return lines.join('\n');
    }

    static #verify(path: string, bytes: Buffer): string {
        return (
            'verify ' +
            path +
            ' ' +
            this.#quote(bytes.byteLength.toString()) +
            ' ' +
            this.#quote(createHash('sha256').update(bytes).digest('hex'))
        );
    }
    static #quote(value: string): string {
        return "'" + value.replaceAll("'", "'\\''") + "'";
    }
}
