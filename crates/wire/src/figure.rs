//! The figure a person is drawn as: the parts and the colours. Chosen for them, so nobody has to choose one to be
//! seen, and the parts name styles from one small vocabulary — the day a sprite set arrives its names join the
//! same list rather than changing the protocol.

use serde::{Deserialize, Serialize};

/// The styles the drawing knows, part by part. A part travels as a string rather than a variant on purpose: a
/// sprite name can stand where a drawn style stands without the message changing shape. An unknown name is
/// refused, never quietly drawn as something else.
pub const HEAD_STYLES: [&str; 3] = ["round", "oval", "bald"];
pub const BODY_STYLES: [&str; 3] = ["plain", "broad", "slight"];
pub const ARM_STYLES: [&str; 3] = ["sides", "folded", "open"];

/// The parts of a figure, each named by a style the drawing knows — see the vocabulary above. `None`
/// means "the style this part is drawn in by default", which every client resolves the same way, so a
/// figure nobody has touched is still a whole figure.
#[derive(Clone, Default, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Parts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arms: Option<String>,
}

impl Parts {
    /// Refuse a name the drawing has no style for, part by part. Absent is fine: it is the default.
    pub fn check(&self) -> Result<(), String> {
        for (part, name, styles) in [
            ("head", self.head.as_deref(), &HEAD_STYLES[..]),
            ("body", self.body.as_deref(), &BODY_STYLES[..]),
            ("arms", self.arms.as_deref(), &ARM_STYLES[..]),
        ] {
            if let Some(name) = name {
                if !styles.contains(&name) {
                    return Err(format!("{name:?} is not a {part} this build draws"));
                }
            }
        }
        Ok(())
    }
}

/// The colours, as hex `#rrggbb`: any colour the editor can hand somebody, without the wire learning a second way
/// to say one. A string that is not a colour is refused, never repaired.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Palette {
    pub skin: String,
    pub hair: String,
    pub shirt: String,
    pub trousers: String,
}

impl Palette {
    fn new((skin, hair, shirt, trousers): (&str, &str, &str, &str)) -> Palette {
        Palette {
            skin: skin.to_string(),
            hair: hair.to_string(),
            shirt: shirt.to_string(),
            trousers: trousers.to_string(),
        }
    }
}

impl Default for Palette {
    fn default() -> Self {
        Palette::new(("#e8b98c", "#3a2a20", "#38bdf8", "#334155"))
    }
}

/// A figure a person owns.
#[derive(Clone, Default, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Figure {
    #[serde(default)]
    pub parts: Parts,
    #[serde(default)]
    pub palette: Palette,
}

/// The figures handed to people who chose nothing: shirts far enough apart in hue that neighbours are told apart
/// at a glance. Order fixed, so every client names the same figure for the same person.
const WEARABLE: [(&str, &str, &str, &str); 8] = [
    ("#f1c9a5", "#2f2a26", "#38bdf8", "#334155"), // sky
    ("#e8b98c", "#1f1a17", "#f472b6", "#3f3f46"), // pink
    ("#c68642", "#3a2a20", "#facc15", "#44403c"), // yellow
    ("#8d5524", "#100c0a", "#4ade80", "#3f3f46"), // green
    ("#f1c9a5", "#6b4f2a", "#c084fc", "#334155"), // purple
    ("#e8b98c", "#2f2a26", "#fb923c", "#3f3f46"), // orange
    ("#c68642", "#100c0a", "#f87171", "#334155"), // red
    ("#8d5524", "#3a2a20", "#2dd4bf", "#44403c"), // teal
];

impl Figure {
    /// Everything a figure must be: four colours a canvas can paint and parts the drawing has a style for. Checked,
    /// never repaired — a figure is the person's own.
    pub fn check(&self) -> Result<(), String> {
        for (what, value) in [
            ("skin", &self.palette.skin),
            ("hair", &self.palette.hair),
            ("shirt", &self.palette.shirt),
            ("trousers", &self.palette.trousers),
        ] {
            if !is_colour(value) {
                return Err(format!("{what} is {value:?}, not a #rrggbb colour"));
            }
        }
        self.parts.check()
    }

    /// The figure person `id` wears when they have chosen nothing. Choosing by id rather than at random
    /// means everybody computes the same one and no two neighbours share a shirt by accident.
    pub fn for_id(id: u64) -> Figure {
        Figure { parts: Parts::default(), palette: Palette::new(WEARABLE[(id as usize) % WEARABLE.len()]) }
    }
}

/// A colour exactly as the wire carries it: `#` and six hex digits, and nothing else. A short hex or a
/// name is not a colour here, so it is refused rather than guessed at.
fn is_colour(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_figure_names_a_style_for_a_part_and_the_name_travels_as_a_string() {
        // The seam: a part is a name on the wire, not an enum, so a sprite name can stand where a drawn
        // style stands today without the message changing shape.
        let mut figure = Figure::for_id(0);
        figure.parts.head = Some("oval".to_string());
        figure.check().expect("a style the drawing knows");
        let text = serde_json::to_string(&figure).unwrap();
        assert!(text.contains("\"head\":\"oval\""), "{text}");
        let again: Figure = serde_json::from_str(&text).unwrap();
        assert_eq!(again, figure);
        // A figure with nothing named is still a figure: each part falls back to the style the client draws.
        let bare: Figure = serde_json::from_str("{}").unwrap();
        assert_eq!(bare.parts, Parts::default());
        assert_eq!(bare, Figure::default());
        assert!(bare.check().is_ok(), "nothing named is a whole figure");
    }

    #[test]
    fn a_colour_that_is_not_a_colour_is_refused_and_a_part_the_drawing_does_not_know_is_too() {
        // Refused, never repaired: the person chose it, and the server will not change it into something
        // else. A name it cannot draw is the same kind of problem as a colour it cannot paint.
        let mut wrong_colour = Figure::for_id(1);
        wrong_colour.palette.shirt = "blue".to_string();
        let problem = wrong_colour.check().unwrap_err();
        assert!(problem.contains("shirt"), "{problem}");
        assert!(problem.contains("#rrggbb"), "{problem}");

        let mut short_hex = Figure::for_id(1);
        short_hex.palette.skin = "#abc".to_string();
        assert!(short_hex.check().is_err(), "a short hex is not a colour");

        let mut wrong_part = Figure::for_id(1);
        wrong_part.parts.arms = Some("tentacles".to_string());
        let problem = wrong_part.check().unwrap_err();
        assert!(problem.contains("tentacles"), "{problem}");

        // And every figure handed out is one the drawing can draw.
        for id in 0..64 {
            assert!(Figure::for_id(id).check().is_ok(), "person {id} was handed a bad figure");
        }
    }
}
