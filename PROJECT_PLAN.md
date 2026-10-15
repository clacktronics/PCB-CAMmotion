# PCB-CAMmotion — Project Plan

Browser-based, local-only CAM for PCBs. Load Gerber + Excellon drill files, inspect and edit
them, and output either CNC toolpaths (machine-specific) or UV-exposure negatives.

## Goals

1. **Import & view** Gerber (RS-274X / X2), Excellon drill files and the KiCad Gerber job
   file (`.gbrjob`). Render the board in its **real colours** in 2D and as a 3D stackup.
2. **Analyse** the internals of a Gerber: commands, apertures, macros, polarity, regions,
   and the shapes they produce.
3. **Edit** Gerber and drill data with real editing tools, then export valid files again.
4. **CAM output**:
   - Isolation milling, drilling, and board-outline cutting as toolpaths.
   - Machine-specific post-processors — first targets: **LPKF ProtoMat E44** and
     **Makera Carvera** (confirm exact model).
   - Generic G-code (GRBL / Marlin / LinuxCNC) as a baseline.
   - Film/negative output (SVG / PNG / PDF at true scale, mirror + invert options) for UV exposure.
5. **Project file (`.pcam`)**: everything — source files, edits, settings, stackup,
   tools, toolpaths, DRC results — saved in one downloadable project file.
6. **Manufacturability DRC**: check the design against the real tools and machine
   (can this actually be milled/drilled/exposed?), not just abstract design rules.

## Constraints

- Runs entirely in the browser. No server, no uploads, no telemetry.
- Opens from a static `index.html` (works from `file://` or any static host).
- Works offline once loaded.
- All state lives in the `.pcam` project file; nothing important exists only in the browser.

## Architecture (simple)

```
src/
  parse/      Gerber + Excellon + .gbrjob parsers -> command list (AST) with source line refs
  model/      Geometry model: primitives, apertures, layers, board, stackup
  render/     WebGL 2D viewer, layer stack, zoom/pan, selection, realistic materials
  render3d/   3D stackup, exploded view, cross-section, as-milled preview (vendored three.js)
  analyze/    Aperture/shape stats, command inspector, step-through playback
  edit/       Editing tools + undo/redo; serialise back to Gerber/Excellon
  cam/        Offsetting (isolation), drill grouping, outline, tool library
  drc/        Manufacturability checks against tools, machine and process limits
  post/       Post-processors: generic, lpkf-e44, makera-carvera
  export/     G-code / machine files, film negatives (SVG/PNG/PDF)
  project/    .pcam save/load, schema versions + migrations, autosave
  ui/         App shell, panels, settings
test/         Parser/edit round-trip tests and sample files
samples/      Small reference Gerber/drill sets
```

Key idea: **one command-level model** that parsing, analysis, editing and export all share,
so edits round-trip to valid files and analysis can point back to source lines.

## Milestones

| # | Milestone | Done when |
|---|-----------|-----------|
| 0 | Skeleton | Static app loads, file drop works, tests run, empty `.pcam` saves and reloads |
| 1 | Parsers | Gerber + Excellon + `.gbrjob` parse into the command model; layers auto-identified; sample files pass; imported files stored in `.pcam` |
| 2 | Viewer | Layers render correctly (polarity, regions, macros), zoom/pan/select, realistic board colours (see below) |
| 3 | Analyser | Aperture table, shape gallery, command inspector, step-through playback |
| 4 | Editor | Select/move/delete/add pads, traces, regions, drills; undo/redo; export round-trips |
| 5 | Film output | Scaled, mirrored, inverted negatives print at exact size |
| 6 | CAM core | Isolation paths (multi-pass), drilling, outline with tabs; tool library |
| 7 | DRC | Milling-aware checks report issues on the board, linked to source lines (see below) |
| 8 | 3D view | Stackup in 3D with real colours, exploded view, cross-section, as-milled preview (see below) |
| 9 | Generic post | G-code preview + simulation, export |
| 10 | Machine posts | LPKF E44 and Makera Carvera output tested on real machines |
| 11 | Polish | Presets, templates, docs |

### Project file — `.pcam` (from milestone 0, extended by every milestone)

One file holds the whole project, so it can be downloaded, backed up, emailed or
reopened on another computer and come back exactly as it was.

- **Format:** a ZIP container (vendored zip library, e.g. fflate) with the extension
  `.pcam` (opening accepts any case, e.g. `.PCAM`):
  ```
  project.json        manifest: schema version, app version, created/modified, units
  sources/            original Gerber, drill and .gbrjob files, byte-for-byte untouched
  model/              edited command model per layer + undo history
  settings/           app + project settings, layer colours/visibility, view state
  stackup.json        stackup and materials (from .gbrjob or user-edited)
  tools.json          tool library, feeds/speeds, machine profile choices
  cam/                toolpath jobs and their parameters (+ cached results)
  drc/                DRC rules, results, waived findings
  exports/            optional: last generated G-code / machine files / film negatives
  ```
- **Originals are never overwritten:** edits are stored separately, so the original files
  can always be re-exported or diffed against the edited version.
- **Save = download:** the browser downloads `name.pcam`. Where the browser supports the
  File System Access API (Chrome/Edge), "Save" writes back to the same file.
- **Open:** file picker or drag-and-drop of a `.pcam` file.
- **Autosave:** a crash-recovery copy in IndexedDB, offered on next launch. Only a safety net —
  the `.pcam` file is the real copy.
- **Versioned schema:** `project.json` carries a schema version; older files are migrated
  forward on load, never rejected. Unknown fields are kept, not dropped.
- **Settings scope:** app-wide preferences (UI, default machine) can be exported/imported
  separately, but everything that affects the output lives in the project file.

### Stackup & real colours (milestones 1, 2, 8)

The board is drawn in the colours it will actually be made in, not abstract per-layer
debug colours.

- **Source of truth: KiCad `.gbrjob`.** Read `GeneralSpecs` (board size, thickness, finish)
  and `MaterialStackup` (each layer's type, thickness, material and colour), plus `FilesAttributes`
  to map each Gerber to its layer. Fall back to Gerber X2 `.FileFunction` attributes, then to
  filename guessing, then to user-chosen stackup presets.
- **Real material colours** (a vendored, editable table):
  - Solder mask: green, red, blue, black, white, yellow, purple, matte/glossy variants —
    semi-transparent, so copper under it shows as a darker/lighter tone.
  - Silkscreen: white, black, yellow.
  - Exposed copper by finish: HASL (silver), ENIG (gold), OSP / bare copper (copper, can
    look oxidised), immersion silver/tin.
  - Substrate: FR4 (translucent tan/green), aluminium, polyimide, etc., visible through
    gaps, slots and board edges.
  - Plated holes show a plated barrel and ring; non-plated holes show bare substrate.
- **2D (milestone 2):** composite layers in physical order with these materials, light
  sheen on metal, top/bottom view with correct mirroring. Per-layer opacity and a
  "debug colours" toggle for analysis work.
- **3D (milestone 8):** each layer extruded at its stackup thickness; drills as plated
  barrels; orbit/zoom; exploded-view slider; draggable cross-section plane; X-ray per layer.
- **As-milled preview (milestone 8):** the board as it will come off the machine — bare
  copper on FR4, V-bit grooves at true width/depth, drilled holes, outline cut —
  toggled against the as-designed board. DRC findings drawn in place; optional probed
  height map overlay. UV/film preview overlays the negative on the board.

### Viewer extras (milestones 2–3)

- Hover a feature → aperture, D-code, polarity, source line; click → jump to inspector.
- Animated photoplotter playback of the command stream.
- Connected-copper highlight (geometry-based, no netlist needed).
- Measure tool with snapping to pad centres / edges.

### DRC (milestone 7)

Comes after the CAM core because the useful checks depend on the actual tools and toolpaths:

- Gaps narrower than the isolation tool can cut → copper left un-isolated / shorts.
- Copper narrower than the tool leaves after offsetting → traces or pads that get eaten away.
- Areas the toolpaths could not reach (compare intended vs. achievable copper).
- Drill sizes with no matching tool in the library; drills too close to each other or to copper.
- Annular ring too small after drilling; features too close to the board outline.
- Minimum feature / spacing limits for UV exposure and etching.
- Classic geometric checks (clearance, min width, overlaps) as a baseline.

Results appear as markers in the viewer and as a list that links to the editor and source lines.

## Open questions / research

- LPKF E44: which input format does it accept outside CircuitPro (LMD/HPGL-style vs G-code)?
  Need sample files and the tool/head-change conventions.
- Makera: confirm model (Carvera / Carvera Air), ATC tool numbering, probing/auto-level commands.
- Geometry library for polygon offset/boolean (e.g. Clipper2 JS) vs writing our own.
- Exact KiCad `.gbrjob` colour names → RGB/opacity values; collect real board photos to tune them.
- Should `.pcam` also embed rendered previews (thumbnail PNG) for file browsers?
- Framework or vanilla JS? Default: vanilla ES modules + a small bundler only if needed.

## Out of scope (for now)

- PCB design/routing, schematic, 3D component models, netlist-based (electrical) DRC, cloud features.
