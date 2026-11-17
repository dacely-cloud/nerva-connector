#!/bin/sh
set -eu
umask 077
PATH=/usr/bin:/bin; export PATH
fail() { echo "Nerva Connector: $*" >&2; exit 1; }
destination=
shortcuts=1
while [ "$#" -gt 0 ]; do
    case "$1" in
        --destination) [ "$#" -ge 2 ] || fail 'Use --destination PATH'; destination=$2; shift 2 ;;
        --no-shortcuts) shortcuts=0; shift ;;
        --help) echo 'Usage: sh Nerva-Connector-Setup.run [--destination /absolute/path] [--no-shortcuts]'; exit 0 ;;
        *) fail 'Use --destination PATH, --no-shortcuts or --help' ;;
    esac
done
[ "$(uname -s)" = Linux ] || fail 'This installer requires Linux'
case "$(uname -m)" in @NERVA_MACHINE@) ;; *) fail 'This installer targets @NERVA_ARCH@' ;; esac
[ -n "${HOME:-}" ] || fail 'HOME must select your account directory'
[ -n "$destination" ] || destination="$HOME/.local/lib/nerva-connector"
case "$destination" in *\\*) fail 'Choose a folder without backslash characters; Node cannot load modules from that path' ;; esac
@NERVA_PATH_CHECKS@
ancestry "$destination"
parent=$(dirname -- "$destination")
mkdir -p -- "$parent"
ancestry "$parent"
lock="$destination.install-lock"
mkdir -- "$lock" || fail 'Another installation is in progress; close it before retrying'
work=
previous=0
desktop_partial=
cleanup() {
    status=$?
    trap - EXIT INT TERM
    if [ "$previous" -eq 1 ] && [ ! -e "$destination" ]; then
        mv -- "$work/previous" "$destination" || status=1
    fi
    [ -z "$desktop_partial" ] || rm -f -- "$desktop_partial"
    [ -z "$work" ] || rm -rf -- "$work"
    rmdir -- "$lock" || status=1
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
work=$(mktemp -d "$parent/.nerva-setup.XXXXXXXXXX")
if [ -e "$destination" ]; then
    [ -f "$destination/.nerva-installation" ] && [ ! -L "$destination/.nerva-installation" ] || fail 'Destination contains another program or user files; choose an empty location'
    [ "$(cat "$destination/.nerva-installation")" = nerva-connector-linux-v1 ] || fail 'Unrecognized installation'
    for entry in "$destination"/* "$destination"/.[!.]* "$destination"/..?*; do
        [ -e "$entry" ] || [ -L "$entry" ] || continue
        [ -f "$entry" ] && [ ! -L "$entry" ] || fail 'Installation contains an unexpected directory or symlink'
        case "${entry##*/}" in @NERVA_FILES_CASE@) ;; *) fail 'Installation contains user files; move them before updating' ;; esac
    done
fi
echo 'Setting up Nerva Connector: checking the bundled runtime and programs…'
tail -n +@NERVA_PAYLOAD_LINE@ "$0" > "$work/payload.tar.gz"
[ "$(wc -c < "$work/payload.tar.gz" | tr -d ' ')" = @NERVA_PAYLOAD_SIZE@ ] || fail 'Installer download is incomplete'
actual=$(sha256sum "$work/payload.tar.gz"); actual=${actual%% *}
[ "$actual" = @NERVA_PAYLOAD_SHA256@ ] || fail 'Installer payload checksum does not match'
[ "$(tar -tzf "$work/payload.tar.gz")" = '@NERVA_FILES_LINES@' ] || fail 'Unexpected installer package contents'
mkdir "$work/next"
tar -xzf "$work/payload.tar.gz" --no-same-owner --no-same-permissions -C "$work/next"
chmod 700 "$work/next" "$work/next/node" "$work/next/nerva-connector" "$work/next/nerva-connector-exec" "$work/next/nerva-connector-files" "$work/next/nerva-connector-update"
NODE_OPTIONS= NODE_PATH= NODE_EXTRA_CA_CERTS= NODE_TLS_REJECT_UNAUTHORIZED=1 "$work/next/node" --input-type=module -e 'if(process.platform!=="linux"||process.arch!=="@NERVA_ARCH@")process.exit(1)' || fail 'The bundled runtime cannot run on this system'
if [ -e "$destination" ]; then
    mv -- "$destination" "$work/previous"
    previous=1
fi
mv -- "$work/next" "$destination"
previous=0
if [ "$shortcuts" -eq 1 ]; then
    applications="$HOME/.local/share/applications"
    ancestry "$applications"
    mkdir -p -- "$applications"
    ancestry "$applications"
    desktop="$applications/nerva-connector.desktop"
    [ ! -L "$desktop" ] || fail 'Refusing to replace a symlink desktop shortcut'
    if [ -e "$desktop" ]; then
        [ -f "$desktop" ] && grep -qx 'X-Nerva-Connector=true' "$desktop" || fail 'An unrelated desktop shortcut already exists'
    fi
    desktop_partial=$(mktemp "$applications/.nerva-connector.XXXXXXXXXX")
    NODE_OPTIONS= NODE_PATH= NODE_EXTRA_CA_CERTS= NODE_TLS_REJECT_UNAUTHORIZED=1 "$destination/node" --input-type=module - "$destination" "$desktop_partial" <<'NERVA_DESKTOP'
import {writeFileSync} from 'node:fs';
const [directory, output] = process.argv.slice(2);
const quoted = value => ('"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$').replaceAll('%', '%%') + '"').replaceAll('\\', '\\\\');
const icon = (directory + '/nerva-connector-logo.png').replaceAll('\\', '\\\\');
writeFileSync(output, '[Desktop Entry]\nType=Application\nName=Nerva Connector\nComment=Connect your computer to Nexa\nTerminal=true\nCategories=Utility;\nX-Nerva-Connector=true\nExec=/bin/sh ' + quoted(directory + '/nerva-connector') + '\nIcon=' + icon + '\n', {mode: 0o600});
NERVA_DESKTOP
    mv -- "$desktop_partial" "$desktop"
    desktop_partial=
fi
echo "Installed Nerva Connector in $destination"
echo 'Open Nerva Connector from your applications menu, or run:'
printf '  "%s/nerva-connector"\n' "$destination"
echo 'Your account link, permissions and history stay in ~/.local/share/nerva-connector.'
exit 0
