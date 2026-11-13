//! Desktop input as IronRDP input operations.

use gated_core::DesktopInput;
use ironrdp_input::{MouseButton, MousePosition, Operation, Scancode, WheelRotations};

const WHEEL_UNITS_PER_NOTCH: i16 = 120;

/// Most wheel notches forwarded for one scroll input.
const MAX_WHEEL_NOTCHES: i16 = 10;

/// Append the operations for `input`. Clipboard, refresh and resize are not
/// input operations and are handled by the session loop.
pub fn translate(input: DesktopInput, ops: &mut Vec<Operation>) {
    match input {
        DesktopInput::Pointer { x, y, buttons } => {
            ops.push(Operation::MouseMove(MousePosition { x, y }));
            for (bit, button) in [
                (0u8, MouseButton::Left),
                (1, MouseButton::Middle),
                (2, MouseButton::Right),
            ] {
                ops.push(if buttons & (1 << bit) != 0 {
                    Operation::MouseButtonPressed(button)
                } else {
                    Operation::MouseButtonReleased(button)
                });
            }
        }
        DesktopInput::Wheel {
            vertical, delta, ..
        } => {
            let notches = delta.clamp(-MAX_WHEEL_NOTCHES, MAX_WHEEL_NOTCHES);
            ops.push(Operation::WheelRotations(WheelRotations {
                is_vertical: vertical,
                rotation_units: notches * WHEEL_UNITS_PER_NOTCH,
            }));
        }
        DesktopInput::Key {
            keysym,
            scancode,
            down,
        } => {
            // The key position wins: the target's layout decides the
            // character, as it does for a keyboard plugged into it.
            let position = scancode
                .map(|scancode| (scancode.extended, scancode.code))
                .or_else(|| keysym.and_then(keysym_to_scancode));
            if let Some((extended, code)) = position {
                let scancode = Scancode::from_u8(extended, code);
                ops.push(if down {
                    Operation::KeyPressed(scancode)
                } else {
                    Operation::KeyReleased(scancode)
                });
            } else if let Some(character) = keysym.and_then(keysym_to_char) {
                ops.push(if down {
                    Operation::UnicodeKeyPressed(character)
                } else {
                    Operation::UnicodeKeyReleased(character)
                });
            }
        }
        DesktopInput::Clipboard(_) | DesktopInput::Refresh | DesktopInput::Resize { .. } => {}
    }
}

/// The character a keysym types: Latin-1 keysyms are code points, the rest
/// of Unicode sits at `0x0100_0000`.
fn keysym_to_char(keysym: u32) -> Option<char> {
    match keysym {
        0x20..=0x7e | 0xa0..=0xff => char::from_u32(keysym),
        0x0100_0000..=0x0110_ffff => char::from_u32(keysym & 0x00ff_ffff),
        _ => None,
    }
}

/// Key position of a keysym on a US keyboard, for viewers that report no
/// position.
fn keysym_to_scancode(keysym: u32) -> Option<(bool, u8)> {
    let special = match keysym {
        0xff08 => (false, 0x0e), // Backspace
        0xff09 => (false, 0x0f), // Tab
        0xff0d => (false, 0x1c), // Enter
        0xff1b => (false, 0x01), // Escape
        0xffff => (true, 0x53),  // Delete
        0xff50 => (true, 0x47),  // Home
        0xff51 => (true, 0x4b),  // Left
        0xff52 => (true, 0x48),  // Up
        0xff53 => (true, 0x4d),  // Right
        0xff54 => (true, 0x50),  // Down
        0xff55 => (true, 0x49),  // Page Up
        0xff56 => (true, 0x51),  // Page Down
        0xff57 => (true, 0x4f),  // End
        0xff63 => (true, 0x52),  // Insert
        0xffe1 => (false, 0x2a), // Left Shift
        0xffe2 => (false, 0x36), // Right Shift
        0xffe3 => (false, 0x1d), // Left Control
        0xffe4 => (true, 0x1d),  // Right Control
        0xffe9 => (false, 0x38), // Left Alt
        0xffea => (true, 0x38),  // Right Alt
        0xffeb => (true, 0x5b),  // Left Meta
        0xffec => (true, 0x5c),  // Right Meta
        0xffe5 => (false, 0x3a), // Caps Lock
        0xffbe..=0xffc7 => (false, 0x3b + u8::try_from(keysym - 0xffbe).ok()?), // F1 to F10
        0xffc8 => (false, 0x57), // F11
        0xffc9 => (false, 0x58), // F12
        _ => return printable_scancode(keysym).map(|code| (false, code)),
    };
    Some(special)
}

fn printable_scancode(keysym: u32) -> Option<u8> {
    Some(match char::from_u32(keysym)?.to_ascii_lowercase() {
        '1' | '!' => 0x02,
        '2' | '@' => 0x03,
        '3' | '#' => 0x04,
        '4' | '$' => 0x05,
        '5' | '%' => 0x06,
        '6' | '^' => 0x07,
        '7' | '&' => 0x08,
        '8' | '*' => 0x09,
        '9' | '(' => 0x0a,
        '0' | ')' => 0x0b,
        '-' | '_' => 0x0c,
        '=' | '+' => 0x0d,
        'q' => 0x10,
        'w' => 0x11,
        'e' => 0x12,
        'r' => 0x13,
        't' => 0x14,
        'y' => 0x15,
        'u' => 0x16,
        'i' => 0x17,
        'o' => 0x18,
        'p' => 0x19,
        '[' | '{' => 0x1a,
        ']' | '}' => 0x1b,
        'a' => 0x1e,
        's' => 0x1f,
        'd' => 0x20,
        'f' => 0x21,
        'g' => 0x22,
        'h' => 0x23,
        'j' => 0x24,
        'k' => 0x25,
        'l' => 0x26,
        ';' | ':' => 0x27,
        '\'' | '"' => 0x28,
        '`' | '~' => 0x29,
        '\\' | '|' => 0x2b,
        'z' => 0x2c,
        'x' => 0x2d,
        'c' => 0x2e,
        'v' => 0x2f,
        'b' => 0x30,
        'n' => 0x31,
        'm' => 0x32,
        ',' | '<' => 0x33,
        '.' | '>' => 0x34,
        '/' | '?' => 0x35,
        ' ' => 0x39,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use gated_core::Scancode as KeyPosition;

    use super::*;

    fn translate_key(keysym: Option<u32>, scancode: Option<KeyPosition>) -> Vec<Operation> {
        let mut ops = vec![];
        translate(
            DesktopInput::Key {
                keysym,
                scancode,
                down: true,
            },
            &mut ops,
        );
        ops
    }

    #[test]
    fn the_key_position_wins_over_the_character() {
        let ops = translate_key(
            Some(u32::from('a')),
            Some(KeyPosition {
                code: 0x10,
                extended: false,
            }),
        );
        assert!(
            matches!(*ops.as_slice(), [Operation::KeyPressed(s)] if s.as_u8() == (false, 0x10))
        );
    }

    #[test]
    fn a_character_alone_falls_back_to_the_us_layout_then_to_unicode() {
        let ops = translate_key(Some(u32::from('a')), None);
        assert!(
            matches!(*ops.as_slice(), [Operation::KeyPressed(s)] if s.as_u8() == (false, 0x1e))
        );

        let ops = translate_key(Some(u32::from('é')), None);
        assert!(matches!(
            *ops.as_slice(),
            [Operation::UnicodeKeyPressed('é')]
        ));

        // Outside Latin-1 the keysym is the code point plus 0x01000000.
        let ops = translate_key(Some(0x0100_4e2d), None);
        assert!(matches!(
            *ops.as_slice(),
            [Operation::UnicodeKeyPressed('中')]
        ));
    }

    #[test]
    fn left_and_right_modifiers_stay_distinct() {
        let ops = translate_key(Some(0xffe4), None);
        assert!(matches!(*ops.as_slice(), [Operation::KeyPressed(s)] if s.as_u8() == (true, 0x1d)));
    }

    #[test]
    fn a_key_that_is_neither_a_position_nor_a_character_is_dropped() {
        assert!(translate_key(None, None).is_empty());
        // A function keysym with no position on the US layout.
        assert!(translate_key(Some(0xff14), None).is_empty());
    }

    #[test]
    fn the_pointer_sets_every_button() {
        let mut ops = vec![];
        translate(
            DesktopInput::Pointer {
                x: 3,
                y: 4,
                buttons: 0b101,
            },
            &mut ops,
        );
        assert!(matches!(
            *ops.as_slice(),
            [
                Operation::MouseMove(MousePosition { x: 3, y: 4 }),
                Operation::MouseButtonPressed(MouseButton::Left),
                Operation::MouseButtonReleased(MouseButton::Middle),
                Operation::MouseButtonPressed(MouseButton::Right),
            ]
        ));
    }

    #[test]
    fn wheel_notches_are_capped() {
        let mut ops = vec![];
        translate(
            DesktopInput::Wheel {
                x: 0,
                y: 0,
                vertical: true,
                delta: i16::MIN,
            },
            &mut ops,
        );
        assert!(matches!(
            *ops.as_slice(),
            [Operation::WheelRotations(WheelRotations {
                is_vertical: true,
                rotation_units: -1200,
            })]
        ));
    }
}
