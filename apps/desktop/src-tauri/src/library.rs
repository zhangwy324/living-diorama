//! The species library (ADR 0014): one folder per drawn species in `library/` under the app data
//! directory, holding `entry.json`, `drawing.json` and `appearance.png`. Rust only stores the files;
//! the frontend validates and migrates their contents. The store is plain functions over a
//! directory, so it is unit tested without the app.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, ipc::Response};

use crate::storage::{self, read_limited};

const ENTRY_FILE: &str = "entry.json";
const DRAWING_FILE: &str = "drawing.json";
const IMAGE_FILE: &str = "appearance.png";
/// Suffix of a folder being written or deleted. Such a folder is never an entry, and listing
/// removes any a crash left behind.
const PENDING_SUFFIX: &str = ".tmp";

/// Size limits, well above what the Studio produces, so a broken or hostile file can't make the
/// app read or send something huge.
const MAX_ENTRY_BYTES: u64 = 64 * 1024;
const MAX_DRAWING_BYTES: u64 = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;

/// An entry as stored: the folder's ID and `entry.json`, unvalidated.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StoredEntry {
    pub id: String,
    pub entry: Value,
}

/// Whether `id` is a lowercase UUID, the only folder names the library uses. Checked before any
/// path is built from an ID, so the frontend can't reach outside the library.
pub fn is_entry_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, &b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

fn entry_dir(library: &Path, id: &str) -> Result<PathBuf, String> {
    if is_entry_id(id) {
        Ok(library.join(id))
    } else {
        Err(format!("{id:?} is not a library entry ID"))
    }
}

fn pending_dir(library: &Path, id: &str) -> PathBuf {
    library.join(format!("{id}{PENDING_SUFFIX}"))
}

fn read_json(path: &Path, max: u64) -> io::Result<Value> {
    serde_json::from_slice(&read_limited(path, max)?).map_err(io::Error::other)
}

/// Every complete entry, by ID. Folders that aren't entries are skipped, and an entry that can't be
/// read is skipped with a warning: one bad file never stops the app. Leftovers of an interrupted
/// save or delete are removed.
pub fn list(library: &Path) -> Vec<StoredEntry> {
    let folders = match fs::read_dir(library) {
        Ok(folders) => folders,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            log::warn!("Could not read the library {}: {error}", library.display());
            return Vec::new();
        }
    };
    let mut entries = Vec::new();
    for folder in folders.flatten() {
        let path = folder.path();
        let name = folder.file_name().to_string_lossy().into_owned();
        if !path.is_dir() {
            continue;
        }
        if name.ends_with(PENDING_SUFFIX) {
            if let Err(error) = fs::remove_dir_all(&path) {
                log::warn!("Could not remove {}: {error}", path.display());
            }
            continue;
        }
        if !is_entry_id(&name) {
            log::warn!("Skipping {}: not a library entry", path.display());
            continue;
        }
        match read_entry(&path) {
            Ok(entry) => entries.push(StoredEntry { id: name, entry }),
            Err(error) => log::warn!("Skipping library entry {name}: {error}"),
        }
    }
    entries.sort_by(|a, b| a.id.cmp(&b.id));
    entries
}

/// `entry.json`, once the drawing and the image are known to be there too.
fn read_entry(dir: &Path) -> io::Result<Value> {
    for file in [DRAWING_FILE, IMAGE_FILE] {
        if !dir.join(file).is_file() {
            return Err(io::Error::other(format!("{file} is missing")));
        }
    }
    read_json(&dir.join(ENTRY_FILE), MAX_ENTRY_BYTES)
}

/// The entry's `drawing.json`, unvalidated.
pub fn load_drawing(library: &Path, id: &str) -> Result<Value, String> {
    let path = entry_dir(library, id)?.join(DRAWING_FILE);
    read_json(&path, MAX_DRAWING_BYTES).map_err(|error| error.to_string())
}

/// The entry's `appearance.png`.
pub fn load_image(library: &Path, id: &str) -> Result<Vec<u8>, String> {
    let path = entry_dir(library, id)?.join(IMAGE_FILE);
    read_limited(&path, MAX_IMAGE_BYTES).map_err(|error| error.to_string())
}

/// Adds an entry. Its files are written to a pending folder that is then renamed into place, so an
/// entry appears complete or not at all. Entries never change, so an existing ID is an error.
pub fn save(
    library: &Path,
    id: &str,
    entry: &Value,
    drawing: &Value,
    image: &[u8],
) -> Result<(), String> {
    let dir = entry_dir(library, id)?;
    if dir.exists() {
        return Err(format!("library entry {id} already exists"));
    }
    let entry = serde_json::to_vec_pretty(entry).map_err(|error| error.to_string())?;
    let drawing = serde_json::to_vec(drawing).map_err(|error| error.to_string())?;
    for (file, size, max) in [
        (ENTRY_FILE, entry.len(), MAX_ENTRY_BYTES),
        (DRAWING_FILE, drawing.len(), MAX_DRAWING_BYTES),
        (IMAGE_FILE, image.len(), MAX_IMAGE_BYTES),
    ] {
        if size as u64 > max {
            return Err(format!("{file} is {size} bytes, more than {max}"));
        }
    }
    let pending = pending_dir(library, id);
    let write = || -> io::Result<()> {
        if pending.exists() {
            fs::remove_dir_all(&pending)?;
        }
        fs::create_dir_all(&pending)?;
        fs::write(pending.join(ENTRY_FILE), &entry)?;
        fs::write(pending.join(DRAWING_FILE), &drawing)?;
        fs::write(pending.join(IMAGE_FILE), image)?;
        fs::rename(&pending, &dir)
    };
    write().map_err(|error| {
        let _ = fs::remove_dir_all(&pending);
        format!("Could not save library entry {id}: {error}")
    })
}

/// Removes an entry; a missing one is already removed. The folder is renamed first, so an
/// interrupted delete leaves a pending folder rather than a partial entry.
pub fn delete(library: &Path, id: &str) -> Result<(), String> {
    let dir = entry_dir(library, id)?;
    if !dir.exists() {
        return Ok(());
    }
    let pending = pending_dir(library, id);
    let remove = || -> io::Result<()> {
        if pending.exists() {
            fs::remove_dir_all(&pending)?;
        }
        fs::rename(&dir, &pending)?;
        fs::remove_dir_all(&pending)
    };
    remove().map_err(|error| format!("Could not delete library entry {id}: {error}"))
}

/// `library/` in the data directory (the development one, if set).
fn library_dir(app: &AppHandle) -> Result<PathBuf, String> {
    storage::data_dir(app).map(|dir| dir.join("library"))
}

/// The frontend's library commands. They are async so file access runs off the main thread.
pub mod commands {
    use super::*;

    #[tauri::command]
    pub async fn list_library(app: AppHandle) -> Result<Vec<StoredEntry>, String> {
        Ok(list(&library_dir(&app)?))
    }

    #[tauri::command]
    pub async fn load_library_drawing(app: AppHandle, id: String) -> Result<Value, String> {
        load_drawing(&library_dir(&app)?, &id)
    }

    /// The image's bytes, sent as raw binary rather than a JSON array.
    #[tauri::command]
    pub async fn load_library_image(app: AppHandle, id: String) -> Result<Response, String> {
        load_image(&library_dir(&app)?, &id).map(Response::new)
    }

    #[tauri::command]
    pub async fn save_library_entry(
        app: AppHandle,
        id: String,
        entry: Value,
        drawing: Value,
        image: Vec<u8>,
    ) -> Result<(), String> {
        save(&library_dir(&app)?, &id, &entry, &drawing, &image)
    }

    #[tauri::command]
    pub async fn delete_library_entry(app: AppHandle, id: String) -> Result<(), String> {
        delete(&library_dir(&app)?, &id)
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
                "living-diorama-library-{name}-{}",
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

    fn save_sample(library: &Path, id: &str) {
        save(
            library,
            id,
            &json!({ "schemaVersion": 1, "name": id }),
            &json!({ "strokes": [] }),
            b"png",
        )
        .unwrap();
    }

    #[test]
    fn accepts_only_lowercase_uuids() {
        assert!(is_entry_id(ID));
        for id in [
            "",
            "..",
            r"..\settings",
            "3F9C2A1E-0000-4000-8000-000000000000",
            "3f9c2a1e-0000-4000-8000-00000000000",
            "3f9c2a1e-0000-4000-8000-0000000000000",
            "3f9c2a1e00000-4000-8000-000000000000",
            "3f9c2a1e-0000-4000-8000-00000000000g",
        ] {
            assert!(!is_entry_id(id), "{id}");
        }
    }

    #[test]
    fn round_trips_an_entry() {
        let dir = TempDir::new("round-trip");
        let library = dir.0.join("library");
        assert_eq!(list(&library), vec![]); // no library folder yet
        save_sample(&library, OTHER_ID);
        save_sample(&library, ID);
        let ids: Vec<_> = list(&library).into_iter().map(|e| e.id).collect();
        assert_eq!(ids, [OTHER_ID, ID]);
        assert_eq!(
            list(&library)[1].entry,
            json!({ "schemaVersion": 1, "name": ID })
        );
        assert_eq!(
            load_drawing(&library, ID).unwrap(),
            json!({ "strokes": [] })
        );
        assert_eq!(load_image(&library, ID).unwrap(), b"png");
        assert!(!pending_dir(&library, ID).exists());
    }

    #[test]
    fn never_overwrites_an_entry() {
        let dir = TempDir::new("overwrite");
        save_sample(&dir.0, ID);
        assert!(save(&dir.0, ID, &json!({}), &json!({}), b"other").is_err());
        assert_eq!(load_image(&dir.0, ID).unwrap(), b"png");
    }

    #[test]
    fn rejects_ids_outside_the_library() {
        let dir = TempDir::new("outside");
        assert!(save(&dir.0, "../escape", &json!({}), &json!({}), b"").is_err());
        assert!(load_image(&dir.0, "..").is_err());
        assert!(delete(&dir.0, "..").is_err());
        assert!(!dir.0.parent().unwrap().join("escape").exists());
    }

    #[test]
    fn rejects_oversized_files() {
        let dir = TempDir::new("oversized");
        let image = vec![0; MAX_IMAGE_BYTES as usize + 1];
        assert!(save(&dir.0, ID, &json!({}), &json!({}), &image).is_err());
        assert!(!dir.0.join(ID).exists());

        // A file that grew on disk is skipped too.
        save_sample(&dir.0, ID);
        fs::write(
            dir.0.join(ID).join(ENTRY_FILE),
            vec![b' '; MAX_ENTRY_BYTES as usize + 1],
        )
        .unwrap();
        assert_eq!(list(&dir.0), vec![]);
    }

    #[test]
    fn deletes_an_entry() {
        let dir = TempDir::new("delete");
        save_sample(&dir.0, ID);
        delete(&dir.0, ID).unwrap();
        assert_eq!(list(&dir.0), vec![]);
        assert!(!dir.0.join(ID).exists());
        delete(&dir.0, ID).unwrap(); // already gone
    }

    #[test]
    fn skips_unreadable_entries() {
        let dir = TempDir::new("unreadable");
        save_sample(&dir.0, ID);
        // Not JSON.
        let broken = "11111111-0000-4000-8000-000000000000";
        save_sample(&dir.0, broken);
        fs::write(dir.0.join(broken).join(ENTRY_FILE), "{ not json").unwrap();
        // Missing its image.
        let partial = "22222222-0000-4000-8000-000000000000";
        save_sample(&dir.0, partial);
        fs::remove_file(dir.0.join(partial).join(IMAGE_FILE)).unwrap();
        // Not an entry at all.
        fs::create_dir_all(dir.0.join("notes")).unwrap();
        fs::write(dir.0.join("readme.txt"), "hi").unwrap();

        let ids: Vec<_> = list(&dir.0).into_iter().map(|e| e.id).collect();
        assert_eq!(ids, [ID]);
    }

    #[test]
    fn cleans_up_interrupted_saves() {
        let dir = TempDir::new("interrupted");
        let pending = pending_dir(&dir.0, ID);
        fs::create_dir_all(&pending).unwrap();
        fs::write(pending.join(ENTRY_FILE), "{}").unwrap();
        assert_eq!(list(&dir.0), vec![]);
        assert!(!pending.exists());
        // A save after a crash replaces the leftover.
        fs::create_dir_all(&pending).unwrap();
        save_sample(&dir.0, ID);
        assert_eq!(list(&dir.0).len(), 1);
    }
}
