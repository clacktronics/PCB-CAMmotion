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
  check/      G-code safety checker (used by tests AND before every export in the app)
tools/synth/   generator for the synthetic Gerbers
test/
  unit/       node:test unit tests, mirrors src/ layout
  golden/     expected outputs (G-code, machine files, reference renders)
  e2e/        Playwright browser tests + screenshot baselines
  fixtures/   tiny spec-feature files, .pcam files per schema version
    synthetic/  generated at test time (gitignored) synthetic Gerbers/drills/jobs + manifest.json
samples/      Real-world Gerber/drill sets + the CAMmotion test board
docs/qa/      Machine QA checklists and recorded results
```

Key idea: **one command-level model** that parsing, analysis, editing and export all share,
so edits round-trip to valid files and analysis can point back to source lines.

## Milestones

| # | Milestone | Done when |
|---|-----------|-----------|
| 0 | Skeleton + test harness | Static app loads, file drop works, empty `.pcam` saves and reloads; `node:test`, Playwright, ESLint/Prettier and CI running; no-network + `file://` e2e tests pass; G-code safety checker with its own tests; test board designed |
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

Every milestone is only done when its tests (see **Testing & QA → Tests per milestone**) are
written, passing in CI, and the previous milestones' tests still pass.

**Status (2026-10):** milestones 0 (skeleton + harness), 1 (parsers) and 2 (viewer) are
implemented with their tests; the machine-run part of the test board QA is still to do.
Decisions made on the way:
- No framework: plain ES modules, bundled by esbuild (dev dependency) into the committed
  `dist/app.js` classic script, because browsers block ES module imports on `file://`.
  `npm run lint` fails if the bundle is stale.
- The viewer's per-layer settings (visibility, opacity, role override) and view state live in
  `settings/project.json` of the schema-1 `.pcam` (`settings.layers`, `settings.view`);
  the stackup in `stackup.json`. No schema change was needed.
- Rendering: one DOM-free draw routine (`src/render/draw-image.js`) drives both the canvas
  and a pure-JS rasteriser, so Node tests check what the viewer draws; an e2e test compares
  the two pixel by pixel. "Reference renders" from gerbv/GerbView are not available yet, so
  correctness is pinned by analytic areas/pixels, mm-vs-inch XOR and screenshot baselines.
- Reference corpus: real boards and spec-feature files from tracespace (licences kept with
  them) in `samples/` and `test/fixtures/tracespace/`.
- Step-and-repeat closed only by M02 is accepted with a deprecation warning (older spec
  revisions allowed it and real files rely on it).

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

## Testing & QA

### Tools

- **`node:test`** (built into Node, no dependencies) for all logic. Works because parse,
  model, analyze, edit, cam, drc, post, project and check never touch the DOM.
- **Playwright** for browser tests (end-to-end, screenshots, 3D view).
- **fast-check** for property-based / fuzz tests (dev dependency only, never shipped).
- **ESLint + Prettier** for lint and formatting.
- **GitHub Actions** runs lint → unit → e2e on every push and pull request.
- Dev tools live in `package.json` `devDependencies`; the shipped app still has no build
  step and no runtime dependencies beyond vendored libraries.

Commands:
```
npm test            generate synthetic fixtures if stale, then unit + golden + property tests
npm run test:e2e    Playwright browser tests
npm run lint        ESLint + Prettier check
npm run check       all of the above — must pass before every commit
npm run golden:update   regenerate golden files (review the diff before committing!)
```

### Test layers

1. **Unit tests** — one tiny fixture file per Gerber/Excellon spec feature (apertures,
   macros, regions, step-and-repeat, polarity, arcs, mm/inch, zero suppression);
   geometry and offsetting edge cases; unit conversion.
2. **Round-trip tests** — parse → serialise → parse. Text may differ, so geometry is
   compared by rasterising both at high resolution and XOR-diffing (zero differing pixels).
   Enforces "never silently change geometry".
3. **Synthetic Gerbers** (`test/fixtures/synthetic/`, generated by
   `node tools/synth/generate.mjs` on demand before tests — not stored in git — and described
   by `manifest.json`): a coherent 2-layer test
   board with `.gbrjob` (trace/gap/drill ladders, thin annular ring, fine-pitch pads, pours),
   board variants (misaligned, inch, CRLF), every spec feature, deprecated syntax, ~50 broken
   files, hostile/resource-bomb files and large files (30 MB Gerber, 300k-hole drill). Each
   file has an expectation (`ok` / `warning` / `error` / `limit`), and often an error line
   and known facts, so one test can loop over the manifest.
4. **Reference corpus** — Ucamco's official Gerber test files plus real KiCad, Eagle and
   Altium exports in `samples/`. Reference renders generated once with an established
   viewer (gerbv / KiCad GerbView) and committed to `test/golden/`.
5. **Bad input** — malformed and truncated files must give an error with a line number,
   never crash or hang.
6. **Property / fuzz tests** — random shapes: isolation paths never cut copper, never
   self-intersect, always close; random byte streams never crash the parsers.
7. **Post-processor golden files** — expected output per machine (generic, LPKF E44,
   Makera Carvera) for a set of fixture boards. Any change shows as a diff.
8. **G-code safety checker** (`src/check/`) — runs in tests and in the app before every
   export; export is blocked on failure. Checks: no rapid moves below safe Z, spindle on
   before cutting, feeds/depths within the machine profile, all moves inside the machine
   envelope, valid tool changes, program ends safely (spindle off, Z up).
9. **DRC tests** — small crafted boards with known violations; assert exactly the
   expected findings (none missed, none extra).
10. **`.pcam` tests** — save → load gives an identical project; a fixture `.pcam` from
   every schema version must still load and migrate.
11. **Browser e2e (Playwright)** — full flow: drop files → view → edit → toolpaths → DRC →
    export → check the downloaded files and `.pcam`. Screenshot comparison of 2D and 3D
    views. **No-network test**: fail if the page makes any network request. **`file://`
    test**: app works opened straight from disk.
12. **Performance budgets** — a large reference board must parse and render within set
    times; CI fails on regressions.

### Machine QA (manual, recorded)

- **CAMmotion test board** (KiCad project + Gerbers in `samples/test-board/`): trace and
  gap width ladders, drill size ladder, pads of each aperture type, fine text, outline
  with tabs. Doubles as a calibration coupon and a DRC fixture.
- Checklist per machine in `docs/qa/` for any post-processor or machine-profile change:
  1. Safety checker passes; golden diff reviewed.
  2. Air cut (Z raised) — watch every tool change and move.
  3. Cut the test board on the LPKF E44 and Makera Carvera.
  4. Measure widths, gaps and hole sizes; record results with date, commit and photos.
- Measured errors become corrections in the machine profile **and** a new automated test.

### How testing runs alongside building

Tests are built with the feature, not afterwards. For every piece of work:

1. **Start with the fixture and the test.** Before writing a parser feature, add the tiny
   fixture file and a failing test. Before a CAM/DRC feature, add the board that shows
   the problem. Before a machine feature, write the expected output.
2. **Build until it passes**, running `npm test` constantly (it stays fast: seconds).
3. **Check it in the browser** with the real samples and the test board.
4. **`npm run check` passes** → commit. CI repeats it on every push; a red CI is fixed
   before any new feature work.
5. **Bugs:** first a test that reproduces it, then the fix.
6. **Golden file changes are deliberate:** regenerated with `golden:update`, the diff
   reviewed, and the reason written in the commit message.
7. **Milestone end:** all of its tests in place, previous milestones still green, and for
   machine milestones the `docs/qa/` checklist completed on real hardware.

### Tests per milestone

| # | Milestone | Tests added |
|---|-----------|-------------|
| 0 | Skeleton + harness | Synthetic Gerbers manifest test (generator done; `pretest` hook), CI pipeline, no-network + `file://` e2e, empty `.pcam` round-trip, safety checker unit tests, test board Gerbers in `samples/` |
| 1 | Parsers | Spec-feature fixtures, bad-input tests, parser fuzzing, reference corpus parses, `.gbrjob` + layer identification tests |
| 2 | Viewer | Reference render comparisons, screenshot tests, performance budget, material table tests |
| 3 | Analyser | Aperture/shape statistics vs. known values, source-line linking tests |
| 4 | Editor | Round-trip (XOR) tests, undo/redo tests, edits persisted in `.pcam` |
| 5 | Film output | Exact-scale checks (measure exported size), mirror/invert tests, print-to-PDF size check |
| 6 | CAM core | Offsetting property tests, toolpath golden files, tool library in `.pcam` |
| 7 | DRC | Crafted violation boards (exact findings), test board results |
| 8 | 3D view | 3D screenshot tests, stackup-from-`.gbrjob` tests, as-milled vs. toolpath consistency |
| 9 | Generic post | Golden G-code, safety checker on every output, simulator tests |
| 10 | Machine posts | Golden files per machine, `docs/qa/` hardware runs on E44 + Carvera |
| 11 | Polish | Full e2e flows for every preset, `.pcam` migration fixtures complete |

## Open questions / research

- LPKF E44: which input format does it accept outside CircuitPro (LMD/HPGL-style vs G-code)?
  Need sample files and the tool/head-change conventions.
- Makera: confirm model (Carvera / Carvera Air), ATC tool numbering, probing/auto-level commands.
- Geometry library for polygon offset/boolean (e.g. Clipper2 JS) vs writing our own.
- Exact KiCad `.gbrjob` colour names → RGB/opacity values; collect real board photos to tune them.
- Should `.pcam` also embed rendered previews (thumbnail PNG) for file browsers?
- ~~Framework or vanilla JS?~~ Decided in milestone 0: vanilla ES modules, bundled by esbuild
  into a committed `dist/app.js` because browsers refuse ES modules from `file://`.

## Bonus features (later — do NOT implement yet)

Wanted eventually, but not part of milestones 0–11. Recorded here so the core design
doesn't block them. Only start one when it is explicitly scheduled.

| Feature | What it would do | Design hooks to keep open now |
|---------|------------------|-------------------------------|
| **Import non-PCB files** | DXF, SVG and bitmaps (PNG/JPG/BMP) as layers: logos, outlines, artwork, mechanical drawings | Importers produce the same command model as the Gerber parser; bitmaps traced to polygons with a threshold. Imports get their own source type in `.pcam`. |
| **BOM, 3D models & placement files** | Import BOM (CSV), pick-and-place/centroid files and 3D models (STEP/WRL/GLB) to check footprints against pads (position, rotation, pin count, pad/pin fit) and show components in the 3D view | X2 component attributes (`.C`, `.P`, `.CRot`) kept in the model; 3D view has a slot for extra meshes; findings use the DRC result format. |
| **Stencil generation** | Paste-layer stencils for laser/vinyl cutting or CNC: aperture reduction, home-plate/window-pane patterns, frame, fiducials, SVG/DXF/G-code output | Built on the editor + CAM offsetting; outputs via the existing export/post-processor paths. |
| **Panelisation** | Arrange boards (same or mixed) into a panel with rails, mouse-bites, V-scores, tabs, fiducials and tooling holes; output panelised Gerbers/drills/toolpaths | Model supports multiple board instances with transforms (like step-and-repeat); toolpaths generated per instance. |

## Out of scope (for now)

- PCB design/routing, schematic, netlist-based (electrical) DRC, cloud features.
- The bonus features above until they are scheduled.
