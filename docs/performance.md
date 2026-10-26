# Performance

The measured cost of the running app, the starting budget for later changes (ADR 0009 §7). Measure with `pnpm measure` on a release build; [development.md](development.md) explains how.

## Reference machine

| Part     | Value                                                       |
| -------- | ----------------------------------------------------------- |
| CPU      | AMD Ryzen 7 9700X, 8 cores, 16 logical processors           |
| GPU      | NVIDIA GeForce RTX 5060, driver 32.0.16.1088                |
| Memory   | 32 GB                                                       |
| Displays | 2560×1440 at 99 Hz (primary, the strip's), 1920×1080        |
| OS       | Windows 11 Pro, build 26200; WebView2 Runtime 155.0.4283.62 |

## Baseline

Version 0.0.0 with 3 creatures, 5 minutes per state, sampled once a second. Means over each state, summed over the app's 7 processes (the host and WebView2's). CPU is a share of all 16 logical processors, so 1% is about a sixth of one core. GPU is 3D engine use. Working set counts pages shared between the processes more than once.

| State          | CPU % | GPU % | Private MB | Working set MB | GPU memory MB |
| -------------- | ----: | ----: | ---------: | -------------: | ------------: |
| Strip, idle    |  0.58 |  0.65 |        286 |            414 |            99 |
| Strip, hovered |  1.09 |  2.15 |        294 |            425 |            99 |
| Expanded       |  0.56 |  0.86 |        322 |            438 |           142 |
| Hidden         |  0.02 |  0.00 |        271 |            419 |            97 |

- **Idle** renders at about 30 fps (ADR 0007 §11); **hovered** renders at the display's rate, 99 Hz here.
- **Expanded** was measured with the cursor off the window, so it is also at the idle rate. It covers the monitor's work area, which explains the extra GPU memory.
- **Hidden** renders nothing. The first measurement found 0.70% CPU and 0.54% GPU, no lower than idle: hiding the window left WebView2 rendering the page, because the page never learned it was hidden. The shell now hides the WebView2 along with the window, so the page's `visibilitychange` stops the render loop. The simulation keeps ticking at 10 Hz while hidden (ADR 0008 §12).

## Decisions

- **The idle render rate stays at 30 fps.** About a tenth of one core and under 1% GPU is already small. A lower rate would save a fraction of that and make creature motion visibly choppier. Revisit if power draw on laptops becomes a concern.

## Soak test

**Passed** (ADR 0009 §6). An 8-hour run on 26 October 2026: release build of `main` at bcd1156, 3 creatures, the strip shown with the cursor off it, sampled every 10 seconds on the reference machine.

| Hour | CPU % | GPU % | Private MB | Working set MB | GPU memory MB |
| ---: | ----: | ----: | ---------: | -------------: | ------------: |
|    1 |  0.62 |  1.52 |        319 |            483 |            99 |
|    2 |  0.61 |  1.68 |        339 |            504 |            99 |
|    4 |  0.62 |  1.77 |        339 |            504 |            99 |
|    6 |  0.64 |  2.18 |        339 |            504 |            99 |
|    8 |  0.65 |  2.11 |        339 |            504 |            99 |

- **Memory is flat after warm-up.** Private bytes rose from 282 MB to 338 MB in the first 30 minutes, then held at 339 MB to the end: 0.0% growth from hour 1 (minutes 60–70) to the last 10 minutes, against a limit of 10%. GPU memory never moved.
- **No stuck creatures and no failed paths:** 0 `creature_stuck`, 0 `path_failed`. The process count stayed at 7.
- **GPU use stepped up after 20 minutes**, from 0.53% (as in the baseline) to between 1.5% and 2.5% for the rest of the run, while CPU stayed at the idle level. The renderer's work did not change, so the likely cause is the GPU dropping to a lower clock once the machine was left alone, which makes the same work a larger share. This is a hypothesis, not checked; compare GPU clocks during a run if it matters.
