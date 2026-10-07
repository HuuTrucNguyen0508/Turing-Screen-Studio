# External theme imports

External conversion creates an offline draft for review. It never applies a layout, saves to the panel, opens USB, loads source sensors or fetches files. Review warnings and geometry before opening the draft or extracting its widgets. Keep the original theme and assets.

## Supported source

The importer accepts a bounded subset of `mathoudebine/turing-smart-screen-python` theme YAML. Select `theme.yaml` and the images it references together. The UI must decode selected raster images and normalize them to PNG before calling the converter. An asset keeps its original filename so a YAML reference such as `background.jpg` can match the selected file even though its embedded data is PNG.

The format uses lowercase `display`, `static_images` and `static_text`, and uppercase `STATS`. The upstream [example theme](https://github.com/mathoudebine/turing-smart-screen-python/blob/main/res/themes/theme_example.yaml) defines these sections. The [theme loader](https://github.com/mathoudebine/turing-smart-screen-python/blob/main/library/config.py) parses YAML and adds missing defaults. Studio reads this data format independently and does not execute upstream code.

The supplied Studio palette replaces source colors, and the draft has `chrome: "none"` and `paletteMode: "live"`. Images keep their pixel colors. Conversion does not recolor raster backgrounds.

## Geometry and mappings

`DISPLAY_SIZE` selects upstream canvas dimensions; `DISPLAY_ORIENTATION` must be `portrait` or `landscape`. Landscape swaps the portrait width and height. A missing size uses the upstream 3.5-inch default and produces a warning. An unknown size or orientation fails conversion. These mappings come from upstream [display.py](https://github.com/mathoudebine/turing-smart-screen-python/blob/main/library/display.py), and do not claim support for physical devices.

| Size | Portrait canvas |
| --- | --- |
| 0.96 inches | 80 × 160 |
| 2.1 or 2.8 inches | 480 × 480 |
| 3.5 inches | 320 × 480 |
| 4.6 inches | 320 × 960 |
| 5 inches | 480 × 800 |
| 5.2 inches | 720 × 1280 |
| 8 inches | 800 × 1280 |
| 8.8 or 9.2 inches | 480 × 1920 |
| 12.3 inches | 720 × 1920 |

Upstream deliberately uses the 8.8-inch canvas for 9.2-inch themes. Studio warns about this compatibility canvas.

| Source element | Studio result |
| --- | --- |
| `static_images.<name>` | Embedded image widget; label is the entry name, fit is `stretch`, opacity is 100 |
| `static_text.<name>` | Text widget containing `TEXT`; label is the entry name |
| Supported sensor `TEXT`, or memory `PERCENT_TEXT` | Gauge with the `number` style |
| Supported sensor `GRAPH` | Gauge with the `bar` style |
| Supported sensor `RADIAL` | Gauge with the `ring` style |

Image and bar rectangles preserve integer `X`, `Y`, `WIDTH` and `HEIGHT`. Missing or zero image dimensions use the selected image's natural dimensions. If only one image dimension is supplied, review the warning about source cropping. Static images appear first, then static text, then sensor widgets; order within each group follows the YAML.

Radial `X` and `Y` are center coordinates. A radius `r` becomes the rectangle `x = X - r`, `y = Y - r`, `width = height = 2r`. Studio does not preserve arc angles, segmentation, thickness, decorations or custom radial text positions. This conversion follows the center/radius contract in upstream [stats.py](https://github.com/mathoudebine/turing-smart-screen-python/blob/main/library/stats.py). The underlying [drawing functions](https://github.com/mathoudebine/turing-smart-screen-python/blob/main/library/lcd/lcd_comm.py) describe image resizing and text bounds.

Explicit text rectangles keep their coordinates and size. Missing or zero dimensions get an integer estimate from text length and `FONT_SIZE`, capped at available canvas space. The estimate uses `ceil(longest line length × font size × 0.65) + 16` for width and `line count × (font size + 8)` for height, with a minimum of 24 before capping. Sensor text uses `100` and the source unit to estimate bounds. These are Studio estimates, not upstream font measurements. Warnings identify every estimated rectangle.

Supported sensor paths are deliberately narrow:

| Turing path below `STATS` | Studio source | Unit |
| --- | --- | --- |
| `CPU.PERCENTAGE` | `cpu` | % |
| `GPU.PERCENTAGE` | `gpu` | % |
| `MEMORY.VIRTUAL` | `memory` | % |
| `CPU.TEMPERATURE` | `cpu-temperature` | °C |
| `GPU.TEMPERATURE` | `gpu-temperature` | °C |

For memory, only `GRAPH`, `RADIAL` and `PERCENT_TEXT` map. `USED`, `FREE` and `TOTAL` represent byte values and do not map to Studio's percentage source. The section shapes and hidden defaults are defined in upstream [default.yaml](https://github.com/mathoudebine/turing-smart-screen-python/blob/main/res/themes/default.yaml). The included [3.5inchTheme2 example](https://github.com/mathoudebine/turing-smart-screen-python/blob/main/res/themes/3.5inchTheme2/theme.yaml) demonstrates memory percentage text and bars.

Only `SHOW: true` elements convert. `SHOW: false` and omitted `SHOW` do not create sensor widgets. `True` and `TRUE` also parse as booleans; quoted boolean strings fail. Gauge minimum and maximum default to 0 and 100. Explicit finite bounds remain, and deterministic samples clamp to those bounds. `SHOW_UNIT: false` hides the unit.

## Warnings and omissions

Conversion reports missing images and omits those image widgets. It reports unsupported enabled sensor paths and drawing modes by their full source path. A theme with no supported drawable content fails instead of returning an empty imported document.

CPU frequency, CPU load averages, GPU memory, swap, disk, network interface sensors, dates, weather, custom sensors and line graphs have no conversion here. Recreate them using Studio widgets after reviewing the source. Device settings, refresh intervals and source sensor selection do not carry over.

Source fonts, colors, text anchors, alignment, line width and other unrecognized style fields do not survive. `FONT_SIZE` only helps estimate a missing text rectangle. Studio renders its own text and gauge styles. A tiny source bar or text box can need resizing to suit Studio's rendering.

Per-element `BACKGROUND_IMAGE` compositing is unsupported. The importer checks its path and reports missing selected assets, but does not automatically add another background widget. Include the background under `static_images` to retain it as a separate image layer.

## AIDA64 panels

Studio does not parse `.sensorpanel` or `.rslcd` exports, including files that happen to look like text. The reviewed official documentation describes exported panels and their contents but provides no field-level file grammar for this converter. No binary container decoder or guessed XML mapping is included.

Open the panel in AIDA64. Export or save its background as an image, select that image in Studio, and recreate its sensor widgets with Studio data sources. If a separate background is unavailable, capture the panel as a visual reference and rebuild the live widgets. A screenshot has fixed readings and cannot become a live panel by importing it.

AIDA64's [SensorPanel Manager documentation](https://www.aida64.com/user-manual/sensorpanel/sensorpanel-manager) explains its export/import workflow and bundled graphics. Its [LCD items documentation](https://www.aida64.com/user-manual/hardware-monitoring/lcd/lcd-items) describes available items, not an interchange grammar. Its [LCD guide](https://download.aida64.com/resources/lcd/aida64_lcd_guide.pdf) documents supported LCD integrations. These sources do not establish a text format that Studio can safely promise to import.

## Input limits and safety

The synchronous domain API is independent of React:

```ts
convertExternalTheme(
  text: string,
  assets: readonly { name: string; data: string; width: number; height: number }[],
  palette: Palette,
): { document: LayoutDocument; warnings: string[]; format: string }
```

The caller receives a fully validated layout or an exception. It must preserve the current editor document on failure. Opening or extracting the result remains a separate UI action.

- Theme text is limited to 1 MiB of UTF-8, one YAML document, 10,000 nodes and 16 nesting levels. Text values and mapping keys are limited to 8,192 characters.
- At most 64 image assets and 256 converted widgets are accepted. Each PNG data URI must fit the shared 512 KiB limit. PNG dimensions must not exceed 4,096 per side or 16 million pixels. Supplied dimensions must match the PNG header.
- Selected encoded assets and repeated embedded image copies are capped at 1 MiB. The final formatted JSON must also fit the shared 1 MiB layout limit. Reduce asset size or widget count if it does not fit.
- Coordinates and dimensions must be integers. Explicit rectangles and radial circles must fit the canvas. Conversion rejects invalid geometry instead of silently moving it.
- Asset lookup uses case-insensitive basenames from safe relative paths. Two selected files with the same basename fail as ambiguous. Parent traversal, empty path segments, absolute paths, drive paths, URLs, percent escapes and query strings are rejected.
- YAML aliases, anchors, explicit tags, merge keys, duplicate keys, non-string mapping keys and prototype-related keys are rejected. The parser uses `parseDocument` from `yaml`; its [official documentation](https://eemeli.org/yaml/) describes parsing errors and alias limits.
- The importer never reads a filesystem path or downloads a source image. The shared layout validator checks embedded PNG structure and the complete output document. The UI must actually decode source rasters before normalizing them.

Sources and the converter were checked on 7 October 2026. Upstream `main` can change; additional formats or mappings need verified examples and focused tests before being advertised.
