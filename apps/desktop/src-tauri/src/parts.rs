//! The player's parts (ADR 0025 §6): one `<uuid>.json` file per part in `parts/` under the app
//! data directory, holding the voxel part and the drawing it was made from. Rust only stores the
//! files; the frontend validates their contents. The store is plain functions over a directory, so
//! it is unit tested without the app.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::storage::{self, is_lowercase_uuid, pending_path, read_limited, write_atomic};

const EXTENSION: &str = ".json";

/// Size limit, well above what Draw mode produces, so a broken or hostile file can't make the app
/// read or send something huge. The worst part Draw mode can make is a full 32³ box whose cubes
/// alternate between colour indices of three digits: 32,768 runs of `1,255,`, about 197 KB of
/// compact JSON. Its 255 colours, the drawing's 1,024 pixels of up to `255,` and its 255-colour
/// palette add about 9 KB more, so a worst-case entry is about 206 KB
/// (`worst_case_entry_fits`). 1 MiB leaves room for sockets and names, which aren't capped.
const MAX_PART_BYTES: u64 = 1024 * 1024;

/// Store operations run one at a time, so a list never removes the temporary file of a save that
/// is still writing it.
static STORE: Mutex<()> = Mutex::new(());

/// A part as stored: the file's ID and its contents, unvalidated.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StoredPart {
    pub id: String,
    pub entry: Value,
}

/// The file of part `id`. Part IDs are lowercase UUIDs, checked before any path is built, so the
/// frontend can't reach outside the parts folder.
fn part_path(parts: &Path, id: &str) -> Result<PathBuf, String> {
    if is_lowercase_uuid(id) {
        Ok(parts.join(format!("{id}{EXTENSION}")))
    } else {
        Err(format!("{id:?} is not a part ID"))
    }
}

/// Every readable part, by ID. Files that aren't parts are skipped, and a part that can't be read
/// (not JSON, or too large) is skipped with a warning: one bad file never stops the app. Leftovers
/// of an interrupted save are removed.
pub fn list(parts: &Path) -> Vec<StoredPart> {
    let files = match fs::read_dir(parts) {
        Ok(files) => files,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            log::warn!("Could not read the parts {}: {error}", parts.display());
            return Vec::new();
        }
    };
    let mut stored = Vec::new();
    for file in files.flatten() {
        let path = file.path();
        let name = file.file_name().to_string_lossy().into_owned();
        if !path.is_file() {
            continue;
        }
        let id = name.strip_suffix(EXTENSION);
        if let Some(id) = id.filter(|id| is_lowercase_uuid(id)) {
            match read_limited(&path, MAX_PART_BYTES)
                .and_then(|bytes| serde_json::from_slice(&bytes).map_err(io::Error::other))
            {
                Ok(entry) => stored.push(StoredPart {
                    id: id.to_owned(),
                    entry,
                }),
                Err(error) => log::warn!("Skipping part {id}: {error}"),
            }
        } else if is_leftover(&name) {
            if let Err(error) = fs::remove_file(&path) {
                log::warn!("Could not remove {}: {error}", path.display());
            }
        } else {
            log::warn!("Skipping {}: not a part", path.display());
        }
    }
    stored.sort_by(|a, b| a.id.cmp(&b.id));
    stored
}

/// Whether `name` is the temporary file of a save, `<uuid>.json.tmp`.
fn is_leftover(name: &str) -> bool {
    name.strip_suffix(".tmp")
        .and_then(|name| name.strip_suffix(EXTENSION))
        .is_some_and(is_lowercase_uuid)
}

/// Saves a part, adding it or replacing the one with its ID (an edit saves in place, ADR 0025 §7).
/// It is written to a temporary file that is then renamed into place, so a part is replaced whole
/// or not at all.
pub fn save(parts: &Path, id: &str, entry: &Value) -> Result<(), String> {
    let path = part_path(parts, id)?;
    // Compact: pretty printing would put each number of the cubes on its own line.
    let entry = serde_json::to_vec(entry).map_err(|error| error.to_string())?;
    if entry.len() as u64 > MAX_PART_BYTES {
        return Err(format!(
            "Part {id} is {} bytes, more than {MAX_PART_BYTES}",
            entry.len()
        ));
    }
    write_atomic(&path, &entry).map_err(|error| {
        let _ = fs::remove_file(pending_path(&path));
        format!("Could not save part {id}: {error}")
    })
}

/// Removes a part; a missing one is already removed.
pub fn delete(parts: &Path, id: &str) -> Result<(), String> {
    let path = part_path(parts, id)?;
    match fs::remove_file(&path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => {
            Err(format!("Could not delete part {id}: {error}"))
        }
        _ => Ok(()),
    }
}

/// `parts/` in the data directory (the development one, if set).
fn parts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    storage::data_dir(app).map(|dir| dir.join("parts"))
}

/// The frontend's parts commands. They are async so file access runs off the main thread.
pub mod commands {
    use super::*;

    fn locked<T>(run: impl FnOnce() -> T) -> T {
        let _store = STORE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        run()
    }

    #[tauri::command]
    pub async fn list_parts(app: AppHandle) -> Result<Vec<StoredPart>, String> {
        let parts = parts_dir(&app)?;
        Ok(locked(|| list(&parts)))
    }

    #[tauri::command]
    pub async fn save_part(app: AppHandle, id: String, entry: Value) -> Result<(), String> {
        let parts = parts_dir(&app)?;
        locked(|| save(&parts, &id, &entry))
    }

    #[tauri::command]
    pub async fn delete_part(app: AppHandle, id: String) -> Result<(), String> {
        let parts = parts_dir(&app)?;
        locked(|| delete(&parts, &id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "3f9c2a1e-0000-4000-8000-000000000000";
    const OTHER_ID: &str = "0a1b2c3d-0000-4000-8000-000000000000";

    /// A fresh directory under the system temp dir, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "living-diorama-parts-{name}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn entry(id: &str, version: u32) -> Value {
        json!({ "schemaVersion": 1, "id": format!("user-part:{id}"), "version": version })
    }

    fn file(parts: &Path, id: &str) -> PathBuf {
        parts.join(format!("{id}{EXTENSION}"))
    }

    #[test]
    fn saves_lists_and_deletes_parts() {
        let dir = TempDir::new("round-trip");
        let parts = dir.0.join("parts");
        assert_eq!(list(&parts), vec![]); // no parts folder yet
        save(&parts, ID, &entry(ID, 1)).unwrap();
        save(&parts, OTHER_ID, &entry(OTHER_ID, 1)).unwrap();
        assert_eq!(
            list(&parts),
            vec![
                StoredPart {
                    id: OTHER_ID.into(),
                    entry: entry(OTHER_ID, 1),
                },
                StoredPart {
                    id: ID.into(),
                    entry: entry(ID, 1),
                },
            ]
        );

        delete(&parts, OTHER_ID).unwrap();
        assert!(!file(&parts, OTHER_ID).exists());
        delete(&parts, OTHER_ID).unwrap(); // already gone
        let ids: Vec<_> = list(&parts).into_iter().map(|part| part.id).collect();
        assert_eq!(ids, [ID]);
    }

    #[test]
    fn an_edit_replaces_the_part() {
        let dir = TempDir::new("edit");
        save(&dir.0, ID, &entry(ID, 1)).unwrap();
        save(&dir.0, ID, &entry(ID, 2)).unwrap();
        assert_eq!(list(&dir.0)[0].entry, entry(ID, 2));
        let files: Vec<_> = fs::read_dir(&dir.0)
            .unwrap()
            .map(|file| file.unwrap().file_name())
            .collect();
        assert_eq!(files, [format!("{ID}{EXTENSION}").as_str()]);
    }

    #[test]
    fn rejects_ids_outside_the_parts() {
        let dir = TempDir::new("outside");
        for id in [
            "../escape",
            r"..\escape",
            "",
            "3F9C2A1E-0000-4000-8000-000000000000",
            "user-part:3f9c2a1e-0000-4000-8000-000000000000",
        ] {
            assert!(save(&dir.0, id, &entry(ID, 1)).is_err(), "{id}");
            assert!(delete(&dir.0, id).is_err(), "{id}");
        }
        assert!(!dir.0.parent().unwrap().join("escape.json").exists());
        assert!(!dir.0.exists());
    }

    #[test]
    fn takes_parts_up_to_the_limit() {
        let dir = TempDir::new("limit");
        // A JSON string is its characters and two quotes.
        let entry = |bytes: u64| json!("x".repeat(bytes as usize - 2));
        assert!(save(&dir.0, OTHER_ID, &entry(MAX_PART_BYTES + 1)).is_err());
        assert!(!file(&dir.0, OTHER_ID).exists());
        assert!(!pending_path(&file(&dir.0, OTHER_ID)).exists());
        save(&dir.0, ID, &entry(MAX_PART_BYTES)).unwrap();
        assert_eq!(
            fs::metadata(file(&dir.0, ID)).unwrap().len(),
            MAX_PART_BYTES
        );
        assert_eq!(list(&dir.0)[0].entry, entry(MAX_PART_BYTES));
    }

    #[test]
    fn worst_case_entry_fits() {
        // A full 32³ part of 255 colours whose every cube starts a new run, and a full drawing.
        let cubes = 32 * 32 * 32;
        let colors = vec!["#ffffff"; 255];
        let voxels: Vec<u32> = (0..cubes).flat_map(|_| [1, 255]).collect();
        let entry = json!({
            "schemaVersion": 1,
            "id": format!("user-part:{ID}"),
            "name": "Worst case",
            "version": 1,
            "createdAt": "2026-10-30T12:00:00.000Z",
            "updatedAt": "2026-10-30T12:00:00.000Z",
            "part": {
                "type": "hollow:torso",
                "size": { "x": 32, "y": 32, "z": 32 },
                "step": 0.0125,
                "colors": colors,
                "voxels": voxels,
                "attach": { "x": 16, "y": 16, "z": 16 },
                "sockets": [],
            },
            "drawing": {
                "pixels": vec![255; 32 * 32],
                "palette": colors,
                "view": "side",
                "rule": "puffy",
                "chubby": 1.75,
                "flatThickness": 1,
                "step": 0.0125,
            },
        });
        let bytes = serde_json::to_vec(&entry).unwrap().len() as u64;
        assert!(bytes < 210_000, "{bytes}");
        assert!(bytes * 4 < MAX_PART_BYTES, "{bytes}");
        let dir = TempDir::new("worst-case");
        save(&dir.0, ID, &entry).unwrap();
        assert_eq!(list(&dir.0)[0].entry, entry);
    }

    #[test]
    fn skips_unreadable_parts() {
        let dir = TempDir::new("unreadable");
        save(&dir.0, ID, &entry(ID, 1)).unwrap();
        // Not JSON.
        let broken = "11111111-0000-4000-8000-000000000000";
        fs::write(file(&dir.0, broken), "{ not json").unwrap();
        // Grown past the limit on disk.
        let large = "22222222-0000-4000-8000-000000000000";
        fs::write(file(&dir.0, large), vec![b' '; MAX_PART_BYTES as usize + 1]).unwrap();
        // Not parts at all.
        fs::write(dir.0.join("readme.txt"), "hi").unwrap();
        fs::write(dir.0.join("NOTES.json"), "{}").unwrap();
        fs::create_dir_all(
            dir.0
                .join(format!("33333333-0000-4000-8000-000000000000{EXTENSION}")),
        )
        .unwrap();

        let ids: Vec<_> = list(&dir.0).into_iter().map(|part| part.id).collect();
        assert_eq!(ids, [ID]);
        // Skipped, not removed.
        assert!(file(&dir.0, broken).exists());
        assert!(file(&dir.0, large).exists());
    }

    #[test]
    fn cleans_up_interrupted_saves() {
        let dir = TempDir::new("interrupted");
        save(&dir.0, ID, &entry(ID, 1)).unwrap();
        // A crash mid-save leaves the temporary file, and the part as it was.
        let pending = pending_path(&file(&dir.0, ID));
        fs::write(&pending, "{ half").unwrap();
        let unsaved = pending_path(&file(&dir.0, OTHER_ID));
        fs::write(&unsaved, "{ half").unwrap();
        let other = dir.0.join("notes.tmp");
        fs::write(&other, "hi").unwrap();

        assert_eq!(
            list(&dir.0),
            vec![StoredPart {
                id: ID.into(),
                entry: entry(ID, 1)
            }]
        );
        assert!(!pending.exists());
        assert!(!unsaved.exists());
        assert!(other.exists()); // not the store's

        // A save after a crash replaces a leftover.
        fs::write(&pending, "{ half").unwrap();
        save(&dir.0, ID, &entry(ID, 2)).unwrap();
        assert!(!pending.exists());
        assert_eq!(list(&dir.0)[0].entry, entry(ID, 2));
    }
}
