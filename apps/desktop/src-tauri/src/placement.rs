//! Where the window goes, as the strip (ADR 0008 §3–§5) or the normal window (ADR 0016 §1, §5,
//! §8), and what each placement does with the strip's reserved band. Pure functions over plain
//! data, so they are unit tested without a window or a display.

use serde::{Deserialize, Serialize};

/// Default compact strip height in logical pixels.
pub const DEFAULT_STRIP_HEIGHT: f64 = 220.0;
/// Compact strip height limits in logical pixels.
pub const MIN_STRIP_HEIGHT: f64 = 180.0;
pub const MAX_STRIP_HEIGHT: f64 = 260.0;
/// Share of the work area, in each dimension, that the normal window's first restore size covers.
const RESTORE_FRACTION: f64 = 0.7;
/// How far below the normal window's top edge, in logical pixels, the point lies that must be on
/// a monitor for saved geometry to be used there: inside the title bar, so it can be dragged.
const TITLE_BAR_PROBE: f64 = 8.0;

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

    fn right(&self) -> i32 {
        self.x + self.width as i32
    }

    fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }
}

/// What placement needs to know about one monitor.
#[derive(Clone, Debug, PartialEq)]
pub struct MonitorInfo {
    /// OS device name, e.g. `\\.\DISPLAY2` on Windows. Used to remember the user's choice.
    pub name: Option<String>,
    /// The whole monitor.
    pub bounds: Rect,
    /// The monitor minus the taskbar and other reserved areas, the strip's own included.
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

/// The window's two shapes (ADR 0016 §1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Shape {
    /// Borderless, non-focusable, no taskbar entry, its band reserved. The app always starts so.
    #[default]
    Strip,
    /// Framed, resizable, focusable, with a taskbar and Alt+Tab entry: expanded mode.
    Normal,
}

/// What made the shell place the window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    /// The window just switched to its current shape.
    Switched,
    /// Displays, scale factors or work areas changed, including the window's own scale changing
    /// as it is dragged onto a monitor with another one.
    DisplaysChanged,
    /// Shown or hidden, a setting changed, another monitor chosen, or the height settled.
    StateChanged,
    /// A step of a height-handle drag.
    HeightDragged,
}

/// What a placement does with the strip's band.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Band {
    /// Reserve it at the strip's rectangle.
    Reserve,
    /// Leave the reservation as it is: every change makes Windows resize all maximized windows,
    /// which flickers if done on every step of a handle drag (ADR 0008 §10).
    Keep,
    /// Give it back.
    Release,
}

/// What a placement does with the window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Move {
    /// Put it at the strip's rectangle.
    Strip,
    /// Put it at the normal window's restore rectangle.
    Restore,
    /// Maximize it, now that the band has been given back.
    Maximize,
    /// Leave it where it is.
    Leave,
}

/// Everything the placement decision depends on.
#[derive(Clone, Copy, Debug)]
pub struct Situation {
    pub shape: Shape,
    pub trigger: Trigger,
    pub visible: bool,
    /// The "Reserve screen space" setting.
    pub reserve_space: bool,
    /// The normal window is to open maximized once the band has been given back, or it would stop
    /// short of the space the strip just freed (ADR 0016 §8).
    pub maximize_pending: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Placement {
    pub band: Band,
    pub window: Move,
}

/// What to do on a placement (ADR 0016 §8). The normal shape never reserves the band: reserving
/// and then releasing it in one placement changes the work area twice, and each change places the
/// window again, a loop that flickers every maximized window. Nor does it move on a display
/// change: dragging it onto a monitor with another scale is one, and moving it back from there
/// loops; Windows rescales it itself.
pub fn decide(situation: Situation) -> Placement {
    match situation.shape {
        Shape::Normal => Placement {
            band: Band::Release,
            window: match situation.trigger {
                Trigger::Switched => Move::Restore,
                Trigger::DisplaysChanged if situation.maximize_pending => Move::Maximize,
                _ => Move::Leave,
            },
        },
        Shape::Strip => Placement {
            band: match (
                situation.visible && situation.reserve_space,
                situation.trigger,
            ) {
                (false, _) => Band::Release,
                (true, Trigger::HeightDragged) => Band::Keep,
                (true, _) => Band::Reserve,
            },
            window: Move::Strip,
        },
    }
}

/// The normal window's geometry, saved in `settings.json` (ADR 0016 §5). Physical pixels: the
/// outer position and the inner size of its restore rectangle, which come back exactly when
/// restored the same way, though the frame's invisible insets grow with the scale.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalWindow {
    /// The device name of the monitor it was on.
    pub monitor: Option<String>,
    /// That monitor's scale factor then: at another scale the size would look different.
    pub scale_factor: f64,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
    pub full_screen: bool,
}

impl NormalWindow {
    /// The restore rectangle: outer position, inner size.
    pub fn rect(&self) -> Rect {
        Rect {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
    }
}

/// The work area as it is without the strip's band: `band`, when it sits directly below the work
/// area, is added back. Computed from the work area with the band reserved, the first-open
/// geometry at 200% came out 577 px tall (ADR 0016 §8).
pub fn without_band(work_area: Rect, band: Option<Rect>) -> Rect {
    match band {
        Some(band)
            if band.y == work_area.bottom()
                && band.x < work_area.right()
                && band.right() > work_area.x =>
        {
            Rect {
                height: work_area.height + band.height,
                ..work_area
            }
        }
        _ => work_area,
    }
}

/// The normal window's first geometry, with nothing saved (ADR 0016 §5): maximized on the strip's
/// monitor, with a restore size of 70% of its work area without the band, centred.
pub fn first_normal_window(monitor: &MonitorInfo, band: Option<Rect>) -> NormalWindow {
    let area = without_band(monitor.work_area, band);
    let width = (f64::from(area.width) * RESTORE_FRACTION).round() as u32;
    let height = (f64::from(area.height) * RESTORE_FRACTION).round() as u32;
    NormalWindow {
        monitor: monitor.name.clone(),
        scale_factor: monitor.scale_factor,
        x: area.x + ((area.width - width) / 2) as i32,
        y: area.y + ((area.height - height) / 2) as i32,
        width,
        height,
        maximized: true,
        full_screen: false,
    }
}

/// Where a restore rectangle's title bar is probed.
fn title_bar_point(rect: Rect, scale_factor: f64) -> (i32, i32) {
    (
        rect.x + (rect.width / 2) as i32,
        rect.y + (TITLE_BAR_PROBE * scale_factor).round() as i32,
    )
}

/// The geometry the normal window opens with: the saved one if it still fits its monitor, else
/// the first-open one on `strip_monitor` (ADR 0016 §5). Saved geometry fits when its monitor is
/// connected at the same scale, the window is no larger than that monitor and its title bar is on
/// it.
pub fn normal_window(
    saved: Option<&NormalWindow>,
    monitors: &[MonitorInfo],
    strip_monitor: &MonitorInfo,
    band: Option<Rect>,
) -> NormalWindow {
    let fits = |saved: &NormalWindow| {
        monitors.iter().any(|m| {
            let (x, y) = title_bar_point(saved.rect(), m.scale_factor);
            m.name.is_some()
                && m.name == saved.monitor
                && (m.scale_factor - saved.scale_factor).abs() < 0.01
                && saved.width > 0
                && saved.height > 0
                && saved.width <= m.bounds.width
                && saved.height <= m.bounds.height
                && m.bounds.contains(x, y)
        })
    };
    match saved {
        Some(saved) if fits(saved) => saved.clone(),
        _ => first_normal_window(strip_monitor, band),
    }
}

/// The monitor a restore rectangle is on: the one under its title bar, else the one under its
/// middle, else `None`.
pub fn monitor_of(monitors: &[MonitorInfo], rect: Rect) -> Option<&MonitorInfo> {
    let middle = (
        rect.x + (rect.width / 2) as i32,
        rect.y + (rect.height / 2) as i32,
    );
    monitors
        .iter()
        .find(|m| {
            let (x, y) = title_bar_point(rect, m.scale_factor);
            m.bounds.contains(x, y)
        })
        .or_else(|| {
            monitors
                .iter()
                .find(|m| m.bounds.contains(middle.0, middle.1))
        })
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
            bounds: FULL_HD_WORK_AREA,
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

    fn situation(shape: Shape, trigger: Trigger) -> Situation {
        Situation {
            shape,
            trigger,
            visible: true,
            reserve_space: true,
            maximize_pending: false,
        }
    }

    const TRIGGERS: [Trigger; 4] = [
        Trigger::Switched,
        Trigger::DisplaysChanged,
        Trigger::StateChanged,
        Trigger::HeightDragged,
    ];

    #[test]
    fn the_normal_shape_never_reserves_the_band() {
        for trigger in TRIGGERS {
            for (visible, reserve_space, maximize_pending) in [
                (true, true, false),
                (true, true, true),
                (false, true, false),
                (true, false, true),
            ] {
                let placement = decide(Situation {
                    visible,
                    reserve_space,
                    maximize_pending,
                    ..situation(Shape::Normal, trigger)
                });
                assert_eq!(placement.band, Band::Release, "{trigger:?}");
            }
        }
    }

    #[test]
    fn display_changes_leave_the_normal_window_where_it_is() {
        // Dragging it onto a monitor with another scale is a display change (ADR 0016 §8).
        for trigger in [
            Trigger::DisplaysChanged,
            Trigger::StateChanged,
            Trigger::HeightDragged,
        ] {
            assert_eq!(
                decide(situation(Shape::Normal, trigger)).window,
                Move::Leave
            );
        }
    }

    #[test]
    fn the_normal_window_is_restored_only_when_switched_to() {
        assert_eq!(
            decide(situation(Shape::Normal, Trigger::Switched)).window,
            Move::Restore
        );
    }

    #[test]
    fn a_pending_maximize_waits_for_the_work_area_to_change() {
        let pending = |trigger| {
            decide(Situation {
                maximize_pending: true,
                ..situation(Shape::Normal, trigger)
            })
            .window
        };
        assert_eq!(pending(Trigger::Switched), Move::Restore);
        assert_eq!(pending(Trigger::DisplaysChanged), Move::Maximize);
        assert_eq!(pending(Trigger::StateChanged), Move::Leave);
    }

    #[test]
    fn the_strip_reserves_while_visible_and_keeps_it_during_a_drag() {
        for trigger in [
            Trigger::Switched,
            Trigger::DisplaysChanged,
            Trigger::StateChanged,
        ] {
            assert_eq!(
                decide(situation(Shape::Strip, trigger)),
                Placement {
                    band: Band::Reserve,
                    window: Move::Strip
                }
            );
        }
        assert_eq!(
            decide(situation(Shape::Strip, Trigger::HeightDragged)).band,
            Band::Keep
        );
        for trigger in TRIGGERS {
            let hidden = Situation {
                visible: false,
                ..situation(Shape::Strip, trigger)
            };
            let off = Situation {
                reserve_space: false,
                ..situation(Shape::Strip, trigger)
            };
            assert_eq!(decide(hidden).band, Band::Release);
            assert_eq!(decide(off).band, Band::Release);
            assert_eq!(decide(hidden).window, Move::Strip);
        }
    }

    const PRIMARY: &str = r"\\.\DISPLAY1";

    /// A 2560×1440 monitor whose work area is `work_height` tall.
    fn qhd(scale_factor: f64, work_height: u32) -> MonitorInfo {
        MonitorInfo {
            name: Some(PRIMARY.to_owned()),
            bounds: Rect {
                x: 0,
                y: 0,
                width: 2560,
                height: 1440,
            },
            work_area: Rect {
                x: 0,
                y: 0,
                width: 2560,
                height: work_height,
            },
            scale_factor,
            primary: true,
        }
    }

    /// The band at 200% on that monitor, above a 96 px taskbar: 520 px (260 logical).
    const BAND: Rect = Rect {
        x: 0,
        y: 824,
        width: 2560,
        height: 520,
    };

    #[test]
    fn the_band_is_added_back_to_the_work_area() {
        let reserved = qhd(2.0, 824).work_area;
        assert_eq!(without_band(reserved, Some(BAND)).height, 1344);
        // Already given back, or reserved on another monitor: nothing to add.
        let released = qhd(2.0, 1344).work_area;
        assert_eq!(without_band(released, Some(BAND)), released);
        let elsewhere = Rect { x: 2560, ..BAND };
        assert_eq!(without_band(reserved, Some(elsewhere)), reserved);
        assert_eq!(without_band(reserved, None), reserved);
    }

    #[test]
    fn the_first_normal_window_is_maximized_over_the_work_area_without_the_band() {
        let window = first_normal_window(&qhd(2.0, 824), Some(BAND));
        assert!(window.maximized);
        assert!(!window.full_screen);
        assert_eq!(window.monitor.as_deref(), Some(PRIMARY));
        assert_eq!(window.scale_factor, 2.0);
        // 70% of 2560×1344, centred; not 577 px tall from the 824 px left above the band.
        assert_eq!(
            window.rect(),
            Rect {
                x: 384,
                y: 201,
                width: 1792,
                height: 941
            }
        );
    }

    fn saved(x: i32, y: i32) -> NormalWindow {
        NormalWindow {
            monitor: Some(PRIMARY.to_owned()),
            scale_factor: 2.0,
            x,
            y,
            width: 1200,
            height: 800,
            maximized: false,
            full_screen: true,
        }
    }

    #[test]
    fn saved_geometry_is_used_while_it_fits_its_monitor() {
        let monitors = [qhd(2.0, 1344)];
        // The frame's invisible inset puts the outer position just off the monitor's edge.
        let window = saved(-11, 100);
        assert_eq!(
            normal_window(Some(&window), &monitors, &monitors[0], None),
            window
        );
    }

    #[test]
    fn saved_geometry_that_no_longer_fits_means_a_first_open() {
        let monitors = [qhd(2.0, 1344)];
        let first = first_normal_window(&monitors[0], None);
        let open =
            |window: NormalWindow| normal_window(Some(&window), &monitors, &monitors[0], None);
        assert_eq!(normal_window(None, &monitors, &monitors[0], None), first);
        // Its monitor is gone.
        let gone = NormalWindow {
            monitor: Some(r"\\.\DISPLAY2".to_owned()),
            ..saved(0, 0)
        };
        assert_eq!(open(gone), first);
        // The scale changed.
        let rescaled = NormalWindow {
            scale_factor: 1.5,
            ..saved(0, 0)
        };
        assert_eq!(open(rescaled), first);
        // The resolution shrank below its size, or its title bar is off the monitor.
        let wide = NormalWindow {
            width: 3000,
            ..saved(0, 0)
        };
        assert_eq!(open(wide), first);
        assert_eq!(open(saved(0, -100)), first);
        assert_eq!(open(saved(2000, 0)), first);
        let empty = NormalWindow {
            width: 0,
            ..saved(0, 0)
        };
        assert_eq!(open(empty), first);
    }

    #[test]
    fn finds_the_monitor_under_the_title_bar() {
        let right = MonitorInfo {
            name: Some("right".to_owned()),
            bounds: Rect {
                x: 2560,
                y: 0,
                width: 1920,
                height: 1080,
            },
            work_area: Rect {
                x: 2560,
                y: 0,
                width: 1920,
                height: 1032,
            },
            scale_factor: 1.0,
            primary: false,
        };
        let monitors = [qhd(1.0, 1392), right];
        let on = |x, y| {
            let rect = Rect {
                x,
                y,
                width: 1000,
                height: 600,
            };
            monitor_of(&monitors, rect).and_then(|m| m.name.clone())
        };
        assert_eq!(on(2200, 100).as_deref(), Some("right"));
        assert_eq!(on(1000, 100).as_deref(), Some(PRIMARY));
        // Title bar above every monitor: the one under its middle.
        assert_eq!(on(2700, -50).as_deref(), Some("right"));
        assert_eq!(on(9000, 0), None);
    }
}
