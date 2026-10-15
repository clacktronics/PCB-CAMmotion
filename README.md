# PCB-CAMmotion

Local-only, in-browser PCB CAM: Gerber + Excellon in; analysis, editing, machine-specific
toolpaths, manufacturability DRC and UV film negatives out. Nothing is uploaded — the app
runs entirely on your computer, and the whole project is one `.pcam` file.

**Status:** milestone 0 (skeleton + test harness). See [`PROJECT_PLAN.md`](PROJECT_PLAN.md).

## Use

Open `index.html` in a browser (straight from disk works), or run `npm start` and go to
<http://127.0.0.1:4173/>. Drop Gerber / drill / `.gbrjob` files onto the window to add them
to the project; **Save** downloads the project as `.pcam`; drop or **Open…** a `.pcam` to
continue where you left off.

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

`dist/app.js` is a committed bundle of `src/` because browsers refuse to load ES modules
from `file://`. Contributor and agent rules are in [`AGENTS.md`](AGENTS.md).
