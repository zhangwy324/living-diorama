//! The species library (ADR 0014): one folder per species in `library/` under the app data
//! directory, holding `entry.json` and, for a drawn species, `drawing.json` and `appearance.png`.
//! A voxel species keeps its assembly inline in `entry.json` (ADR 0022 §17), so it has no other
//! files. Rust only stores the files; the frontend validates and migrates their contents. The
//! store is plain functions over a directory, so it is unit tested without the app.

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
/// app read or send something huge. An entry holds a voxel species' whole assembly (ADR 0022
/// §17). Its faces are capped, but not its runs: a part full of cubes alternating between two
/// colours is 32,768 runs for only 6,144 faces, and 21 such parts, about 4.2 MB of compact JSON,
/// fit under the face cap. 8 MB leaves room for that and for the species around it.
const MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024;
const MAX_DRAWING_BYTES: u64 = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;

/// A drawn species' files beside its entry: the drawing record and the image.
pub struct DrawnFiles<'a> {
    pub drawing: &'a Value,
    pub image: &'a [u8],
}

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

/// `entry.json`, once the drawing and the image are known to be both there or both absent. Rust
/// doesn't read the entry's kind of body: a drawn entry without either file is listed, and the
/// frontend's load of its image fails instead.
fn read_entry(dir: &Path) -> io::Result<Value> {
    let drawing = dir.join(DRAWING_FILE).is_file();
    let image = dir.join(IMAGE_FILE).is_file();
    if drawing != image {
        let missing = if drawing { IMAGE_FILE } else { DRAWING_FILE };
        return Err(io::Error::other(format!("{missing} is missing")));
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

/// Adds an entry, with a drawn species' files when given. Its files are written to a pending
/// folder that is then renamed into place, so an entry appears complete or not at all. Entries
/// never change, so an existing ID is an error.
pub fn save(
    library: &Path,
    id: &str,
    entry: &Value,
    drawn: Option<DrawnFiles>,
) -> Result<(), String> {
    let dir = entry_dir(library, id)?;
    if dir.exists() {
        return Err(format!("library entry {id} already exists"));
    }
    // Compact: pretty printing would put each number of a voxel assembly on its own line.
    let entry = serde_json::to_vec(entry).map_err(|error| error.to_string())?;
    let drawn = match drawn {
        Some(DrawnFiles { drawing, image }) => Some((
            serde_json::to_vec(drawing).map_err(|error| error.to_string())?,
            image,
        )),
        None => None,
    };
    let mut sizes = vec![(ENTRY_FILE, entry.len(), MAX_ENTRY_BYTES)];
    if let Some((drawing, image)) = &drawn {
        sizes.push((DRAWING_FILE, drawing.len(), MAX_DRAWING_BYTES));
        sizes.push((IMAGE_FILE, image.len(), MAX_IMAGE_BYTES));
    }
    for (file, size, max) in sizes {
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
        if let Some((drawing, image)) = &drawn {
            fs::write(pending.join(DRAWING_FILE), drawing)?;
            fs::write(pending.join(IMAGE_FILE), image)?;
        }
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

/// The drawn files a save sent: both or neither, since an entry is drawn or voxel.
fn drawn_files<'a>(
    drawing: &'a Option<Value>,
    image: &'a Option<Vec<u8>>,
) -> Result<Option<DrawnFiles<'a>>, String> {
    match (drawing, image) {
        (Some(drawing), Some(image)) => Ok(Some(DrawnFiles { drawing, image })),
        (None, None) => Ok(None),
        _ => Err("a drawing and its image are saved together".into()),
    }
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

    /// Saves an entry: a drawn species sends its drawing and image, a voxel one neither.
    #[tauri::command]
    pub async fn save_library_entry(
        app: AppHandle,
        id: String,
        entry: Value,
        drawing: Option<Value>,
        image: Option<Vec<u8>>,
    ) -> Result<(), String> {
        save(
            &library_dir(&app)?,
            &id,
            &entry,
            drawn_files(&drawing, &image)?,
        )
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
            Some(DrawnFiles {
                drawing: &json!({ "strokes": [] }),
                image: b"png",
            }),
        )
        .unwrap();
    }

    fn voxel_entry(id: &str) -> Value {
        json!({ "name": id, "body": { "kind": "voxel", "assembly": { "voxels": [32768, 1] } } })
    }

    /// A drawn sample's files, for saves that should fail.
    fn drawn<'a>(image: &'a [u8]) -> Option<DrawnFiles<'a>> {
        static DRAWING: Value = Value::Null;
        Some(DrawnFiles {
            drawing: &DRAWING,
            image,
        })
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
        assert!(save(&dir.0, ID, &json!({}), drawn(b"other")).is_err());
        assert!(save(&dir.0, ID, &voxel_entry(ID), None).is_err());
        assert_eq!(load_image(&dir.0, ID).unwrap(), b"png");
    }

    #[test]
    fn round_trips_a_voxel_entry() {
        let dir = TempDir::new("voxel");
        save(&dir.0, ID, &voxel_entry(ID), None).unwrap();
        save_sample(&dir.0, OTHER_ID);
        assert_eq!(
            list(&dir.0),
            vec![
                StoredEntry {
                    id: OTHER_ID.into(),
                    entry: json!({ "schemaVersion": 1, "name": OTHER_ID }),
                },
                StoredEntry {
                    id: ID.into(),
                    entry: voxel_entry(ID),
                },
            ]
        );
        // Only the entry is stored: the assembly is inline.
        let files: Vec<_> = fs::read_dir(dir.0.join(ID))
            .unwrap()
            .map(|file| file.unwrap().file_name())
            .collect();
        assert_eq!(files, [ENTRY_FILE]);
        assert!(load_drawing(&dir.0, ID).is_err());
        assert!(load_image(&dir.0, ID).is_err());

        delete(&dir.0, ID).unwrap();
        assert_eq!(list(&dir.0).len(), 1);
        assert!(!dir.0.join(ID).exists());
    }

    #[test]
    fn saves_a_drawing_and_its_image_together() {
        let drawing = Some(json!({}));
        let image = Some(b"png".to_vec());
        assert!(drawn_files(&drawing, &image).unwrap().is_some());
        assert!(drawn_files(&None, &None).unwrap().is_none());
        assert!(drawn_files(&drawing, &None).is_err());
        assert!(drawn_files(&None, &image).is_err());
    }

    #[test]
    fn rejects_ids_outside_the_library() {
        let dir = TempDir::new("outside");
        assert!(save(&dir.0, "../escape", &json!({}), drawn(b"")).is_err());
        assert!(save(&dir.0, "../escape", &voxel_entry(ID), None).is_err());
        assert!(save(&dir.0, r"..\escape", &voxel_entry(ID), None).is_err());
        assert!(load_image(&dir.0, "..").is_err());
        assert!(load_drawing(&dir.0, "../escape").is_err());
        assert!(delete(&dir.0, "..").is_err());
        assert!(!dir.0.parent().unwrap().join("escape").exists());
        assert!(!dir.0.exists());
    }

    #[test]
    fn takes_entries_up_to_the_limit() {
        let dir = TempDir::new("entry-limit");
        // A JSON string is its characters and two quotes.
        let entry = |bytes: u64| json!("x".repeat(bytes as usize - 2));
        assert!(save(&dir.0, OTHER_ID, &entry(MAX_ENTRY_BYTES + 1), None).is_err());
        assert!(!dir.0.join(OTHER_ID).exists());
        save(&dir.0, ID, &entry(MAX_ENTRY_BYTES), None).unwrap();
        assert_eq!(
            fs::metadata(dir.0.join(ID).join(ENTRY_FILE)).unwrap().len(),
            MAX_ENTRY_BYTES
        );
        assert_eq!(list(&dir.0)[0].entry, entry(MAX_ENTRY_BYTES));
    }

    #[test]
    fn rejects_oversized_files() {
        let dir = TempDir::new("oversized");
        let image = vec![0; MAX_IMAGE_BYTES as usize + 1];
        assert!(save(&dir.0, ID, &json!({}), drawn(&image)).is_err());
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
        // Missing its drawing.
        let undrawn = "33333333-0000-4000-8000-000000000000";
        save_sample(&dir.0, undrawn);
        fs::remove_file(dir.0.join(undrawn).join(DRAWING_FILE)).unwrap();
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
