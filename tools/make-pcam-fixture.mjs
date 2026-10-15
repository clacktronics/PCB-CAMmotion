#!/usr/bin/env node
// Writes test/fixtures/pcam/schema-v<N>.pcam: a small project saved with the current schema.
// Run once whenever SCHEMA_VERSION changes, and commit the new file (never overwrite an old one).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject, addSourceFile, buildLayers, SCHEMA_VERSION } from '../src/project/project.js';
import { savePcam } from '../src/project/pcam.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, `test/fixtures/pcam/schema-v${SCHEMA_VERSION}.pcam`);
if (existsSync(out) && !process.argv.includes('--force')) {
  console.error(`${out} exists; old fixtures must not change`);
  process.exit(1);
}
const now = '2026-10-15T00:00:00.000Z';
const p = createProject('fixture', now);
const sources = new Map();
for (const f of ['F_Cu', 'Edge_Cuts', 'F_Mask']) {
  const name = `synthetic-board-${f}.gbr`;
  addSourceFile(p, sources, name, new Uint8Array(readFileSync(join(root, 'test/fixtures/synthetic/board', name))), now);
}
addSourceFile(
  p,
  sources,
  'synthetic-board-PTH.drl',
  new Uint8Array(readFileSync(join(root, 'test/fixtures/synthetic/board/synthetic-board-PTH.drl'))),
  now,
);
buildLayers(p, sources);
p.view = { ...p.view, side: 'top', mode: 'debug', cx: 50, cy: 40, scale: 8 };
writeFileSync(out, savePcam(p, sources));
console.log(`wrote ${out}`);
