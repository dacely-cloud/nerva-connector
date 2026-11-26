// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { SignatureSuite } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorReleaseCodec } from './ConnectorReleaseCodec.js';
import { ConnectorReleaseDownload } from './ConnectorReleaseDownload.js';
import { ConnectorInstallerPaths } from './ConnectorInstallerPaths.js';
import {
    ConnectorReleaseArchitecture,
    ConnectorReleasePlatform,
    type ConnectorSignedRelease,
} from './ConnectorRelease.js';

/** A trusted per-release script pins the bootstrap Node/application bytes before either can execute. */
export class ConnectorInstallerScript {
    /** HTTPS distribution and an offline directory use the same signed assets and exact byte commitments. */
    public static create(
        release: ConnectorSignedRelease,
        publicKey: string,
        baseUrl: string,
    ): string {
        if (release.manifest.platform !== ConnectorReleasePlatform.Linux) {
            throw new Error('POSIX installer requires an explicit Linux release');
        }
        const url: URL = ConnectorReleaseDownload.directory(baseUrl);
        const manifest: string = ConnectorReleaseCodec.encode(release).toString('utf8');
        const trust: string = JSON.stringify({ suite: SignatureSuite.MlDsa44Ed25519, publicKey });
        const lines: string[] = [
            '#!/bin/sh',
            'set -eu',
            'umask 077',
            'PATH=/usr/bin:/bin; export PATH',
            'fail() { echo "Nerva Connector: $*" >&2; exit 1; }',
            'destination=',
            'source_directory=',
            'install_only=0',
            'service_scope=',
            'native_config=',
            'quiet=0',
            'while [ "$#" -gt 0 ]; do',
            '  case "$1" in',
            '    --destination) [ "$#" -ge 2 ] || exit 2; destination=$2; shift 2 ;;',
            '    --release-directory) [ "$#" -ge 2 ] || exit 2; source_directory=$2; shift 2 ;;',
            '    --install-only) install_only=1; shift ;;',
            '    --service) [ "$#" -ge 2 ] || exit 2; case "$2" in system|user) service_scope=$2 ;; *) exit 2 ;; esac; shift 2 ;;',
            '    --native-config) [ "$#" -ge 2 ] || exit 2; native_config=$2; shift 2 ;;',
            '    --quiet) quiet=1; shift ;;',
            '    *) echo "Use --destination PATH, --release-directory PATH or --install-only" >&2; exit 2 ;;',
            '  esac',
            'done',
            'if [ -z "$destination" ]; then',
            '  [ -n "${HOME:-}" ] || { echo "Use --destination when HOME is unset" >&2; exit 2; }',
            '  destination="$HOME/.local/share/nerva-connector"',
            'fi',
            '[ "$install_only" -eq 0 ] || [ -z "$service_scope" ] || { echo "Choose --install-only or --service" >&2; exit 2; }',
            '[ -z "$native_config" ] || { [ "$install_only" -eq 0 ] && [ "$service_scope" = system ]; } || { echo "Native setup requires --service system" >&2; exit 2; }',
            ...ConnectorInstallerPaths.definitions(),
            'ancestry "$destination"',
            '[ "$(uname -s)" = Linux ] || { echo "Linux connector release required" >&2; exit 1; }',
            release.manifest.architecture === ConnectorReleaseArchitecture.X64
                ? '[ "$(uname -m)" = x86_64 ] || exit 1'
                : '[ "$(uname -m)" = aarch64 ] || exit 1',
            'parent=$(dirname -- "$destination")',
            'mkdir -p -- "$parent"',
            'ancestry "$parent"',
            'work=$(mktemp -d "$parent/.nerva-setup.XXXXXXXXXX")',
            'trap \'rm -rf -- "$work"\' EXIT',
            "trap 'exit 130' INT",
            "trap 'exit 143' TERM",
            'fetch() {',
            '  name=$1; expected_size=$2; expected_sha=$3',
            '  if [ -n "$source_directory" ]; then',
            '    [ -f "$source_directory/$name" ] && [ ! -L "$source_directory/$name" ] || exit 1',
            '    [ "$(stat -c %s -- "$source_directory/$name")" = "$expected_size" ] || exit 1',
            '    cp --no-dereference -- "$source_directory/$name" "$work/$name"',
            '  else',
            '    curl --disable --fail --silent --show-error --proto =https --tlsv1.2 --max-redirs 0 --connect-timeout 10 --max-time 180 --max-filesize "$expected_size" --output "$work/$name" ' +
                this.#quote(url.href) +
                '"$name"',
            '  fi',
            '  [ "$(stat -c %s -- "$work/$name")" = "$expected_size" ] || exit 1',
            '  actual=$(sha256sum -- "$work/$name"); actual=${actual%% *}',
            '  [ "$actual" = "$expected_sha" ] || { echo "Connector bootstrap digest mismatch" >&2; exit 1; }',
            '}',
            '[ "$quiet" -eq 1 ] || echo "Setting up your connector: verifying standalone release…"',
        ];
        for (const artifact of release.manifest.artifacts) {
            lines.push(
                'fetch ' +
                    this.#quote(artifact.name) +
                    ' ' +
                    this.#quote(artifact.sizeBytes.toString()) +
                    ' ' +
                    this.#quote(artifact.sha256),
            );
        }
        lines.push(
            'chmod 700 "$work/node" "$work/nerva-connector.mjs" "$work/nerva-connector-files" "$work/nerva-connector-exec"',
            'cat > "$work/release.json" <<\'NERVA_RELEASE_MANIFEST\'',
            manifest,
            'NERVA_RELEASE_MANIFEST',
            'cat > "$work/release-public.json" <<\'NERVA_RELEASE_PUBLIC\'',
            trust,
            'NERVA_RELEASE_PUBLIC',
            'NODE_OPTIONS= NODE_PATH= NODE_EXTRA_CA_CERTS= NODE_TLS_REJECT_UNAUTHORIZED=1 "$work/node" --input-type=module - "$work" "$destination" <<\'NERVA_INSTALL_REQUEST\'',
            'import {writeFileSync} from "node:fs";',
            'const [releaseDirectory,destination]=process.argv.slice(2);',
            'writeFileSync(releaseDirectory+"/installation.json",JSON.stringify({releaseDirectory,manifestFile:releaseDirectory+"/release.json",releasePublicKeyFile:releaseDirectory+"/release-public.json",destination}),{mode:0o600});',
            'NERVA_INSTALL_REQUEST',
            'NODE_OPTIONS= NODE_PATH= NODE_EXTRA_CA_CERTS= NODE_TLS_REJECT_UNAUTHORIZED=1 "$work/node" "$work/nerva-connector.mjs" install --config "$work/installation.json"',
            'rm -rf -- "$work"',
            'trap - EXIT INT TERM',
            '[ "$install_only" -eq 0 ] || exit 0',
            '[ "$quiet" -eq 1 ] || echo "Link this machine using the code shown below."',
            'if [ -n "$service_scope" ]; then',
            '  if [ -n "$native_config" ]; then',
            '    exec env NODE_OPTIONS= NODE_PATH= NODE_EXTRA_CA_CERTS= NODE_TLS_REJECT_UNAUTHORIZED=1 "$destination/node" "$destination/nerva-connector.mjs" service connect --scope system --directory "$destination" --native-config "$native_config"',
            '  fi',
            '  exec env NODE_OPTIONS= NODE_PATH= NODE_EXTRA_CA_CERTS= NODE_TLS_REJECT_UNAUTHORIZED=1 "$destination/node" "$destination/nerva-connector.mjs" service connect --scope "$service_scope" --directory "$destination"',
            'fi',
            'exec env NODE_OPTIONS= NODE_PATH= NODE_EXTRA_CA_CERTS= NODE_TLS_REJECT_UNAUTHORIZED=1 "$destination/node" "$destination/nerva-connector.mjs" connect --config "$destination/pairing.json"',
            '',
        );
        return lines.join('\n');
    }
    static #quote(value: string): string {
        return "'" + value.replaceAll("'", "'\\''") + "'";
    }
}
