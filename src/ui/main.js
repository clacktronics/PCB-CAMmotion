// App shell: project state, file drop / open / save. DOM code lives here and in render/ only.
// Bundled into dist/app.js by tools/build.mjs (Chrome refuses ES modules from file://).

import { createEmptyProject, SCHEMA_VERSION } from '../project/schema.js';
import { saveProject, loadProject, addSource, isPcamFileName, pcamFileName } from '../project/pcam.js';
import { APP_VERSION } from '../version.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  project: createEmptyProject(),
  dirty: false,
};

function formatBytes(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function setStatus(message, kind = 'info') {
  const el = $('#status');
  el.textContent = message;
  el.dataset.kind = kind;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}

function render() {
  const { project, dirty } = state;
  document.title = `${dirty ? '• ' : ''}${project.manifest.name} — PCB-CAMmotion`;
  const name = $('#project-name');
  if (document.activeElement !== name) name.value = project.manifest.name;
  $('#save').classList.toggle('attention', dirty);

  const list = $('#sources');
  list.replaceChildren(
    ...project.sources.map((s) => {
      const row = document.createElement('tr');
      const cells = [s.name, formatBytes(s.bytes.length)];
      for (const text of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        row.append(td);
      }
      return row;
    }),
  );
  $('#sources-table').hidden = project.sources.length === 0;
  $('#empty').hidden = project.sources.length > 0;
  $('#project-info').textContent =
    `schema ${project.manifest.schemaVersion} · ${project.manifest.units} · app ${APP_VERSION}`;
}

function confirmDiscard() {
  return !state.dirty || window.confirm('Discard unsaved changes to this project?');
}

function setProject(project, dirty = false) {
  state.project = project;
  state.dirty = dirty;
  render();
}

async function openPcam(file) {
  try {
    const project = loadProject(new Uint8Array(await file.arrayBuffer()));
    setProject(project);
    setStatus(`Opened ${file.name} (${project.sources.length} source file${project.sources.length === 1 ? '' : 's'})`);
  } catch (e) {
    setStatus(`Could not open ${file.name}: ${e.message}`, 'error');
  }
}

async function addFiles(files) {
  let project = state.project;
  for (const file of files) project = addSource(project, file.name, new Uint8Array(await file.arrayBuffer()));
  setProject(project, true);
  setStatus(`Added ${files.length} file${files.length === 1 ? '' : 's'} to the project`);
}

/** Route dropped or picked files: a lone .pcam opens a project, anything else is imported. */
async function handleFiles(fileList) {
  const files = [...fileList];
  if (files.length === 0) return;
  const pcams = files.filter((f) => isPcamFileName(f.name));
  if (pcams.length > 0) {
    if (files.length > 1) {
      setStatus('Drop a .pcam project on its own, not together with other files', 'error');
      return;
    }
    if (confirmDiscard()) await openPcam(pcams[0]);
    return;
  }
  await addFiles(files);
}

function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function save() {
  const project = { ...state.project, manifest: { ...state.project.manifest, modified: new Date().toISOString() } };
  const name = pcamFileName(project);
  download(saveProject(project), name, 'application/zip');
  setProject(project);
  setStatus(`Saved ${name}`);
}

function bindDropZone() {
  const overlay = $('#drop-overlay');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    if (e.dataTransfer?.files) handleFiles(e.dataTransfer.files);
  });
}

function init() {
  $('#new').addEventListener('click', () => {
    if (!confirmDiscard()) return;
    setProject(createEmptyProject());
    setStatus('New project');
  });
  $('#open').addEventListener('click', () => $('#open-input').click());
  $('#open-input').addEventListener('change', async (e) => {
    const [file] = e.target.files;
    e.target.value = '';
    if (file && confirmDiscard()) await openPcam(file);
  });
  $('#add').addEventListener('click', () => $('#add-input').click());
  $('#add-input').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    await handleFiles(files);
  });
  $('#save').addEventListener('click', save);
  $('#project-name').addEventListener('input', (e) => {
    state.project = { ...state.project, manifest: { ...state.project.manifest, name: e.target.value } };
    state.dirty = true;
    render();
  });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) e.preventDefault();
  });
  bindDropZone();
  render();
  setStatus(`Ready — drop Gerber, drill or .pcam files (project schema ${SCHEMA_VERSION})`);
  document.body.dataset.ready = 'true';
}

init();
