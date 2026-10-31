//! The species library (ADR 0014): one folder per species in `library/` under the app data
//! directory, holding `entry.json`. A voxel species keeps its assembly inline in it (ADR 0022 §17),
//! so it has no other files. Rust only stores the files; the frontend validates their contents.
//! The store is plain functions over a directory, so it is unit tested without the app.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::storage::{self, is_lowercase_uuid, read_limited};

const ENTRY_FILE: &str = "entry.json";
/// Suffix of a folder being written or deleted. Such a folder is never an entry, and listing
/// removes any a crash left behind.
const PENDING_SUFFIX: &str = ".tmp";

/// Size limits, well above what the Studio produces, so a broken or hostile file can't make the
/// app read or send something huge. An entry holds a voxel species' whole assembly (ADR 0022
/// §17). Its faces are capped, but not its runs: a part full of cubes alternating between two
/// colours is 32,768 runs for only 6,144 faces, and 21 such parts, about 4.2 MB of compact JSON,
/// fit under the face cap. 8 MB leaves room for that and for the species around it.
const MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024;

/// An entry as stored: the folder's ID and `entry.json`, unvalidated.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StoredEntry {
    pub id: String,
    pub entry: Value,
}

/// The folder of entry `id`. Entry IDs are lowercase UUIDs, checked before any path is built, so
/// the frontend can't reach outside the library.
fn entry_dir(library: &Path, id: &str) -> Result<PathBuf, String> {
    if is_lowercase_uuid(id) {
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
        if !is_lowercase_uuid(&name) {
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

/// The folder's `entry.json`. Other files in it, such as a drawn species' from before M23, are
/// ignored: the frontend skips an entry it can't load.
fn read_entry(dir: &Path) -> io::Result<Value> {
    read_json(&dir.join(ENTRY_FILE), MAX_ENTRY_BYTES)
}

/// Adds an entry. It is written to a pending folder that is then renamed into place, so an entry
/// appears complete or not at all. Entries never change, so an existing ID is an error.
pub fn save(library: &Path, id: &str, entry: &Value) -> Result<(), String> {
    let dir = entry_dir(library, id)?;
    if dir.exists() {
        return Err(format!("library entry {id} already exists"));
    }
    // Compact: pretty printing would put each number of a voxel assembly on its own line.
    let entry = serde_json::to_vec(entry).map_err(|error| error.to_string())?;
    if entry.len() as u64 > MAX_ENTRY_BYTES {
        return Err(format!(
            "{ENTRY_FILE} is {} bytes, more than {MAX_ENTRY_BYTES}",
            entry.len()
        ));
    }
    let pending = pending_dir(library, id);
    let write = || -> io::Result<()> {
        if pending.exists() {
            fs::remove_dir_all(&pending)?;
        }
        fs::create_dir_all(&pending)?;
        fs::write(pending.join(ENTRY_FILE), &entry)?;
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
    use std::sync::Mutex;

    /// Library operations run one at a time, so a listing never removes the pending folder of a
    /// save or delete in progress.
    static LIBRARY: Mutex<()> = Mutex::new(());

    #[tauri::command]
    pub async fn list_library(app: AppHandle) -> Result<Vec<StoredEntry>, String> {
        let library = library_dir(&app)?;
        Ok(storage::locked(&LIBRARY, || list(&library)))
    }

    #[tauri::command]
    pub async fn save_library_entry(
        app: AppHandle,
        id: String,
        entry: Value,
    ) -> Result<(), String> {
        let library = library_dir(&app)?;
        storage::locked(&LIBRARY, || save(&library, &id, &entry))
    }

    #[tauri::command]
    pub async fn delete_library_entry(app: AppHandle, id: String) -> Result<(), String> {
        let library = library_dir(&app)?;
        storage::locked(&LIBRARY, || delete(&library, &id))
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

    fn entry(id: &str) -> Value {
        json!({ "schemaVersion": 6, "name": id, "assembly": { "voxels": [32768, 1] } })
    }

    fn save_sample(library: &Path, id: &str) {
        save(library, id, &entry(id)).unwrap();
    }

    #[test]
    fn round_trips_an_entry() {
        let dir = TempDir::new("round-trip");
        let library = dir.0.join("library");
        assert_eq!(list(&library), vec![]); // no library folder yet
        save_sample(&library, ID);
        save_sample(&library, OTHER_ID);
        assert_eq!(
            list(&library),
            vec![
                StoredEntry {
                    id: OTHER_ID.into(),
                    entry: entry(OTHER_ID),
                },
                StoredEntry {
                    id: ID.into(),
                    entry: entry(ID),
                },
            ]
        );
        // Only the entry is stored: the assembly is inline.
        let files: Vec<_> = fs::read_dir(library.join(ID))
            .unwrap()
            .map(|file| file.unwrap().file_name())
            .collect();
        assert_eq!(files, [ENTRY_FILE]);
        assert!(!pending_dir(&library, ID).exists());
    }

    #[test]
    fn never_overwrites_an_entry() {
        let dir = TempDir::new("overwrite");
        save_sample(&dir.0, ID);
        assert!(save(&dir.0, ID, &json!({})).is_err());
        assert_eq!(list(&dir.0)[0].entry, entry(ID));
    }

    #[test]
    fn lists_an_entry_with_files_beside_it() {
        // A drawn species from before M23 still has its drawing and image: the folder is listed
        // by its entry, for the frontend to skip.
        let dir = TempDir::new("old-files");
        save_sample(&dir.0, ID);
        fs::write(dir.0.join(ID).join("appearance.png"), b"png").unwrap();
        assert_eq!(list(&dir.0)[0].entry, entry(ID));
    }

    #[test]
    fn rejects_ids_outside_the_library() {
        let dir = TempDir::new("outside");
        assert!(save(&dir.0, "../escape", &entry(ID)).is_err());
        assert!(save(&dir.0, r"..\escape", &entry(ID)).is_err());
        assert!(delete(&dir.0, "..").is_err());
        assert!(!dir.0.parent().unwrap().join("escape").exists());
        assert!(!dir.0.exists());
    }

    #[test]
    fn takes_entries_up_to_the_limit() {
        let dir = TempDir::new("entry-limit");
        // A JSON string is its characters and two quotes.
        let entry = |bytes: u64| json!("x".repeat(bytes as usize - 2));
        assert!(save(&dir.0, OTHER_ID, &entry(MAX_ENTRY_BYTES + 1)).is_err());
        assert!(!dir.0.join(OTHER_ID).exists());
        save(&dir.0, ID, &entry(MAX_ENTRY_BYTES)).unwrap();
        assert_eq!(
            fs::metadata(dir.0.join(ID).join(ENTRY_FILE)).unwrap().len(),
            MAX_ENTRY_BYTES
        );
        assert_eq!(list(&dir.0)[0].entry, entry(MAX_ENTRY_BYTES));
    }

    #[test]
    fn skips_oversized_entries() {
        // A file that grew on disk is skipped.
        let dir = TempDir::new("oversized");
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
        // No entry.
        let empty = "22222222-0000-4000-8000-000000000000";
        fs::create_dir_all(dir.0.join(empty)).unwrap();
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
