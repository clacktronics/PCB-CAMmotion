# `.pcam` fixtures

One set per schema version, **frozen once committed**: they prove that files saved by
older versions still load and migrate. Never regenerate them after the schema changes —
add new ones for the new version instead (AGENTS.md → "Add a `.pcam` fixture whenever
the schema version changes").

| file | schema | contents |
|------|--------|----------|
| `v1-empty.pcam` | 1 | Empty project named "empty", created 2026-10-15T00:00:00Z |
| `v1-with-source.pcam` | 1 | One CRLF Gerber in `sources/`, a stackup, settings, a manifest field and a zip entry this version doesn't know (`future/notes.txt`) — both must survive load → save |

Created with `src/project/pcam.js` at schema 1 (see the commit that added them).
