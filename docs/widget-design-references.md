# Widget design references

Sources checked on 6 October 2026 for the gauge display styles (`settings.style`). They were used only as references. No code, images, fonts or theme files from them are in this repository, and nothing here depends on them.

## Why gauges needed new styles

The widget library had 34 entries. Most of the gauge entries were the same 240° arc at different sizes, so the CPU row looked like one widget repeated. The fix adds five shapes beside the original arc. A wider card of the same shape is still called Wide. Each new style gets its own name.

## Sources

**AIDA64 SensorPanel forum.** [forums.aida64.com/forum/28-sensorpanel](https://forums.aida64.com/forum/28-sensorpanel/) is the AIDA64 section for sharing sensor panels. Its main thread, [Share your Sensorpanels](https://forums.aida64.com/topic/13296-share-your-sensorpanels/), started on 30 January 2012 and runs to more than 550 pages of user designs. The first pages already cover the shapes used here: analog dials, horizontal and vertical bars, thermometer graphics for temperatures, large numeric readouts, and segmented LCD-style meters for small screens. The forum allows sharing of members' own free panels and bans copyright infringement, so designs posted there belong to their authors. They inspired these shapes and nothing more.

**turing-smart-screen-python themes.** The [theme gallery](https://github.com/mathoudebine/turing-smart-screen-python/blob/main/res/themes/themes.md) shows themes for 2.1, 3.5, 5 and 8.8 inch Turing screens, the same hardware family as this project. The [theme wiki](https://github.com/mathoudebine/turing-smart-screen-python/wiki/System-monitor-:-themes) lists four element types: `TEXT`, `GRAPH` (a horizontal bar with `MIN_VALUE`, `MAX_VALUE` and `BAR_OUTLINE`), `RADIAL` (with `ANGLE_START`, `ANGLE_END`, `ANGLE_STEPS`, `ANGLE_SEP` and `CLOCKWISE`) and `LINE_GRAPH`. `ANGLE_STEPS` with `ANGLE_SEP` gives a segmented radial meter. The repository is GPL-3.0, and none of its code or theme assets were copied.

**Grafana bar gauge.** The [bar gauge documentation](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/bar-gauge/) has three display modes. "Basic" is a single fill color. "Gradient" fills by threshold. "Retro LCD" "splits the bar into sections that are lit or unlit". It also has "Show unfilled area", which draws the empty part of the bar in gray. Our `bar` style follows the basic mode with the unfilled track shown. Our `segments` style follows Retro LCD, with unlit blocks kept visible.

**Grafana gauge.** The [gauge documentation](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/gauge/) offers "Circle" and "Arc" as separate styles, plus a "Segments" count. A mature dashboard tool treats a closed ring and an open arc as different choices of the same gauge. That supports keeping `arc` and `ring` as two styles instead of two sizes.

## How the references shaped each style

| Style | Reference | What we took | What we did differently |
|---|---|---|---|
| `arc` | existing renderer | Nothing. It stays pixel-identical. | |
| `ring` | Grafana "Circle", turing `RADIAL` | A closed track filled clockwise from 12 o'clock. | Thicker 16 px stroke, with the range written inside the ring because a ring has no end points to label. |
| `bar` | turing `GRAPH`, Grafana "Basic" with unfilled area | A horizontal fill on a visible track with min and max. | A 2 px marker in text color at the reading, so the exact position stays visible when fill and track colors are close in a Caelestia scheme. |
| `segments` | Grafana "Retro LCD", AIDA64 small-screen LCD panels | Discrete lit and unlit blocks. | A fixed 20 blocks at 5 % each, so the block count means the same thing at every width. |
| `thermometer` | AIDA64 thermometer panels | A tube with a bulb and a vertical scale. | The bulb fills whenever a reading exists, even at the minimum, and empties when the reading is unavailable. |
| `number` | AIDA64 large numeric readouts, turing `TEXT` | The reading alone, as large as the card allows. | A single 4 px rule at the left in the primary color. No scale is drawn, but the range is still saved. |

## Constraints that did not come from the references

- Colors come from the live Caelestia palette. No theme from any gallery was imported.
- Each style draws with the existing PIL renderer and an SVG preview from one geometry spec. No new dependencies, fonts or sensor collectors.
- Many gallery panels are made for one fixed resolution. These styles must render at any valid card size, from 1 × 1 up, and may clip but never fail.
