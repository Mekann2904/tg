use serde::Deserialize;

/// Mouse button variants matching the TypeScript protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    #[default]
    Left,
    Middle,
    Right,
    Back,
    Forward,
    #[serde(other)]
    None,
}

/// Keyboard/mouse modifier flags.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct Modifiers {
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub meta: bool,
}

/// Typed command from the Bun/TypeScript host.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    #[serde(rename = "stop")]
    Stop,

    #[serde(rename = "navigate")]
    Navigate { url: String },

    #[serde(rename = "resize")]
    Resize {
        width: u32,
        #[serde(default = "default_height")]
        height: u32,
    },

    #[serde(rename = "click")]
    Click {
        x: i32,
        y: i32,
        #[serde(default)]
        button: MouseButton,
        #[serde(default = "default_one", alias = "clickCount")]
        click_count: u8,
        #[serde(default)]
        modifiers: Modifiers,
    },

    #[serde(rename = "mouseDown")]
    MouseDown {
        x: i32,
        y: i32,
        #[serde(default)]
        button: MouseButton,
        #[serde(default = "default_one", alias = "clickCount")]
        click_count: u8,
        #[serde(default)]
        modifiers: Modifiers,
    },

    #[serde(rename = "mouseUp")]
    MouseUp {
        x: i32,
        y: i32,
        #[serde(default)]
        button: MouseButton,
        #[serde(default = "default_one", alias = "clickCount")]
        click_count: u8,
        #[serde(default)]
        modifiers: Modifiers,
    },

    #[serde(rename = "mouseMove")]
    MouseMove {
        x: i32,
        y: i32,
        #[serde(default)]
        button: Option<MouseButton>,
        #[serde(default)]
        modifiers: Modifiers,
    },

    #[serde(rename = "wheel")]
    Wheel {
        x: i32,
        y: i32,
        #[serde(default, alias = "deltaX")]
        delta_x: i32,
        #[serde(default, alias = "deltaY")]
        delta_y: i32,
        #[serde(default)]
        modifiers: Modifiers,
    },

    #[serde(rename = "key")]
    Key {
        key: String,
        #[serde(default)]
        modifiers: Modifiers,
    },

    #[serde(rename = "text")]
    Text { text: String },

    #[serde(rename = "insertText")]
    InsertText { text: String },
}

const fn default_height() -> u32 {
    800
}
const fn default_one() -> u8 {
    1
}

impl Command {
    pub fn parse(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }
}
