// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Fixed JavaScript-for-Automation programs that `osascript` runs for the macOS desktop backend.
 *
 * @remarks
 * Every script is a constant. Callers pass only decimal numbers as arguments, and typed text arrives on
 * standard input, so no request value is ever evaluated as code. The numbers are CoreGraphics event
 * types, mouse buttons, virtual key codes and event flags; posting to tap 0 (`kCGHIDEventTap`) delivers
 * the events as if they came from the hardware.
 */
export class HostDesktopMacScript {
    /** Main display bounds in points and whether Screen Recording and Accessibility are allowed; `prompt` asks once. */
    public static readonly info: string = [
        "ObjC.import('CoreGraphics');",
        "ObjC.import('ApplicationServices');",
        'function run(argv) {',
        "    var prompt = argv[0] === 'prompt';",
        '    var bounds = $.CGDisplayBounds($.CGMainDisplayID());',
        "    var screen = typeof $.CGPreflightScreenCaptureAccess === 'function' ? Boolean($.CGPreflightScreenCaptureAccess()) : true;",
        '    var input = Boolean($.AXIsProcessTrusted());',
        "    if (prompt && !screen && typeof $.CGRequestScreenCaptureAccess === 'function') {",
        '        $.CGRequestScreenCaptureAccess();',
        '    }',
        '    if (prompt && !input) {',
        '        $.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true }));',
        '    }',
        '    return JSON.stringify({ x: bounds.origin.x, y: bounds.origin.y, width: bounds.size.width, height: bounds.size.height, screen: screen, input: input });',
        '}',
    ].join('\n');

    /** Mouse events at `x y`, or at the current pointer for `here here`, as pairs of event type and button. */
    public static readonly pointer: string = [
        "ObjC.import('CoreGraphics');",
        'function run(argv) {',
        "    var point = argv[0] === 'here' ? $.CGEventGetLocation($.CGEventCreate(null)) : { x: Number(argv[0]), y: Number(argv[1]) };",
        '    for (var index = 2; index + 1 < argv.length; index += 2) {',
        '        var event = $.CGEventCreateMouseEvent(null, Number(argv[index]), point, Number(argv[index + 1]));',
        '        $.CGEventSetIntegerValueField(event, 1, 1);',
        '        $.CGEventPost(0, event);',
        '    }',
        "    return '';",
        '}',
    ].join('\n');

    /** Keyboard events as triples of virtual key code, `1` for down or `0` for up, and the event flags. */
    public static readonly key: string = [
        "ObjC.import('CoreGraphics');",
        'function run(argv) {',
        '    for (var index = 0; index + 2 < argv.length; index += 3) {',
        "        var event = $.CGEventCreateKeyboardEvent(null, Number(argv[index]), argv[index + 1] === '1');",
        '        $.CGEventSetFlags(event, Number(argv[index + 2]));',
        '        $.CGEventPost(0, event);',
        '    }',
        "    return '';",
        '}',
    ].join('\n');

    /** UTF-8 text from standard input, typed one composed character at a time; line breaks and tabs press their keys. */
    public static readonly text: string = [
        "ObjC.import('Foundation');",
        "ObjC.import('CoreGraphics');",
        'function press(code) {',
        '    [true, false].forEach(function (down) {',
        '        $.CGEventPost(0, $.CGEventCreateKeyboardEvent(null, code, down));',
        '    });',
        '}',
        'function run() {',
        '    var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;',
        '    var text = $.NSString.alloc.initWithDataEncoding(data, 4);',
        '    var length = Number(text.length);',
        '    var index = 0;',
        '    while (index < length) {',
        '        var range = text.rangeOfComposedCharacterSequenceAtIndex(index);',
        '        var piece = text.substringWithRange(range);',
        '        var value = piece.js;',
        "        if (value === '\\n' || value === '\\r' || value === '\\r\\n') {",
        '            press(36);',
        "        } else if (value === '\\t') {",
        '            press(48);',
        '        } else {',
        '            var units = Number(piece.length);',
        '            var buffer = $.NSMutableData.dataWithLength(units * 2);',
        '            piece.getCharactersRange(buffer.mutableBytes, { location: 0, length: units });',
        '            [true, false].forEach(function (down) {',
        '                var event = $.CGEventCreateKeyboardEvent(null, 0, down);',
        '                $.CGEventKeyboardSetUnicodeString(event, units, buffer.mutableBytes);',
        '                $.CGEventPost(0, event);',
        '            });',
        '        }',
        '        index = Number(range.location) + Number(range.length);',
        '    }',
        "    return '';",
        '}',
    ].join('\n');
}
