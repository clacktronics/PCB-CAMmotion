# `.pcam` fixtures

One set per schema version, **frozen once committed**: they prove that files saved by
older versions still load and migrate. Never regenerate them after the schema changes —
add new ones for the new version instead (AGENTS.md → "Add a `.pcam` fixture whenever
the schema version changes").

| file | schema | contents |
|------|--------|----------|
| `v1-empty.pcam` | 1 | Empty project named "empty", created 2026-10-15T00:00:00Z |
| `v1-with-source.pcam` | 1 | One CRLF Gerber in `sources/`, a stackup, settings, a manifest field and a zip entry this version doesn't know (`future/notes.txt`) — both must survive load → save |
| `v2-with-edits.pcam` | 2 | One CRLF Gerber (`board-F_Cu.gbr`) and `model/edits.json`: move, add a pad, delete, plus one undone edit (a region) in the redo list |
| `v3-with-node-edits.pcam` | 3 | One CRLF Gerber (`board-F_Cu.gbr`, a pad and a region with a G75 arc) and `model/edits.json`: region corner edits (moveVertex, insertVertex, deleteVertex), plus one undone moveVertex in the redo list |

The schema-1 files were created with `src/project/pcam.js` at schema 1, the schema-2 and schema-3
files with `createProject` / `layerEditor` / `commitEdit` (src/project/project.js) at their
schema (see the commits that added them).
