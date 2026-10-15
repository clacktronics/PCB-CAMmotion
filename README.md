# PCB-CAMmotion

Local-only, in-browser PCB CAM: Gerber + Excellon in; analysis, editing, machine-specific
toolpaths, manufacturability DRC and UV film negatives out. Nothing is uploaded — the app
runs entirely on your computer, and the whole project is one `.pcam` file.

**Status:** milestones 0–2 (harness, parsers, viewer). See [`PROJECT_PLAN.md`](PROJECT_PLAN.md).

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
- **Hidden layers:** per-layer colour and **inv**ert (e.g. show the solder mask material
  instead of its openings, or the paste as stencil), **Solo** (**S**) to show only the
  selected layer and **↑/↓** to flip through them (in *Realistic*, solo shows the layer as a
  slice of the board in its real material: inner copper as bare copper on substrate), **I** to invert the selected layer,
  **B** for the background. All of it is saved in the `.pcam`.
- **Inspector:** click any pad, track, region or hole to see its aperture/tool, polarity,
  coordinates, X2 attributes and the source line it came from. Parser messages per file are
  listed with line numbers.
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
hit testing), `src/render` (one draw routine for the canvas and a pure-JS rasteriser, board
compositing, viewer), `src/project` (`.pcam`), `src/check` (G-code safety), `src/ui`.
Real-world boards for the reference corpus are in `samples/` (licences kept with each board).

`dist/app.js` is a committed bundle of `src/` because browsers refuse to load ES modules
from `file://`. Contributor and agent rules are in [`AGENTS.md`](AGENTS.md).
