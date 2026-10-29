//! File helpers shared by the stores that keep the player's data: atomic writes, size-limited
//! reads and the data directory (with its development override). Plain functions over paths, so
//! they are unit tested without the app.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Writes `contents` to a temporary file next to `path` (`<name>.tmp`), then renames it over
/// `path`, so a crash mid-write never leaves a torn file. Creates the directory if needed.
pub fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let temporary = pending_path(path);
    write_synced(&temporary, contents)?;
    fs::rename(&temporary, path)
}

/// Writes `contents` to `path` and flushes it to disk before returning, so a rename that follows
/// never puts an empty or partial file in place after a power cut.
pub fn write_synced(path: &Path, contents: &[u8]) -> io::Result<()> {
    let mut file = fs::File::create(path)?;
    file.write_all(contents)?;
    file.sync_all()
}

/// The temporary file `write_atomic` writes before renaming it into place.
pub fn pending_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_owned();
    name.push(".tmp");
    path.with_file_name(name)
}

/// Reads a file of at most `max` bytes.
pub fn read_limited(path: &Path, max: u64) -> io::Result<Vec<u8>> {
    let size = fs::metadata(path)?.len();
    if size > max {
        return Err(io::Error::other(format!(
            "{} is {size} bytes, more than {max}",
            path.display()
        )));
    }
    fs::read(path)
}

/// In development builds, the folder named by this variable holds the player's data (the library
/// and the saved world) instead of the app data directory, so manual checks never touch the
/// player's own creatures. Release builds ignore it.
const DEV_DATA_DIR_VAR: &str = "LIVING_DIORAMA_DEV_DATA_DIR";

/// The folder holding the player's data: the development override if set, else the app data
/// directory.
pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dev_override = cfg!(debug_assertions)
        .then(|| std::env::var_os(DEV_DATA_DIR_VAR))
        .flatten();
    data_dir_in(dev_override.map(PathBuf::from), || {
        app.path()
            .app_data_dir()
            .map_err(|error| format!("No app data directory: {error}"))
    })
}

/// The override, if one is set and not empty, else the app data directory.
fn data_dir_in(
    dev_override: Option<PathBuf>,
    app_data: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    match dev_override.filter(|dir| !dir.as_os_str().is_empty()) {
        Some(dir) => Ok(dir),
        None => app_data(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh directory under the system temp dir, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "living-diorama-storage-{name}-{}",
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

    #[test]
    fn writes_atomically_and_replaces() {
        let dir = TempDir::new("atomic");
        let path = dir.0.join("nested").join("file.json");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert_eq!(
            pending_path(&path),
            dir.0.join("nested").join("file.json.tmp")
        );
        assert!(!pending_path(&path).exists());
    }

    #[test]
    fn limits_what_it_reads() {
        let dir = TempDir::new("limited");
        let path = dir.0.join("file");
        write_atomic(&path, b"12345").unwrap();
        assert_eq!(read_limited(&path, 5).unwrap(), b"12345");
        assert!(read_limited(&path, 4).is_err());
    }

    #[test]
    fn a_development_data_dir_replaces_the_app_data_dir() {
        let app_data = || Ok(PathBuf::from("app-data"));
        assert_eq!(
            data_dir_in(Some(PathBuf::from("dev-data")), app_data),
            Ok(PathBuf::from("dev-data"))
        );
        assert_eq!(data_dir_in(None, app_data), Ok(PathBuf::from("app-data")));
        assert_eq!(
            data_dir_in(Some(PathBuf::new()), app_data),
            Ok(PathBuf::from("app-data"))
        );
    }
}
