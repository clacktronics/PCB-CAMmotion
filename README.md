# PCB-CAMmotion

Local-only, in-browser PCB CAM: Gerber + Excellon in; analysis, editing, machine-specific
toolpaths, manufacturability DRC and UV film negatives out. Nothing is uploaded — the app
runs entirely on your computer, and the whole project is one `.pcam` file.

**Status:** milestones 0–4 (harness, parsers, viewer, analyser, editor). See [`PROJECT_PLAN.md`](PROJECT_PLAN.md).

## Use

Open `index.html` in a browser (straight from disk works), or run `npm start` and go to
<http://127.0.0.1:4173/>. Drop Gerber / drill / `.gbrjob` files onto the window to add them
to the project; **Save** downloads the project as `.pcam`; drop or **Open…** a `.pcam` to
continue where you left off.

- **Layers** are identified from the `.gbrjob`, then Gerber X2 attributes, then file names; the
  function can be changed per layer. Visibility and opacity per layer. `.zip` archives are
  unpacked.
- **Views:** *Realistic* board colours (solder mask, finish, silkscreen, substrate and plated
  or non-plated holes, from the job file or the *Board materials* panel); *Layers* (one colour
  per layer function); *Classic* (gerbv-style palette per file on black); *XOR* (layer colours
  XORed: give two layers the same colour and identical parts cancel, so misregistration or
  revision differences stand out); *Outline* (wireframe, clear polarity dashed). Top or
  bottom (mirrored) view, dark or light background. Wheel to zoom, drag to pan, **F** to fit.
- **Layers like a mixer:** every layer has an **S** (solo) button. Solo one or several layers
  to see only those; with none soloed, every layer is shown. With one layer soloed, clicking
  another layer (or **↑/↓**) moves the solo. In *Realistic*, soloed layers show as slices of
  the board in their real materials (inner copper as bare copper on substrate). In the
  analysis views each layer also has a colour (click the bar on its left) and **inv**ert
  (e.g. the solder mask material instead of its openings). **S** key: solo the selected layer,
  **I**: invert it, **B**: background. All of it is saved in the `.pcam`.
- **Inspector:** click any pad, track, region or hole to see its aperture/tool, polarity,
  coordinates, X2 attributes and the source line it came from. Parser messages per file are
  listed with line numbers.
- **Analyser** (the dock under the board, for the selected layer; the **Analyser** toolbar button
  or **A** turns it on and off, and hiding it ends playback and clears the highlight):
  - *Apertures*: every aperture (or drill tool) with its shape, size, area, flashes, draws, arcs,
    drawn length, `.AperFunction` and definition line; unused ones greyed out. Click a column to
    sort, click a row to highlight every use on the board.
  - *Shapes*: layer statistics (objects by kind and polarity, drawn length, narrowest draw,
    smallest/largest flash, regions) and a gallery of the aperture shapes, macros and blocks.
  - *Commands*: the command stream with source lines, each command in file syntax and what it
    does (coordinates in mm). Clicking a command selects what it drew; the inspector's
    **Show command** jumps from a clicked feature to the command that drew it.
  - *Playback*: ⏮ ◀ ▶ ▶| ⏭ and the slider step through the commands like a photoplotter,
    by command or by drawn object, at 1–10 000 commands per second (**,** / **.** step back /
    forward). ⏭ ends playback and shows the whole layer again.
  - Hovering a feature shows its aperture, kind, polarity and source line in the status bar.
    Highlight, playback position and the dock's tab are saved in the `.pcam`.
- **Editor** (the **Edit** toolbar button or **E**; works on the selected layer):
  - *Select* (**V**): click an object, **Shift**+click to add/remove, **Shift**+drag a box,
    **Ctrl+A** for all. Drag a selected object to move the selection; the arrow keys nudge it
    one grid step (**Shift**: ten); **Move by** takes exact X/Y in mm. **Del** deletes.
  - *Pad* (**P**) places a flash with an existing aperture or a new circle / rectangle /
    obround; on a drill layer it is *Hole* and places a hole of the given diameter (reusing
    the tool of that size, or defining a new one). *Track* (**T**): click the points,
    double-click or **Enter** to finish. *Region* (**R**): click the corners, close on the
    first point. Everything snaps to the grid (0 = off).
  - **To region** turns the selected pads, tracks and fills into G36/G37 regions: a single
    object exactly (arcs kept as G02/G03), overlapping objects unified into one outline.
    **Unify layer → regions** does it to the whole layer: every track, pad, fill, step and
    repeat copy and clear-polarity cut-out becomes non-overlapping regions (holes are joined
    to their outline by cut-ins; arcs within 0.5 µm).
  - **Undo / Redo** (**Ctrl+Z**, **Ctrl+Shift+Z** / **Ctrl+Y**), **Revert** (back to the
    original file), **Export file** (the edited Gerber or Excellon, same file name). Edited
    layers show ✎ with the number of edits. The edits (and the undo history) are saved in the
    `.pcam`; the original files stay untouched in it. Objects made by step and repeat, and
    routed drill paths, cannot be edited one by one yet.
- **Save as…** (Chrome/Edge) writes back to the chosen file on later saves. A crash-recovery
  copy is kept in the browser and offered on the next start.

## Develop

Requires Node 22+.

```
npm ci
npx playwright install chromium   # once, for the browser tests
npm run check                     # lint + unit + e2e — must pass before every commit
```

| Command | What it does |
|---------|--------------|
| `npm test` | Unit tests (`node:test`); generates the synthetic Gerbers first if stale |
| `npm run test:e2e` | Playwright tests over http and `file://`, with a no-network guard |
| `npm run lint` | ESLint, Prettier check, and a check that `dist/app.js` is up to date |
| `npm run build` | Rebuild `dist/app.js` after changing `src/` (commit the result) |
| `npm run golden:update` | Rewrite golden files — review the diff before committing |
| `npm run testboard` | Regenerate `samples/test-board/` |

Source layout: `src/parse` (Gerber, Excellon, `.gbrjob` → command lists with line numbers),
`src/model` (images in mm, apertures/macros, layer identification, materials table, outline,
hit testing), `src/analyze` (aperture table, shape statistics, command ↔ object links,
playback), `src/render` (one draw routine for the canvas and a pure-JS rasteriser, board
compositing, viewer), `src/project` (`.pcam`), `src/check` (G-code safety), `src/ui`.
Real-world boards for the reference corpus are in `samples/` (licences kept with each board).

`dist/app.js` is a committed bundle of `src/` because browsers refuse to load ES modules
from `file://`. Contributor and agent rules are in [`AGENTS.md`](AGENTS.md).
