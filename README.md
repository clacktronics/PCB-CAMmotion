# PCB-CAMmotion

Local-only, in-browser PCB CAM: load Gerber (RS-274X / X2), Excellon drill files and the KiCad
Gerber job file, inspect them, and (in later milestones) edit them and generate toolpaths and
film negatives. Nothing leaves your computer. See `PROJECT_PLAN.md` for the goals and milestones
and `AGENTS.md` for the rules of the codebase.

## Use

Open `index.html` in a browser (straight from disk works) and drop in Gerber, drill, `.gbrjob`
or `.zip` files, or a `.pcam` project.

- **Layers** are identified from the `.gbrjob`, then Gerber X2 attributes, then file names; the
  function can be changed per layer. Visibility and opacity per layer.
- **Views:** realistic board colours (solder mask, finish, silkscreen, substrate and plated or
  non-plated holes, from the job file or the *Board materials* panel) or debug colours;
  top or bottom (mirrored) view. Wheel to zoom, drag to pan, **F** to fit.
- **Inspector:** click any pad, track, region or hole to see its aperture/tool, polarity,
  coordinates, X2 attributes and the source line it came from. Parser messages per file are
  listed with line numbers.
- **Project file:** *Save project* downloads a `.pcam` (a ZIP holding the original files
  byte-for-byte plus all settings). *Save as…* lets Chrome/Edge write back to the same file.
  A crash-recovery copy is kept in the browser and offered on the next start.

## Develop

```
npm install
npm run build      bundle src/ into dist/app.js (commit it: index.html loads it so file:// works)
npm test           synthetic fixtures (generated on demand) + unit/fuzz/performance tests
npm run test:e2e   Playwright browser tests (file://, no network, rendering, .pcam round trip)
npm run lint       ESLint + Prettier + bundle freshness
npm run check      all of the above — must pass before every commit
```

Source layout: `src/parse` (Gerber, Excellon, `.gbrjob` parsers → command lists with line
numbers), `src/model` (interpreted images in mm, apertures and macros, layer identification,
materials table, outline, hit testing), `src/render` (shared draw routine, canvas and pure-JS
rasteriser targets, board compositing, viewer), `src/project` (`.pcam`), `src/ui` (app shell).
