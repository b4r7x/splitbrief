import { mountAscii } from './features/ascii/mount.js';
import { mountDocs } from './features/docs/mount.js';
import { createMotion } from './lib/motion.js';

const motion = createMotion();
const docs = mountDocs(document.body, motion.invalidate);
const canvas = document.querySelector<HTMLCanvasElement>('[data-ambient]');
const atmosphere = document.querySelector<HTMLElement>('[data-atmosphere]');
const region = document.querySelector<HTMLElement>('[data-art-region]');
if (!canvas || !atmosphere || !region) throw new Error('Missing documentation artwork');
const art = mountAscii({
  canvas,
  atmosphere,
  region,
  progress: () => ({ workflow: 1, entry: 1, details: docs.progress() }),
});
document.documentElement.classList.add('is-enhanced');
motion.start([docs, art], [...document.querySelectorAll<HTMLButtonElement>('[data-pause]')]);
const dispose = () => {
  motion.destroy();
  document.documentElement.classList.remove('is-enhanced');
};
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(dispose);
}
