// Step-through playback of a layer's command stream, like a photoplotter drawing the image.
// Pure functions: the step is the number of commands executed (0 = nothing drawn yet,
// commands.length = the whole image). The renderer draws objects [0, visibleObjects(step)).

import { commandObjectRange, objectCommand } from './commands.js';

/** Number of image objects drawn once `step` commands have run. */
export function visibleObjects(image, step) {
  const ends = image.commandEnds;
  if (!ends || step <= 0) return 0;
  return ends[Math.min(step, ends.length) - 1];
}

/**
 * Where playback stands at `step`.
 * @returns {{step:number, total:number, command:number, objects:number, current:number[], head:number[]|null}}
 *   command = index of the command just run (-1 before the first); current = [start, end) of the
 *   objects it produced; head = plotter position (mm) after the last drawn object, or null
 */
export function playbackState(image, step) {
  const total = image.commandEnds?.length ?? 0;
  const s = clampStep(step, total);
  const objects = visibleObjects(image, s);
  const command = s - 1;
  const current = command >= 0 ? commandObjectRange(image, command) : [0, 0];
  const last = objects > 0 ? image.objects[objects - 1] : null;
  return { step: s, total, command, objects, current, head: last ? endPoint(last) : null };
}

/** Plotter position after an object: the flash point or the end of the draw. */
export function endPoint(o) {
  if (o.k === 'F') return [o.x, o.y];
  if (o.k === 'L' || o.k === 'A') return [o.x2, o.y2];
  if (o.k === 'R') {
    const c = o.contours[o.contours.length - 1];
    return [c[0], c[1]];
  }
  return null;
}

export function clampStep(step, total) {
  if (!Number.isFinite(step)) return total;
  return Math.max(0, Math.min(total, Math.round(step)));
}

/**
 * The next step from `step` in direction dir (+1/-1).
 * @param {'command'|'object'} by  'object' skips commands that draw nothing
 */
export function nextStep(image, step, dir, by = 'command') {
  const total = image.commandEnds?.length ?? 0;
  let s = clampStep(step, total);
  if (by !== 'object') return clampStep(s + dir, total);
  const ends = image.commandEnds;
  const made = (ci) => ends[ci] - (ci > 0 ? ends[ci - 1] : 0);
  if (dir > 0) {
    // run commands until one draws something
    while (s < total) {
      s++;
      if (made(s - 1) > 0) return s;
    }
    return total;
  }
  // back to the previous command that drew something
  while (s > 0) {
    s--;
    if (s === 0 || made(s - 1) > 0) return s;
  }
  return 0;
}

/** The step at which object `oi` has just been drawn (0 if unknown). */
export function stepForObject(image, oi) {
  return objectCommand(image, oi) + 1;
}
