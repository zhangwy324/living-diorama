//! The window settings file (ADR 0008 §9): `settings.json` in the app config directory. Parsing
//! and writing are plain functions over a path, so they are unit tested without the app.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Deserializer, Serialize};

use crate::placement::{DEFAULT_STRIP_HEIGHT, NormalWindow, clamp_strip_height};

/// The file format version this build reads and writes. Adding an optional field keeps it: older
/// builds ignore fields they don't know, and newer ones give missing fields their defaults. The
/// normal window's geometry (ADR 0016 §5) was added that way, so 0.1 and 0.2 read each other's
/// files.
pub const SETTINGS_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub version: u32,
    /// Device name of the chosen monitor; `None` means the primary.
    pub monitor: Option<String>,
    /// Compact height in logical pixels, always within the limits once loaded.
    pub height: f64,
    pub always_on_top: bool,
    /// Whether the strip reserves its space, so maximized windows stop above it (ADR 0008 §10).
    pub reserve_space: bool,
    /// The normal window's geometry, once it has been expanded (ADR 0016 §5).
    #[serde(
        deserialize_with = "normal_window_or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub expanded: Option<NormalWindow>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            monitor: None,
            height: DEFAULT_STRIP_HEIGHT,
            always_on_top: false,
            reserve_space: true,
            expanded: None,
        }
    }
}

/// A malformed normal window is forgotten, rather than costing the other settings their values.
fn normal_window_or_none<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<NormalWindow>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

/// Parses the file's contents. Missing fields take their defaults and the height is clamped, so a
/// hand-edited file can't produce a bad window. Another version is an error rather than a guess.
pub fn parse(json: &str) -> Result<Settings, String> {
    let mut settings: Settings = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if settings.version != SETTINGS_VERSION {
        return Err(format!("unsupported version {}", settings.version));
    }
    settings.height = clamp_strip_height(settings.height);
    Ok(settings)
}

/// Reads the settings, or the defaults when the file is missing. An unreadable file is logged and
/// also means defaults: losing window settings is never worth refusing to start.
pub fn load(path: &Path) -> Settings {
    match fs::read_to_string(path) {
        Ok(json) => parse(&json).unwrap_or_else(|error| {
            log::warn!("Ignoring {}: {error}", path.display());
            Settings::default()
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Settings::default(),
        Err(error) => {
            log::warn!("Could not read {}: {error}", path.display());
            Settings::default()
        }
    }
}

/// Writes the settings to `path`. Creates the directory if needed.
pub fn save(path: &Path, settings: &Settings) -> io::Result<()> {
    write_json(path, settings)
}

/// Writes `value` as JSON to a temporary file next to `path`, then renames it over `path`, so a
/// crash mid-write never leaves a torn file. Creates the directory if needed.
pub fn write_json(path: &Path, value: &impl Serialize) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(value).map_err(io::Error::other)?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, json)?;
    fs::rename(&temporary, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::placement::MAX_STRIP_HEIGHT;

    /// A fresh directory under the system temp dir, removed when dropped.
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("living-diorama-test-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn round_trips_through_the_file() {
        let dir = TempDir::new("round-trip");
        let path = dir.0.join("nested").join("settings.json");
        let settings = Settings {
            monitor: Some(r"\\.\DISPLAY2".to_owned()),
            height: 240.0,
            always_on_top: true,
            reserve_space: false,
            expanded: Some(NormalWindow {
                monitor: Some(r"\\.\DISPLAY1".to_owned()),
                scale_factor: 1.5,
                x: -9,
                y: 120,
                width: 1600,
                height: 900,
                maximized: true,
                full_screen: false,
            }),
            ..Settings::default()
        };
        save(&path, &settings).unwrap();
        save(&path, &settings).unwrap(); // replaces an existing file
        assert_eq!(load(&path), settings);
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn missing_file_means_defaults() {
        let dir = TempDir::new("missing");
        assert_eq!(load(&dir.0.join("settings.json")), Settings::default());
    }

    #[test]
    fn missing_fields_take_defaults() {
        let settings = parse(r#"{ "version": 1, "alwaysOnTop": true }"#).unwrap();
        assert_eq!(
            settings,
            Settings {
                always_on_top: true,
                ..Settings::default()
            }
        );
    }

    #[test]
    fn reads_a_file_written_before_the_normal_window_was_saved() {
        // Version 0.1.0's file: the same version, without `expanded`.
        let old = r#"{ "version": 1, "monitor": null, "height": 240.0, "alwaysOnTop": false, "reserveSpace": true }"#;
        let settings = parse(old).unwrap();
        assert_eq!(settings.expanded, None);
        assert_eq!(settings.height, 240.0);
        // Nothing saved, nothing written.
        let json = serde_json::to_string(&settings).unwrap();
        assert!(!json.contains("expanded"));
    }

    #[test]
    fn a_malformed_normal_window_is_forgotten_alone() {
        let json = r#"{ "version": 1, "height": 240, "expanded": { "x": "left" } }"#;
        let settings = parse(json).unwrap();
        assert_eq!(settings.expanded, None);
        assert_eq!(settings.height, 240.0);
    }

    #[test]
    fn clamps_the_height() {
        let settings = parse(r#"{ "version": 1, "height": 5000 }"#).unwrap();
        assert_eq!(settings.height, MAX_STRIP_HEIGHT);
    }

    #[test]
    fn rejects_garbage_and_other_versions() {
        assert!(parse("not json").is_err());
        assert!(parse(r#"{ "version": 2 }"#).is_err());
        let dir = TempDir::new("garbage");
        let path = dir.0.join("settings.json");
        fs::create_dir_all(&dir.0).unwrap();
        fs::write(&path, "{ torn").unwrap();
        assert_eq!(load(&path), Settings::default());
    }
}
