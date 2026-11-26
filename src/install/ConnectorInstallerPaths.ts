// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Both POSIX entry points enforce the protected installation policy before staging or executing a runtime. */
export class ConnectorInstallerPaths {
    /** The caller supplies fail(); these bounded checks create no directories and grant no sticky-ancestor exception. */
    public static definitions(): readonly string[] {
        return [
            'uid=$(id -u)',
            'ancestry() {',
            '  ancestor=$1; depth=0',
            '  case "$ancestor" in /*) ;; *) fail "Use an absolute installation directory" ;; esac',
            '  case "$ancestor/" in *//*) fail "Use a canonical directory" ;; */./*|*/../*) fail "Use a canonical directory" ;; esac',
            '  [ "${#ancestor}" -le 4096 ] || fail "Installation path is too long"',
            '  clean=$(printf %s "$ancestor" | LC_ALL=C tr -d "[:cntrl:]")',
            '  [ "$clean" = "$ancestor" ] || fail "Invalid installation path"',
            '  while :; do',
            '    [ "$depth" -lt 64 ] || fail "Installation ancestry is too deep"; depth=$((depth+1))',
            '    [ ! -L "$ancestor" ] || fail "Symlink installation ancestry is refused"',
            '    if [ -e "$ancestor" ]; then',
            '      [ -d "$ancestor" ] || fail "Installation ancestry is not a directory"',
            '      owner=$(stat -c %u -- "$ancestor"); mode=$(stat -c %a -- "$ancestor")',
            '      [ "$owner" = 0 ] || [ "$owner" = "$uid" ] || fail "Foreign installation owner"',
            '      [ "$((0$mode & 022))" -eq 0 ] || fail "Writable installation ancestry is refused"',
            '    fi',
            '    [ "$ancestor" != / ] || break; ancestor=$(dirname -- "$ancestor")',
            '  done',
            '}',
        ];
    }
}
