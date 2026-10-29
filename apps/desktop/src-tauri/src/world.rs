//! The saved world: `world.json` in the data directory, with the save before it kept as
//! `world.prev.json`. Rust only stores the text; the frontend validates it, so the store never
//! interprets it beyond checking that it is JSON. The store is plain functions over a directory, so
//! it is unit tested without the app.

use std::fs;
use std::io;
use std::path::Path;
use std::sync::Mutex;

use serde::de::IgnoredAny;
use tauri::AppHandle;

use crate::storage::{self, read_limited};

const WORLD_FILE: &str = "world.json";
const BACKUP_FILE: &str = "world.prev.json";

/// Well above any world the app makes (a few dozen creatures), so a broken or hostile file can't
/// make the app read or send something huge.
const MAX_WORLD_BYTES: u64 = 16 * 1024 * 1024;

/// Saves run one at a time, so an autosave and the save on quit never write the same temporary
/// file at once.
static SAVING: Mutex<()> = Mutex::new(());

/// The saved world's text, or `None` when there is none. A missing or unreadable `world.json`
/// falls back to the backup; a file that is too large or not JSON counts as unreadable. Problems
/// are logged rather than returned: a lost save never stops the app.
pub fn load(dir: &Path) -> Option<String> {
    for file in [WORLD_FILE, BACKUP_FILE] {
        let path = dir.join(file);
        match read_world(&path) {
            Ok(json) => {
                if file == BACKUP_FILE {
                    log::warn!("Restoring the world from the backup {}", path.display());
                }
                return Some(json);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => log::warn!("Could not read the saved world {}: {error}", path.display()),
        }
    }
    None
}

fn read_world(path: &Path) -> io::Result<String> {
    let bytes = read_limited(path, MAX_WORLD_BYTES)?;
    let json = String::from_utf8(bytes).map_err(io::Error::other)?;
    serde_json::from_str::<IgnoredAny>(&json).map_err(io::Error::other)?;
    Ok(json)
}

/// Saves the world's text. The new file is written next to `world.json` first; the old
/// `world.json` then becomes `world.prev.json`, if `load` could read it, and the new one takes its
/// place. An unreadable `world.json` is just replaced, so it never overwrites a good backup. A
/// crash at any point leaves at least one complete save for `load`.
pub fn save(dir: &Path, json: &str) -> Result<(), String> {
    let size = json.len() as u64;
    if size > MAX_WORLD_BYTES {
        return Err(format!(
            "The world is {size} bytes, more than {MAX_WORLD_BYTES}"
        ));
    }
    let _saving = SAVING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let world = dir.join(WORLD_FILE);
    let pending = storage::pending_path(&world);
    // `storage::write_atomic`, with the old file moved to the backup just before the rename. The
    // new file is written aside first, so a failed write leaves both saves as they were.
    let write = || -> io::Result<()> {
        fs::create_dir_all(dir)?;
        storage::write_synced(&pending, json.as_bytes())?;
        if read_world(&world).is_ok() {
            fs::rename(&world, dir.join(BACKUP_FILE))?;
        }
        fs::rename(&pending, &world)
    };
    write().map_err(|error| {
        let _ = fs::remove_file(&pending);
        format!("Could not save the world to {}: {error}", world.display())
    })
}

/// The frontend's world commands. They are async so file access runs off the main thread.
pub mod commands {
    use super::*;

    #[tauri::command]
    pub async fn load_world(app: AppHandle) -> Result<Option<String>, String> {
        Ok(load(&storage::data_dir(&app)?))
    }

    #[tauri::command]
    pub async fn save_world(app: AppHandle, json: String) -> Result<(), String> {
        save(&storage::data_dir(&app)?, &json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A fresh directory under the system temp dir, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "living-diorama-world-{name}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            Self(dir)
        }

        fn read(&self, file: &str) -> Option<String> {
            fs::read_to_string(self.0.join(file)).ok()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn nothing_saved_means_none() {
        let dir = TempDir::new("none");
        assert_eq!(load(&dir.0), None); // no folder at all
        fs::create_dir_all(&dir.0).unwrap();
        assert_eq!(load(&dir.0), None);
    }

    #[test]
    fn round_trips_the_text_unchanged() {
        let dir = TempDir::new("round-trip");
        let json = r#"{ "saveVersion": 1,  "tick": 42 }"#;
        save(&dir.0, json).unwrap();
        assert_eq!(load(&dir.0).as_deref(), Some(json));
        assert!(!dir.0.join("world.json.tmp").exists());
        assert_eq!(dir.read(BACKUP_FILE), None); // nothing to keep yet
    }

    #[test]
    fn keeps_the_previous_save_as_the_backup() {
        let dir = TempDir::new("backup");
        save(&dir.0, r#"{"tick":1}"#).unwrap();
        save(&dir.0, r#"{"tick":2}"#).unwrap();
        save(&dir.0, r#"{"tick":3}"#).unwrap();
        assert_eq!(dir.read(WORLD_FILE).as_deref(), Some(r#"{"tick":3}"#));
        assert_eq!(dir.read(BACKUP_FILE).as_deref(), Some(r#"{"tick":2}"#));
        assert_eq!(load(&dir.0).as_deref(), Some(r#"{"tick":3}"#));
    }

    #[test]
    fn an_unreadable_save_never_replaces_the_backup() {
        let dir = TempDir::new("unreadable-current");
        save(&dir.0, r#"{"tick":1}"#).unwrap();
        save(&dir.0, r#"{"tick":2}"#).unwrap();
        fs::write(dir.0.join(WORLD_FILE), "{ torn").unwrap();
        save(&dir.0, r#"{"tick":3}"#).unwrap();
        assert_eq!(dir.read(WORLD_FILE).as_deref(), Some(r#"{"tick":3}"#));
        assert_eq!(dir.read(BACKUP_FILE).as_deref(), Some(r#"{"tick":1}"#));
    }

    #[test]
    fn a_missing_save_keeps_the_backup() {
        let dir = TempDir::new("missing-current");
        save(&dir.0, r#"{"tick":1}"#).unwrap();
        save(&dir.0, r#"{"tick":2}"#).unwrap();
        fs::remove_file(dir.0.join(WORLD_FILE)).unwrap();
        save(&dir.0, r#"{"tick":3}"#).unwrap();
        assert_eq!(dir.read(WORLD_FILE).as_deref(), Some(r#"{"tick":3}"#));
        assert_eq!(dir.read(BACKUP_FILE).as_deref(), Some(r#"{"tick":1}"#));
    }

    #[test]
    fn falls_back_to_the_backup() {
        let dir = TempDir::new("fallback");
        save(&dir.0, r#"{"tick":1}"#).unwrap();
        save(&dir.0, r#"{"tick":2}"#).unwrap();

        // Missing, as after a crash between the two renames.
        fs::remove_file(dir.0.join(WORLD_FILE)).unwrap();
        assert_eq!(load(&dir.0).as_deref(), Some(r#"{"tick":1}"#));

        // Not JSON.
        fs::write(dir.0.join(WORLD_FILE), "{ torn").unwrap();
        assert_eq!(load(&dir.0).as_deref(), Some(r#"{"tick":1}"#));

        // Not UTF-8.
        fs::write(dir.0.join(WORLD_FILE), [0xff, 0xfe]).unwrap();
        assert_eq!(load(&dir.0).as_deref(), Some(r#"{"tick":1}"#));

        // Neither file readable.
        fs::write(dir.0.join(BACKUP_FILE), "").unwrap();
        assert_eq!(load(&dir.0), None);
    }

    #[test]
    fn a_failed_save_keeps_both_files() {
        let dir = TempDir::new("failed");
        save(&dir.0, r#"{"tick":1}"#).unwrap();
        save(&dir.0, r#"{"tick":2}"#).unwrap();
        // A folder in the way of the temporary file makes the write fail.
        fs::create_dir_all(dir.0.join("world.json.tmp")).unwrap();
        assert!(save(&dir.0, r#"{"tick":3}"#).is_err());
        assert_eq!(dir.read(WORLD_FILE).as_deref(), Some(r#"{"tick":2}"#));
        assert_eq!(dir.read(BACKUP_FILE).as_deref(), Some(r#"{"tick":1}"#));
    }

    #[test]
    fn limits_the_size() {
        let dir = TempDir::new("size");
        save(&dir.0, r#"{"tick":1}"#).unwrap();
        let huge = format!("\"{}\"", "x".repeat(MAX_WORLD_BYTES as usize));
        assert!(save(&dir.0, &huge).is_err());
        assert_eq!(load(&dir.0).as_deref(), Some(r#"{"tick":1}"#));

        // A file that grew on disk is unreadable, so the backup is used.
        save(&dir.0, r#"{"tick":2}"#).unwrap();
        fs::write(
            dir.0.join(WORLD_FILE),
            vec![b' '; MAX_WORLD_BYTES as usize + 1],
        )
        .unwrap();
        assert_eq!(load(&dir.0).as_deref(), Some(r#"{"tick":1}"#));
    }
}
