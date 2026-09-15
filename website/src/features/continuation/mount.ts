import type { Frame, Scene } from '../../lib/scene.js';
import { mountCopy } from './copy.js';
import { createDecoder, decodeStage } from './decode.js';
import { mountFiles } from './files.js';

const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function mountContinuation(
  root: HTMLElement,
  invalidate: () => void,
): Scene & {
  getProgress(): number;
  getEntryProgress(): number;
} {
  const stage = root.querySelector<HTMLElement>('[data-details-stage]');
  const composition = root.querySelector<HTMLElement>('.details-composition');
  const panels = [...root.querySelectorAll<HTMLElement>('[data-panel]')];
  const hashes = panels.map((panel) => `#${panel.id}`);
  const chapters = [...root.querySelectorAll<HTMLAnchorElement>('[data-chapter]')];
  if (!stage || !composition || panels.length !== 3)
    throw new Error('Continuation scene is incomplete');
  const decoders = panels.map(createDecoder);
  const abort = new AbortController();
  let progress = 0;
  let target = 0;
  let entryProgress = 0;
  let entryTarget = 0;
  let pinned = false;
  let initialHash = window.location.hash;
  let current = -1;
  let destroyed = false;
  let dirty = true;
  let lastSnap = false;
  root.classList.add('is-enhanced');

  function readScroll() {
    const rect = root.getBoundingClientRect();
    const viewport = stage?.clientHeight || window.innerHeight;
    target = clamp(-rect.top / Math.max(1, rect.height - viewport));
    entryTarget = clamp((window.innerHeight - rect.top) / (window.innerHeight * 0.78));
    if (!pinned) {
      let index = 0;
      for (const [number, panel] of panels.entries()) {
        if (panel.getBoundingClientRect().top < window.innerHeight * 0.5) index = number;
      }
      target = (index + 0.5) / 3;
    }
  }

  function seek(hash: string, focus = false) {
    const index = hash === '#details' ? 0 : hashes.indexOf(hash);
    const panel = panels[index];
    if (!panel || !stage) return;
    dirty = true;
    if (pinned) {
      progress = target = (index + 0.45) / 3;
      const top = window.scrollY + root.getBoundingClientRect().top;
      const travel = root.offsetHeight - stage.offsetHeight;
      window.scrollTo({ top: top + target * travel, behavior: 'instant' });
    } else {
      panel.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
    readScroll();
    paint({ deltaMs: 0, elapsedSeconds: 0, snap: true });
    if (focus) {
      panel.tabIndex = -1;
      panel.focus({ preventScroll: true });
    }
    invalidate();
  }

  function measure() {
    if (destroyed || !stage || !composition) return;
    dirty = true;
    root.classList.add('is-pinned', 'is-measuring');
    const available = stage.clientHeight;
    pinned = composition.offsetHeight <= available - 88;
    root.classList.toggle('is-pinned', pinned);
    root.classList.remove('is-measuring');
    root.style.height = pinned ? `${available * 4}px` : '';
    for (const decoder of decoders) {
      if (pinned) decoder.measure();
      else decoder.paint(1);
    }
    current = -1;
    readScroll();
    progress = target;
    entryProgress = entryTarget;
    paint({ deltaMs: 0, elapsedSeconds: 0, snap: true });
    if (initialHash) {
      const hash = initialHash;
      initialHash = '';
      seek(hash);
    }
    invalidate();
  }

  function paint(frame: Frame) {
    if (!dirty && progress === target && entryProgress === entryTarget && frame.snap === lastSnap)
      return false;
    dirty = false;
    lastSnap = frame.snap;
    const ease = 1 - Math.exp(-frame.deltaMs / 70);
    progress = frame.snap ? target : progress + (target - progress) * ease;
    entryProgress = frame.snap ? entryTarget : entryProgress + (entryTarget - entryProgress) * ease;
    if (Math.abs(target - progress) < 0.00002) progress = target;
    if (Math.abs(entryTarget - entryProgress) < 0.00002) entryProgress = entryTarget;
    const { index, amount } = decodeStage(progress);
    if (current !== index) {
      current = index;
      for (const [number, panel] of panels.entries()) {
        const active = !pinned || number === index;
        panel.dataset.active = String(active);
        panel.inert = !active;
        panel.setAttribute('aria-hidden', String(!active));
      }
      for (const [number, chapter] of chapters.entries()) {
        if (number === index) chapter.setAttribute('aria-current', 'step');
        else chapter.removeAttribute('aria-current');
      }
    }
    for (const [number, decoder] of decoders.entries()) {
      decoder.paint(!pinned || frame.snap || number !== index ? 1 : amount);
    }
    return progress !== target || entryProgress !== entryTarget;
  }

  document.addEventListener(
    'click',
    (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor) return;
      const url = new URL(anchor.href);
      if (
        url.origin !== location.origin ||
        url.pathname !== location.pathname ||
        url.search !== location.search
      )
        return;
      if (url.hash !== '#details' && !hashes.includes(url.hash)) return;
      event.preventDefault();
      if (location.hash !== url.hash) history.pushState(null, '', url.hash);
      seek(url.hash, !root.contains(anchor));
    },
    { signal: abort.signal },
  );
  window.addEventListener('hashchange', () => seek(location.hash), { signal: abort.signal });
  const unmountFiles = mountFiles(root, measure);
  const unmountCopy = mountCopy(root);

  return {
    measure,
    readScroll,
    paint,
    getProgress: () => progress,
    getEntryProgress: () => entryProgress,
    destroy() {
      destroyed = true;
      abort.abort();
      unmountFiles();
      unmountCopy();
      for (const decoder of decoders) decoder.destroy();
      root.classList.remove('is-enhanced', 'is-pinned', 'is-measuring');
      root.style.removeProperty('height');
      for (const panel of panels) {
        panel.inert = false;
        panel.removeAttribute('aria-hidden');
        panel.removeAttribute('tabindex');
        delete panel.dataset.active;
      }
      for (const [index, chapter] of chapters.entries()) {
        if (index === 0) chapter.setAttribute('aria-current', 'step');
        else chapter.removeAttribute('aria-current');
      }
    },
  };
}
