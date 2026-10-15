# PCB-CAMmotion — Project Plan

Browser-based, local-only CAM for PCBs. Load Gerber + Excellon drill files, inspect and edit
them, and output either CNC toolpaths (machine-specific) or UV-exposure negatives.

## Goals

1. **Import & view** Gerber (RS-274X / X2) and Excellon drill files.
2. **Analyse** the internals of a Gerber: commands, apertures, macros, polarity, regions,
   and the shapes they produce.
3. **Edit** Gerber and drill data with real editing tools, then export valid files again.
4. **CAM output**:
   - Isolation milling, drilling, and board-outline cutting as toolpaths.
   - Machine-specific post-processors — first targets: **LPKF ProtoMat E44** and
     **Makera Carvera** (confirm exact model).
   - Generic G-code (GRBL / Marlin / LinuxCNC) as a baseline.
   - Film/negative output (SVG / PNG / PDF at true scale, mirror + invert options) for UV exposure.
5. **Manufacturability DRC**: check the design against the real tools and machine
   (can this actually be milled/drilled/exposed?), not just abstract design rules.

## Constraints

- Runs entirely in the browser. No server, no uploads, no telemetry.
- Opens from a static `index.html` (works from `file://` or any static host).
- Works offline once loaded.

## Architecture (simple)

```
src/
  parse/      Gerber + Excellon parsers  -> command list (AST) with source line refs
  model/      Geometry model: primitives, apertures, layers, board
  render/     Canvas/WebGL viewer, layer stack, zoom/pan, selection
  analyze/    Aperture/shape stats, command inspector, step-through playback
  edit/       Editing tools + undo/redo; serialise back to Gerber/Excellon
  cam/        Offsetting (isolation), drill grouping, outline, tool library
  drc/        Manufacturability checks against tools, machine and process limits
  post/       Post-processors: generic, lpkf-e44, makera-carvera
  export/     G-code / machine files, film negatives (SVG/PNG/PDF)
  ui/         App shell, panels, settings
test/         Parser/edit round-trip tests and sample files
samples/      Small reference Gerber/drill sets
```

Key idea: **one command-level model** that parsing, analysis, editing and export all share,
so edits round-trip to valid files and analysis can point back to source lines.

## Milestones

| # | Milestone | Done when |
|---|-----------|-----------|
| 0 | Skeleton | Static app loads, file drop works, tests run |
| 1 | Parsers | Gerber + Excellon parse into the command model; sample files pass |
| 2 | Viewer | Layers render correctly (polarity, regions, macros), zoom/pan/select |
| 3 | Analyser | Aperture table, shape gallery, command inspector, step-through playback |
| 4 | Editor | Select/move/delete/add pads, traces, regions, drills; undo/redo; export round-trips |
| 5 | Film output | Scaled, mirrored, inverted negatives print at exact size |
| 6 | CAM core | Isolation paths (multi-pass), drilling, outline with tabs; tool library |
| 7 | DRC | Milling-aware checks report issues on the board, linked to source lines (see below) |
| 8 | Generic post | G-code preview + simulation, export |
| 9 | Machine posts | LPKF E44 and Makera Carvera output tested on real machines |
| 10 | Polish | Project save/load (local file), presets, docs |

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
- Framework or vanilla JS? Default: vanilla ES modules + a small bundler only if needed.

## Out of scope (for now)

- PCB design/routing, schematic, netlist-based (electrical) DRC, cloud features.
