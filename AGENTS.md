# AGENTS.md

Guidance for AI coding agents (and humans) working on PCB-CAMmotion.
See `PROJECT_PLAN.md` for goals and milestones.

## What this is

A local-only, in-browser PCB CAM tool: Gerber + Excellon in; analysis, editing,
machine-specific toolpaths (LPKF E44, Makera Carvera, generic G-code) and UV film negatives out.

## Hard rules

- **Local only.** No network calls, no analytics, no remote fonts/CDNs at runtime.
  Vendor any third-party library into the repo.
- **Static app.** Must run by opening `index.html` or from any static server. No backend.
- **Never silently change geometry.** Parsing then exporting an unedited file must produce
  equivalent geometry. Add a round-trip test for any parser/serialiser change.
- **Units are explicit.** Store internally in one unit (mm) and convert at the edges.
  Never mix units inside a function without naming them (`xMm`, `feedMmMin`).
- **Machine output is safety-critical.** Post-processor changes need a test with expected
  output, and must keep safe-Z moves, spindle on/off, and feed limits intact.

## Code layout

```
src/parse  src/model  src/render  src/analyze  src/edit
src/cam    src/post   src/export  src/ui
test/      samples/
```

- Parsers produce a command list that keeps source line numbers.
- `edit/` operates on the command model, not on rendered pixels.
- Each machine post-processor lives in its own file in `src/post/` and implements the
  same interface (header, tool change, moves, drill cycle, footer).

## Style

- Plain JavaScript ES modules (or TypeScript if adopted project-wide — don't mix).
- Small pure functions for geometry; keep DOM code in `render/` and `ui/` only.
- Name things after the Gerber/Excellon spec terms (aperture, D-code, region, polarity, macro).
- Comment non-obvious spec behaviour with the spec section it comes from.

## Testing

- Unit tests for parsers, geometry, and each post-processor.
- Keep small real-world samples in `samples/` (KiCad, Eagle, Altium exports where possible).
- Before committing: run the test suite and load a sample in the browser to check rendering.

## References

- Ucamco Gerber Layer Format Specification (current revision).
- Excellon / IPC-NC-349 drill format.
- Machine manuals for LPKF ProtoMat E44 and Makera Carvera.
