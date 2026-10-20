// .pcam project schema: the in-memory project shape, its version and the migrations that
// bring older files forward. See PROJECT_PLAN.md → "Project file — .pcam".
//
// In-memory project (schema 2):
//   {
//     manifest: { format, schemaVersion, appVersion, name, created, modified, units, ...unknown },
//     sources:  [{ name, bytes: Uint8Array }]   original files, byte-for-byte untouched
//     settings: {}                              project settings (settings/project.json)
//     stackup:  null | {}                       stackup.json (null = not set yet)
//     tools:    {}                              tools.json
//     edits:    { [sourceName]: { base, ops, redo } }   model/edits.json (src/edit/session.js)
//     extra:    { [zipPath]: Uint8Array }       entries this version does not understand, kept verbatim
//   }
//
// Bumping SCHEMA_VERSION: add MIGRATIONS[oldVersion], a fixture in test/fixtures/pcam/ for
// the new version, and extend test/unit/project/pcam.test.js.

import { APP_VERSION } from '../version.js';

export const PCAM_FORMAT = 'pcam';
export const SCHEMA_VERSION = 2;
export const PROJECT_UNITS = 'mm';

/**
 * A new, empty project.
 * @param {{ name?: string, now?: Date }} [options] `now` is injectable for deterministic tests.
 */
export function createEmptyProject({ name = 'untitled', now = new Date() } = {}) {
  const stamp = now.toISOString();
  return {
    manifest: {
      format: PCAM_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      appVersion: APP_VERSION,
      name,
      created: stamp,
      modified: stamp,
      units: PROJECT_UNITS,
    },
    sources: [],
    settings: {},
    stackup: null,
    tools: {},
    edits: {},
    extra: {},
  };
}

/**
 * Migrations from version N to N+1. Each takes and returns the raw decoded file
 * `{ manifest, entries }` (entries: zip path → Uint8Array) so a migration can move or
 * rewrite any entry. Never drop data a migration does not understand.
 * @type {Record<number, (raw: {manifest: object, entries: Record<string, Uint8Array>}) => {manifest: object, entries: Record<string, Uint8Array>}>}
 */
export const MIGRATIONS = {
  // 1 → 2: editing (milestone 4) adds model/edits.json. A schema-1 file has no edits, so only
  // the version changes; the bump makes older apps refuse files whose geometry they would
  // show unedited.
  1: (raw) => ({ ...raw, manifest: { ...raw.manifest, schemaVersion: 2 } }),
};

/**
 * Apply migrations until the raw file is at SCHEMA_VERSION.
 * @param {{manifest: object, entries: Record<string, Uint8Array>}} raw
 * @param {Record<number, Function>} [migrations] injectable for tests
 * @param {number} [target]
 */
export function migrate(raw, migrations = MIGRATIONS, target = SCHEMA_VERSION) {
  let current = raw;
  while (current.manifest.schemaVersion < target) {
    const from = current.manifest.schemaVersion;
    const step = migrations[from];
    if (!step) throw new Error(`No migration from .pcam schema ${from} to ${from + 1}`);
    current = step(current);
    if (current.manifest.schemaVersion !== from + 1) {
      throw new Error(`Migration from schema ${from} did not set schemaVersion to ${from + 1}`);
    }
  }
  return current;
}
