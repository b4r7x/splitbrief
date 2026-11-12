const FRAME_START = '\x1b[?2026h';
const FRAME_END = '\x1b[?2026l';

/** The length of the tail of `data` that can be the start of a frame start marker. */
function startMarkerTail(data: string): number {
  for (let size = Math.min(FRAME_START.length - 1, data.length); size > 0; size--) {
    if (data.endsWith(FRAME_START.slice(0, size))) return size;
  }
  return 0;
}

/**
 * Hands pty output to `sink` one whole frame at a time. Ink writes each frame between the
 * synchronized-output markers and the pty delivers it in many chunks, so a terminal fed chunk
 * by chunk shows a frame the app has not finished writing. Data outside a frame passes at once.
 * Call `flush` when the child exits, so the screen keeps a frame the app never closed.
 */
export function wholeFrames(sink: (data: string) => void) {
  let held = '';
  const give = (end: number) => {
    if (end === 0) return;
    sink(held.slice(0, end));
    held = held.slice(end);
  };
  return {
    feed: (chunk: string) => {
      held += chunk;
      const start = held.lastIndexOf(FRAME_START);
      const open = start !== -1 && !held.includes(FRAME_END, start);
      give(open ? start : held.length - startMarkerTail(held));
    },
    flush: () => give(held.length),
  };
}
