// Gerber job file (.gbrjob, Ucamco "Gerber Job Format" as written by KiCad): board specs,
// file -> layer mapping and the material stackup.

import { Diagnostics } from './diagnostics.js';
import { decodeText } from './text.js';
import { lookupMaterial } from '../model/materials.js';

/**
 * @param {Uint8Array|string} input
 * @returns {{job: object|null, diagnostics: Diagnostics, files: {path:string, fileFunction:string, filePolarity?:string}[], stackup: object|null}}
 */
export function parseGbrjob(input) {
  const diag = new Diagnostics();
  const res = { job: null, diagnostics: diag, files: [], stackup: null };
  const text = decodeText(input, diag);
  if (text === null) return res;
  let job;
  try {
    job = JSON.parse(text);
  } catch (e) {
    const m = /line (\d+)/.exec(e.message);
    const pos = /position (\d+)/.exec(e.message);
    const line = m ? Number(m[1]) : pos ? text.slice(0, Number(pos[1])).split('\n').length : text.split('\n').length;
    diag.error('BAD_JSON', `Job file is not valid JSON: ${e.message}`, line);
    return res;
  }
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    diag.error('BAD_JOB', 'Job file must be a JSON object', 1);
    return res;
  }
  res.job = job;
  // JSON has no positions after parsing: find the line of a stackup layer by its name
  const lineOfName = (name) => {
    const i = name ? text.indexOf(`"Name": ${JSON.stringify(name)}`) : -1;
    const j = i >= 0 ? i : name ? text.indexOf(JSON.stringify(name)) : -1;
    return j >= 0 ? text.slice(0, j).split('\n').length : undefined;
  };
  if (!job.Header) diag.warn('JOB_NO_HEADER', 'Job file has no Header section');
  const specs = job.GeneralSpecs || {};
  if (!job.GeneralSpecs) diag.warn('JOB_NO_SPECS', 'Job file has no GeneralSpecs section');

  for (const f of Array.isArray(job.FilesAttributes) ? job.FilesAttributes : []) {
    if (!f || typeof f.Path !== 'string') {
      diag.warn('JOB_BAD_FILE', 'FilesAttributes entry without a Path ignored');
      continue;
    }
    res.files.push({ path: f.Path, fileFunction: f.FileFunction || '', filePolarity: f.FilePolarity });
  }

  const stackup = {
    sizeMm: specs.Size ? [Number(specs.Size.X) || 0, Number(specs.Size.Y) || 0] : null,
    layerCount: Number(specs.LayerNumber) || null,
    boardThicknessMm: Number(specs.BoardThickness) || null,
    finish: specs.Finish || null,
    layers: [],
    mask: { top: null, bottom: null },
    silk: { top: null, bottom: null },
    substrate: null,
  };
  if (stackup.boardThicknessMm !== null && stackup.boardThicknessMm <= 0) {
    diag.error('BAD_THICKNESS', 'Board thickness must be > 0');
  }
  if (stackup.finish && !lookupMaterial('finish', stackup.finish).known) {
    diag.warn('UNKNOWN_FINISH', `Unknown surface finish "${stackup.finish}"; showing HASL`);
  }

  if (!Array.isArray(job.MaterialStackup)) {
    diag.warn('JOB_NO_STACKUP', 'Job file has no MaterialStackup: using the default stackup');
  } else {
    let seenCopper = false;
    for (const l of job.MaterialStackup) {
      if (!l || typeof l !== 'object') continue;
      const type = String(l.Type || '');
      const layer = {
        type,
        name: l.Name || '',
        thicknessMm: l.Thickness === undefined ? null : Number(l.Thickness),
        material: l.Material || null,
        color: l.Color || null,
      };
      if ((type === 'Copper' || type === 'Dielectric') && !(layer.thicknessMm > 0)) {
        diag.error(
          'BAD_THICKNESS',
          `Stackup layer "${layer.name}" (${type}) has thickness ${layer.thicknessMm}; must be > 0`,
          lineOfName(layer.name),
        );
      } else if (layer.thicknessMm !== null && layer.thicknessMm < 0) {
        diag.error('BAD_THICKNESS', `Stackup layer "${layer.name}" has a negative thickness`, lineOfName(layer.name));
      }
      const side = seenCopper ? 'bottom' : 'top';
      if (type === 'Copper') seenCopper = true;
      if (type === 'SolderMask') {
        if (layer.color && !lookupMaterial('mask', layer.color).known) {
          diag.warn(
            'UNKNOWN_COLOUR',
            `Unknown solder mask colour "${layer.color}"; showing green`,
            lineOfName(layer.name),
          );
        }
        stackup.mask[side] = layer.color || 'Green';
      }
      if (type === 'Legend') {
        if (layer.color && !lookupMaterial('silk', layer.color).known) {
          diag.warn(
            'UNKNOWN_COLOUR',
            `Unknown silkscreen colour "${layer.color}"; showing white`,
            lineOfName(layer.name),
          );
        }
        stackup.silk[side] = layer.color || 'White';
      }
      if (type === 'Dielectric' && layer.material) {
        if (!lookupMaterial('substrate', layer.material).known) {
          diag.warn(
            'UNKNOWN_MATERIAL',
            `Unknown dielectric material "${layer.material}"; showing FR4`,
            lineOfName(layer.name),
          );
        }
        stackup.substrate ??= layer.material;
      }
      stackup.layers.push(layer);
    }
  }
  res.stackup = stackup;
  return res;
}

/**
 * Check the job's referenced files against the files actually loaded.
 * @param {ReturnType<typeof parseGbrjob>} parsed
 * @param {string[]} available file names (base names)
 */
export function resolveJobFiles(parsed, available) {
  const have = new Set(available.map((n) => baseName(n).toLowerCase()));
  const missing = parsed.files.filter((f) => !have.has(baseName(f.path).toLowerCase()));
  for (const f of missing) {
    parsed.diagnostics.warn('JOB_FILE_MISSING', `Job file references "${f.path}", which was not loaded`);
  }
  return missing.map((f) => f.path);
}

export function baseName(p) {
  return String(p).split(/[\\/]/).pop();
}
