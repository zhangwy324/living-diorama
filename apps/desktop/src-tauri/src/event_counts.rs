//! The simulation event counts the soak test checks (ADR 0009 §5–6). The frontend counts them and
//! sends the totals on each change; they are written to `event-counts.json` in the app's local data
//! directory, where `tools/development/measure-app.ps1` reads them at the end of a run.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::settings;

const FILE_NAME: &str = "event-counts.json";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventCounts {
    pub stuck: u64,
    pub recovered: u64,
    pub path_failed: u64,
}

/// Replaces the file with these totals. Errors are logged: the counts only matter to measurements.
#[tauri::command]
pub fn record_event_counts(app: AppHandle, counts: EventCounts) {
    let path = match app.path().app_local_data_dir() {
        Ok(dir) => dir.join(FILE_NAME),
        Err(error) => {
            eprintln!("No local data directory, event counts will not be saved: {error}");
            return;
        }
    };
    if let Err(error) = settings::write_json(&path, &counts) {
        eprintln!("Could not save {}: {error}", path.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_the_frontends_field_names() {
        let counts = EventCounts {
            stuck: 2,
            recovered: 1,
            path_failed: 3,
        };
        let json = serde_json::to_value(counts).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "stuck": 2, "recovered": 1, "pathFailed": 3 })
        );
        assert_eq!(serde_json::from_value::<EventCounts>(json).unwrap(), counts);
    }
}
