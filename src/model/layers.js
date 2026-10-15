// File kind detection and layer identification.
// Priority (AGENTS.md): KiCad .gbrjob FilesAttributes, then Gerber X2 .FileFunction, then the
// file name, then "other".
//
// A role is { type, side, index?, plated?, polarity, source }:
//   type:   copper | soldermask | legend | paste | profile | drill | other
//   side:   top | bottom | inner | all
//   source: gbrjob | x2 | filename | none | user

export const LAYER_TYPES = ['copper', 'soldermask', 'legend', 'paste', 'profile', 'drill', 'other'];

/**
 * Detect what kind of file this is from its name and content.
 * @returns {'gerber'|'excellon'|'gbrjob'|'pcam'|'zip'|'unknown'}
 */
export function detectFileKind(name, bytes) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pcam')) return 'pcam';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) return 'zip';
  if (lower.endsWith('.gbrjob')) return 'gbrjob';
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 64 * 1024)).replace(/^\uFEFF/, '');
  const t = head.trimStart();
  if (t.startsWith('{') && /"GeneralSpecs"|"FilesAttributes"|"MaterialStackup"/.test(head)) return 'gbrjob';
  if (/%FS[LTD][AI]|%MO(MM|IN)\*%|%ADD\d|^G04[ \w]|\nG04[ \w]|%TF\./.test(head)) return 'gerber';
  if (/^M48\s*$/m.test(head) || (/^T\d+C[\d.]+/m.test(head) && /^M30\s*$/m.test(head))) return 'excellon';
  if (/^\s*;.*(drill|DRILL|Drill)/.test(head) && /^[XY][-+\d.]+/m.test(head)) return 'excellon';
  if (/\b(X[-+]?\d+)(Y[-+]?\d+)?D0?[123]\*/.test(head)) return 'gerber';
  if (/\.(gbr|ger|pho|gtl|gbl|gts|gbs|gto|gbo|gtp|gbp|gko|gm\d+|g\d+)$/i.test(lower) && bytes.length === 0)
    return 'gerber';
  if (/\.(drl|xln|exc|drd)$/i.test(lower) && bytes.length === 0) return 'excellon';
  return 'unknown';
}

/** Map a Gerber X2 .FileFunction value list (or comma string) to a role. */
export function roleFromFileFunction(ff, polarityAttr) {
  const v = Array.isArray(ff) ? ff : String(ff || '').split(',');
  const kind = (v[0] || '').trim();
  const sideOf = (s) => {
    const x = String(s || '').toLowerCase();
    if (x.startsWith('top')) return 'top';
    if (x.startsWith('bot')) return 'bottom';
    if (x.startsWith('inr')) return 'inner';
    return 'all';
  };
  const pol = polarityAttr ? String(polarityAttr).toLowerCase() : null;
  switch (kind) {
    case 'Copper': {
      const index = Number(String(v[1] || '').replace(/^L/i, '')) || undefined;
      return { type: 'copper', side: sideOf(v[2]), index, polarity: pol || 'positive' };
    }
    case 'Soldermask':
      return { type: 'soldermask', side: sideOf(v[1]), polarity: pol || 'negative' };
    case 'Legend':
      return { type: 'legend', side: sideOf(v[1]), polarity: pol || 'positive' };
    case 'Paste':
      return { type: 'paste', side: sideOf(v[1]), polarity: pol || 'positive' };
    case 'Profile':
      return { type: 'profile', side: 'all', polarity: pol || 'positive' };
    case 'Plated':
    case 'NonPlated':
      return { type: 'drill', side: 'all', plated: kind === 'Plated', polarity: 'positive' };
    case '':
      return null;
    default:
      return { type: 'other', side: 'all', polarity: pol || 'positive', function: kind };
  }
}

const EXT_ROLES = {
  gtl: ['copper', 'top'],
  gbl: ['copper', 'bottom'],
  gts: ['soldermask', 'top'],
  gbs: ['soldermask', 'bottom'],
  gto: ['legend', 'top'],
  gbo: ['legend', 'bottom'],
  gtp: ['paste', 'top'],
  gbp: ['paste', 'bottom'],
  gko: ['profile', 'all'],
  gml: ['profile', 'all'],
  oln: ['profile', 'all'],
  dim: ['profile', 'all'],
  mil: ['profile', 'all'],
  fab: ['profile', 'all'],
  // Eagle legacy
  cmp: ['copper', 'top'],
  sol: ['copper', 'bottom'],
  stc: ['soldermask', 'top'],
  sts: ['soldermask', 'bottom'],
  plc: ['legend', 'top'],
  pls: ['legend', 'bottom'],
  crc: ['paste', 'top'],
  crs: ['paste', 'bottom'],
  tsm: ['soldermask', 'top'],
  bsm: ['soldermask', 'bottom'],
  tsk: ['legend', 'top'],
  bsk: ['legend', 'bottom'],
  tsp: ['paste', 'top'],
  bsp: ['paste', 'bottom'],
  // OrCAD
  top: ['copper', 'top'],
  bot: ['copper', 'bottom'],
  smt: ['soldermask', 'top'],
  smb: ['soldermask', 'bottom'],
  sst: ['legend', 'top'],
  ssb: ['legend', 'bottom'],
  spt: ['paste', 'top'],
  spb: ['paste', 'bottom'],
};

const OTHER_WORDS =
  /(fab|assembly|courtyard|crtyd|drawing|drill[-_ ]?map|map|bom|centroid|pos|readme|comments|dwgs|eco\d|margin|user|adhes|glue|keep[-_ ]?out|component)/;

/**
 * Guess a role from a file name. `kind` (from detectFileKind) separates drill files from
 * Gerbers with drill-like names.
 */
export function roleFromFilename(name, kind) {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot + 1) : '';
  const stem = dot >= 0 ? lower.slice(0, dot) : lower;
  const role = (type, side, extra = {}) => ({
    type,
    side,
    polarity: type === 'soldermask' ? 'negative' : 'positive',
    ...extra,
  });

  if (kind === 'excellon') {
    let plated = null;
    if (/npth|non[-_ ]?plated|unplated/.test(lower) || ext === 'npt') plated = false;
    else if (/(^|[^n])pth|plated/.test(lower)) plated = true;
    return { type: 'drill', side: 'all', plated, polarity: 'positive' };
  }
  if (kind !== 'gerber') return role('other', 'all');

  // KiCad layer names: F_Cu, B.Mask, In2_Cu, Edge_Cuts, F_SilkS ...
  const k =
    /(?:^|[-_.\s])(f|b|in\d+|inner\d+)[._](cu|mask|silks?|silkscreen|paste|fab|crtyd|courtyard|adhes|adhesive)(?:$|[-_.\s])/.exec(
      lower,
    );
  if (k) {
    const side = k[1] === 'f' ? 'top' : k[1] === 'b' ? 'bottom' : 'inner';
    const type = {
      cu: 'copper',
      mask: 'soldermask',
      silk: 'legend',
      silks: 'legend',
      silkscreen: 'legend',
      paste: 'paste',
    }[k[2]];
    if (!type) return role('other', side);
    const extra = side === 'inner' ? { index: Number(k[1].replace(/\D/g, '')) + 1 } : {};
    return role(type, side, extra);
  }
  if (/(?:^|[-_.\s])edge[._]cuts(?:$|[-_.\s])/.test(lower)) return role('profile', 'all');

  if (EXT_ROLES[ext]) return role(...EXT_ROLES[ext]);
  let m = /^g(\d+)$/.exec(ext) || /^gp(\d+)$/.exec(ext) || /^ly(\d+)$/.exec(ext) || /^in(\d+)$/.exec(ext);
  if (m) return role('copper', 'inner', { index: Number(m[1]) + (ext.startsWith('in') ? 1 : 0) });
  if (/^gm\d+$/.test(ext)) return role('profile', 'all');

  // words in the stem (Eagle CAM jobs, DipTrace, gEDA, OSH Park, PCB:NG, Altium long names)
  const side = /(^|[^a-z])(top|front)|^t(cream|paste|mask|silk)|[._-]t(cream|paste|mask|silk)|(^|[^a-z])(f)[-_]/.test(
    stem,
  )
    ? 'top'
    : /(bottom|bot(?!h)|back)|^b(cream|paste|mask|silk)|[._-]b(cream|paste|mask|silk)/.test(stem)
      ? 'bottom'
      : /(inner|internal|in)[-_ ]?(plane|layer)?[-_ ]?\d+/.test(stem)
        ? 'inner'
        : null;
  if (/mask|resist/.test(stem)) return role('soldermask', side || 'top');
  if (/silk|legend|overlay/.test(stem)) return role('legend', side || 'top');
  if (/paste|cream|stencil/.test(stem)) return role('paste', side || 'top');
  if (/outline|profile|edge|boundary|dimension|contour|mill|route|keepout/.test(stem)) return role('profile', 'all');
  if (OTHER_WORDS.test(stem)) return role('other', side || 'all');
  if (/copper|layer|signal|plane|cu\b/.test(stem) || side) {
    if (side === 'inner') {
      m = /(\d+)/.exec(stem.replace(/^.*?(inner|internal|in)/, ''));
      return role('copper', 'inner', m ? { index: Number(m[1]) + 1 } : {});
    }
    return role('copper', side || 'top');
  }
  return role('other', 'all');
}

/**
 * Identify one layer.
 * @param {{name:string, kind:string, fileFunction?:string[]|string, filePolarity?:string}} file
 * @param {{path:string, fileFunction:string, filePolarity?:string}[]} [jobFiles] from a .gbrjob
 */
export function identifyLayer(file, jobFiles = []) {
  const base = file.name.split(/[\\/]/).pop().toLowerCase();
  const fromJob = jobFiles.find((f) => f.path.split(/[\\/]/).pop().toLowerCase() === base);
  if (fromJob) {
    const r = roleFromFileFunction(fromJob.fileFunction, fromJob.filePolarity);
    if (r) return { ...r, source: 'gbrjob' };
  }
  if (file.fileFunction && (Array.isArray(file.fileFunction) ? file.fileFunction.length : file.fileFunction)) {
    const r = roleFromFileFunction(file.fileFunction, file.filePolarity);
    if (r) {
      if (r.type === 'drill' && file.kind === 'excellon') return { ...r, source: 'x2' };
      if (r.type !== 'drill') return { ...r, source: 'x2' };
    }
  }
  const r = roleFromFilename(file.name, file.kind);
  const guessed = !(r.type === 'other' && r.side === 'all');
  return { ...r, source: guessed ? 'filename' : 'none' };
}

/** Order layers for display: top-down physical order. */
export function layerSortKey(role) {
  const sideOrder = { top: 0, all: 1, inner: 1, bottom: 2 };
  const typeOrderTop = { legend: 0, paste: 1, soldermask: 2, copper: 3 };
  const typeOrderBottom = { copper: 0, soldermask: 1, paste: 2, legend: 3 };
  if (role.type === 'profile') return 100;
  if (role.type === 'drill') return 101 + (role.plated === false ? 1 : 0);
  if (role.type === 'other') return 200;
  if (role.side === 'inner') return 20 + (role.index || 0) / 100;
  if (role.side === 'top') return 10 + (typeOrderTop[role.type] ?? 5);
  return 30 + (typeOrderBottom[role.type] ?? 5) + sideOrder.bottom * 0;
}
