#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
    None,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Modifiers {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
}

impl Modifiers {
    pub fn to_cef_flags(&self) -> u32 {
        let mut f: u32 = 0;
        if self.shift {
            f |= 0x0002; // EVENTFLAG_SHIFT_DOWN
        }
        if self.ctrl {
            f |= 0x0004; // EVENTFLAG_CONTROL_DOWN
        }
        if self.alt {
            f |= 0x0008; // EVENTFLAG_ALT_DOWN
        }
        if self.meta {
            f |= 0x0010; // EVENTFLAG_COMMAND_DOWN
        }
        f
    }
}
