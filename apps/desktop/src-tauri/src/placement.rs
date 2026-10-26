//! Where the strip goes (ADR 0008 §3–§5). Pure functions over plain data, so they are unit tested
//! without a window or a display.

/// Default compact strip height in logical pixels.
pub const DEFAULT_STRIP_HEIGHT: f64 = 220.0;
/// Compact strip height limits in logical pixels.
pub const MIN_STRIP_HEIGHT: f64 = 180.0;
pub const MAX_STRIP_HEIGHT: f64 = 260.0;
/// Share of the work area, in each dimension, that expanded mode covers.
const EXPANDED_FRACTION: f64 = 0.7;

/// A rectangle in physical (device) pixels on the virtual desktop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    fn bottom(&self) -> i32 {
        self.y + self.height as i32
    }
}

/// What placement needs to know about one monitor.
#[derive(Clone, Debug, PartialEq)]
pub struct MonitorInfo {
    /// OS device name, e.g. `\\.\DISPLAY2` on Windows. Used to remember the user's choice.
    pub name: Option<String>,
    /// The monitor minus the taskbar and other reserved areas.
    pub work_area: Rect,
    pub scale_factor: f64,
    pub primary: bool,
}

/// Clamps a requested strip height to the compact limits. Anything that is not a finite number
/// becomes the default, so a corrupt value can never produce a zero or huge window.
pub fn clamp_strip_height(logical: f64) -> f64 {
    if logical.is_finite() {
        logical.clamp(MIN_STRIP_HEIGHT, MAX_STRIP_HEIGHT)
    } else {
        DEFAULT_STRIP_HEIGHT
    }
}

/// The monitor the strip lives on: the preferred one by name if it is connected, else the
/// primary, else the first. `None` only when there are no monitors at all.
pub fn choose_monitor<'a>(
    monitors: &'a [MonitorInfo],
    preferred: Option<&str>,
) -> Option<&'a MonitorInfo> {
    preferred
        .and_then(|name| monitors.iter().find(|m| m.name.as_deref() == Some(name)))
        .or_else(|| monitors.iter().find(|m| m.primary))
        .or_else(|| monitors.first())
}

/// The strip's window rectangle: the full work-area width, `height` logical pixels tall (clamped),
/// bottom edge on the work area's bottom edge. Never taller than the work area.
pub fn strip_rect(work_area: Rect, scale_factor: f64, height: f64) -> Rect {
    let physical = (clamp_strip_height(height) * scale_factor).round() as u32;
    let height = physical.min(work_area.height);
    Rect {
        x: work_area.x,
        y: work_area.bottom() - height as i32,
        width: work_area.width,
        height,
    }
}

/// The expanded window rectangle (ADR 0008 §8): 70% of the work area in each dimension, centred
/// on it.
pub fn expanded_rect(work_area: Rect) -> Rect {
    let width = (f64::from(work_area.width) * EXPANDED_FRACTION).round() as u32;
    let height = (f64::from(work_area.height) * EXPANDED_FRACTION).round() as u32;
    Rect {
        x: work_area.x + ((work_area.width - width) / 2) as i32,
        y: work_area.y + ((work_area.height - height) / 2) as i32,
        width,
        height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL_HD_WORK_AREA: Rect = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1032,
    };

    fn monitor(name: &str, primary: bool) -> MonitorInfo {
        MonitorInfo {
            name: Some(name.to_owned()),
            work_area: FULL_HD_WORK_AREA,
            scale_factor: 1.0,
            primary,
        }
    }

    #[test]
    fn clamps_height_to_limits() {
        assert_eq!(clamp_strip_height(100.0), MIN_STRIP_HEIGHT);
        assert_eq!(clamp_strip_height(240.0), 240.0);
        assert_eq!(clamp_strip_height(1000.0), MAX_STRIP_HEIGHT);
    }

    #[test]
    fn non_finite_height_becomes_default() {
        assert_eq!(clamp_strip_height(f64::NAN), DEFAULT_STRIP_HEIGHT);
        assert_eq!(clamp_strip_height(f64::INFINITY), DEFAULT_STRIP_HEIGHT);
    }

    #[test]
    fn strip_sits_on_the_work_area_bottom_at_full_width() {
        let rect = strip_rect(FULL_HD_WORK_AREA, 1.0, 220.0);
        assert_eq!(
            rect,
            Rect {
                x: 0,
                y: 812,
                width: 1920,
                height: 220
            }
        );
    }

    #[test]
    fn height_scales_with_the_monitor() {
        // 4K at 150%, taskbar 72 px tall.
        let work_area = Rect {
            x: 0,
            y: 0,
            width: 3840,
            height: 2088,
        };
        assert_eq!(strip_rect(work_area, 1.5, 220.0).height, 330);
        assert_eq!(strip_rect(work_area, 2.0, 220.0).height, 440);
        assert_eq!(strip_rect(work_area, 2.0, 220.0).y, 2088 - 440);
    }

    #[test]
    fn follows_a_work_area_that_is_offset_on_the_virtual_desktop() {
        // A secondary monitor to the left and above the primary, taskbar on the left.
        let work_area = Rect {
            x: -1860,
            y: -200,
            width: 1860,
            height: 1080,
        };
        let rect = strip_rect(work_area, 1.0, 200.0);
        assert_eq!((rect.x, rect.y, rect.width), (-1860, 680, 1860));
    }

    #[test]
    fn never_taller_than_the_work_area() {
        let tiny = Rect {
            x: 0,
            y: 0,
            width: 800,
            height: 150,
        };
        assert_eq!(strip_rect(tiny, 1.0, 220.0), tiny);
    }

    #[test]
    fn chooses_the_preferred_monitor_when_connected() {
        let monitors = [monitor("A", true), monitor("B", false)];
        let chosen = choose_monitor(&monitors, Some("B")).unwrap();
        assert_eq!(chosen.name.as_deref(), Some("B"));
    }

    #[test]
    fn falls_back_to_the_primary_then_the_first() {
        let monitors = [monitor("A", false), monitor("B", true)];
        assert_eq!(
            choose_monitor(&monitors, Some("gone"))
                .unwrap()
                .name
                .as_deref(),
            Some("B")
        );
        assert_eq!(
            choose_monitor(&monitors, None).unwrap().name.as_deref(),
            Some("B")
        );
        let no_primary = [monitor("A", false), monitor("B", false)];
        assert_eq!(
            choose_monitor(&no_primary, None).unwrap().name.as_deref(),
            Some("A")
        );
        assert!(choose_monitor(&[], None).is_none());
    }

    #[test]
    fn expanded_covers_the_middle_of_the_work_area() {
        assert_eq!(
            expanded_rect(FULL_HD_WORK_AREA),
            Rect {
                x: 288,
                y: 155,
                width: 1344,
                height: 722
            }
        );
        let offset = Rect {
            x: -1860,
            y: -200,
            width: 1860,
            height: 1080,
        };
        let rect = expanded_rect(offset);
        assert_eq!((rect.x, rect.y), (-1860 + 279, -200 + 162));
    }
}
