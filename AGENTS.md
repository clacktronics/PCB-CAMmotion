# AGENTS.md

Guidance for AI coding agents (and humans) working on PCB-CAMmotion.
See `PROJECT_PLAN.md` for goals and milestones.

## What this is

A local-only, in-browser PCB CAM tool: Gerber + Excellon in; analysis, editing,
machine-specific toolpaths (LPKF E44, Makera Carvera, generic G-code), manufacturability DRC and UV film negatives out.
The whole project is saved as one downloadable `.pcam` file.

## Hard rules

- **Local only.** No network calls, no analytics, no remote fonts/CDNs at runtime.
  Vendor any third-party library into the repo.
- **Static app.** Must run by opening `index.html` or from any static server. No backend.
- **Never silently change geometry.** Parsing then exporting an unedited file must produce
  equivalent geometry. Add a round-trip test for any parser/serialiser change.
- **Units are explicit.** Store internally in one unit (mm) and convert at the edges.
  Never mix units inside a function without naming them (`xMm`, `feedMmMin`).
- **Everything lives in the `.pcam` project file.** Any new setting, edit, tool or result must
  be saved to and restored from `.pcam`. Add it to the schema, bump the schema version with
  a migration if the shape changes, and extend the save/load round-trip test.
  `localStorage`/IndexedDB is only for autosave recovery, never the only copy.
- **Keep original files untouched** inside `.pcam` (`sources/`); store edits separately.
- **Machine output is safety-critical.** Post-processor changes need a test with expected
  output, and must keep safe-Z moves, spindle on/off, and feed limits intact.

- **Bonus features are not to be built yet.** DXF/SVG/bitmap import, BOM/3D model/placement
  checks, stencil generation and panelisation are listed in `PROJECT_PLAN.md` → Bonus
  features. Don't implement them unless asked, but don't design anything that would block them.

## Code layout

```
src/parse  src/model  src/render  src/render3d  src/analyze  src/edit
src/cam    src/drc    src/post   src/export  src/project  src/ui  src/check
test/      samples/   tools/     vendor/     dist/
```

- `index.html` loads `dist/app.js`, an IIFE bundle of `src/ui/main.js` made by
  `npm run build` (esbuild, dev-only). Browsers block ES modules on `file://`, so the bundle
  is **committed**; after changing anything under `src/` run `npm run build` and commit
  `dist/app.js` too (`npm run lint` fails if it is stale). Never edit `dist/` by hand.
- Third-party code used at runtime is copied into `vendor/<name>/` with its LICENSE
  (currently fflate for the `.pcam` ZIP container, three.js for the 3D view and Clipper
  for polygon booleans/offsets; the build minifies three.js and Clipper into the bundle and
  aliases three.js's `three` import).

- Parsers produce a command list that keeps source line numbers.
- Stackup and layer roles come from the KiCad `.gbrjob` first, then Gerber X2 attributes,
  then filename guesses. Material colours live in one data table — never hard-code colours
  in render code.
- `edit/` operates on the command model, not on rendered pixels. Edits are JSON ops on the
  normalised command list, saved in `model/edits.json` and replayed on load; every op must
  keep the current point for the commands after it, and the edited file must write back to
  exactly the image shown (`test/unit/edit/`).
- `drc/` checks use the same tool library and toolpaths as `cam/` — don't duplicate
  offsetting logic. Every finding should carry a location and source line ref.
- Each machine post-processor lives in its own file in `src/post/` and implements the
  same interface (header, tool change, moves, drill cycle, footer).

## Style

- Plain JavaScript ES modules (or TypeScript if adopted project-wide — don't mix).
- Small pure functions for geometry; keep DOM code in `render/` and `ui/` only.
- Name things after the Gerber/Excellon spec terms (aperture, D-code, region, polarity, macro).
- Comment non-obvious spec behaviour with the spec section it comes from.

## Testing (see `PROJECT_PLAN.md` → Testing & QA)

- **Tests come with the code.** Every feature lands with its fixture and tests in the same
  commit. Write the fixture and a failing test first, then build until it passes.
- **Bug fixes start with a failing test** that reproduces the bug.
- **`npm run check` must pass before every commit** (lint + unit + e2e). Never commit on red;
  a red CI is fixed before new feature work.
- **Never skip, disable or loosen a test to get green.** Fix the code, or explain in the
  commit why the test was wrong.
- **Logic must be testable in Node:** no DOM in parse/model/analyze/edit/cam/drc/post/
  project/check. `test/unit/` mirrors the `src/` layout.
- **Golden files change only on purpose:** `npm run golden:update`, review the diff, and
  say why in the commit message.
- **Machine output:** every post-processor output must pass the G-code safety checker
  (`src/check/`), in tests and before export in the app. Changes to a post-processor or
  machine profile also need the `docs/qa/` hardware checklist before the milestone closes.
- **Fixtures stay tiny** (one feature per file) in `test/fixtures/`; real-world boards
  go in `samples/`. Add a `.pcam` fixture whenever the schema version changes.
- **Synthetic Gerbers** live in `test/fixtures/synthetic/` and are generated by
  `node tools/synth/generate.mjs` (deterministic). They are **gitignored — never commit
  them**; `npm test` generates them on demand (`--if-stale`). Never hand-edit them: change
  the generator. Every parser must be run against all of them via `manifest.json`
  and meet each file's `expect` (`ok` / `warning` / `error` / `limit`). Keep generated files
  modest (largest ~30 MB) so test runs stay fast.
- Before committing UI changes, also load a sample in the browser and look at it.

## References

- Ucamco Gerber Layer Format Specification (current revision).
- Excellon / IPC-NC-349 drill format.
- Machine manuals for LPKF ProtoMat E44 and Makera Carvera.
