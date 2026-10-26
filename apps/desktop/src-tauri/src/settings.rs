//! The window settings file (ADR 0008 §9): `settings.json` in the app config directory. Parsing
//! and writing are plain functions over a path, so they are unit tested without the app.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::placement::{DEFAULT_STRIP_HEIGHT, clamp_strip_height};

/// The file format version this build reads and writes.
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
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            monitor: None,
            height: DEFAULT_STRIP_HEIGHT,
            always_on_top: false,
        }
    }
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
            eprintln!("Ignoring {}: {error}", path.display());
            Settings::default()
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Settings::default(),
        Err(error) => {
            eprintln!("Could not read {}: {error}", path.display());
            Settings::default()
        }
    }
}

/// Writes the settings to a temporary file next to `path`, then renames it over `path`, so a crash
/// mid-write never leaves a torn file. Creates the directory if needed.
pub fn save(path: &Path, settings: &Settings) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(io::Error::other)?;
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
