import { mountAscii } from './features/ascii/mount.js';
import { mountContinuation } from './features/continuation/mount.js';
import { mountWalkthrough } from './features/walkthrough/mount.js';
import { createMotion } from './lib/motion.js';
import { mountNavigation } from './lib/navigation.js';
import type { Scene } from './lib/scene.js';

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing page element: ${selector}`);
  return element;
}

const motion = createMotion();
const scenes: Scene[] = [];
let started = false;
let disposed = false;

function dispose() {
  if (disposed) return;
  disposed = true;
  motion.destroy();
  if (!started) for (const scene of scenes) scene.destroy();
  document.documentElement.classList.remove('is-enhanced');
}

try {
  const walkthrough = mountWalkthrough(required('[data-scroll-track]'), motion.invalidate);
  scenes.push(walkthrough);
  const continuation = mountContinuation(required('[data-continuation]'), motion.invalidate);
  scenes.push(continuation);
  scenes.unshift(
    mountNavigation({
      resolve: continuation.destination,
      seek: continuation.seek,
      invalidate: motion.invalidate,
    }),
  );
  scenes.push(
    mountAscii({
      canvas: required<HTMLCanvasElement>('[data-ambient]'),
      atmosphere: required('[data-atmosphere]'),
      region: required('[data-art-region]'),
      footerRegion: required('[data-footer-art-region]'),
      progress: () => ({
        workflow: walkthrough.getArtProgress(),
        entry: continuation.getEntryProgress(),
        details: continuation.getProgress(),
      }),
    }),
  );
  document.documentElement.classList.add('is-enhanced');
  motion.start(scenes, [...document.querySelectorAll<HTMLButtonElement>('[data-pause]')]);
  started = true;
} catch (error) {
  dispose();
  console.error('Page enhancement failed; the document remains readable.', error);
}

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(dispose);
}
