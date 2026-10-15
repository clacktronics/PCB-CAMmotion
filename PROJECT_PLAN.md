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
| 7 | Generic post | G-code preview + simulation, export |
| 8 | Machine posts | LPKF E44 and Makera Carvera output tested on real machines |
| 9 | Polish | Project save/load (local file), presets, docs |

## Open questions / research

- LPKF E44: which input format does it accept outside CircuitPro (LMD/HPGL-style vs G-code)?
  Need sample files and the tool/head-change conventions.
- Makera: confirm model (Carvera / Carvera Air), ATC tool numbering, probing/auto-level commands.
- Geometry library for polygon offset/boolean (e.g. Clipper2 JS) vs writing our own.
- Framework or vanilla JS? Default: vanilla ES modules + a small bundler only if needed.

## Out of scope (for now)

- PCB design/routing, schematic, DRC beyond simple checks, cloud features.
