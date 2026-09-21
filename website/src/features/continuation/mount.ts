import { mountCopy } from '../../lib/copy.js';
import { createDecoder } from '../../lib/decoder.js';
import type { Frame, Scene } from '../../lib/scene.js';
import { createSwap } from '../../lib/swap.js';
import { decodeStage } from './decode.js';
import { mountFiles } from './files.js';
import { mountInstall } from './install.js';

const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function mountContinuation(
  root: HTMLElement,
  invalidate: () => void,
): Scene & {
  getProgress(): number;
  getEntryProgress(): number;
  destination(hash: string): { element: HTMLElement; top: number } | undefined;
  seek(hash: string): void;
} {
  const stage = root.querySelector<HTMLElement>('[data-details-stage]');
  const composition = root.querySelector<HTMLElement>('.details-composition');
  const readingWindow = root.querySelector<HTMLElement>('.detail-panels');
  const panels = [...root.querySelectorAll<HTMLElement>('[data-panel]')];
  const hashes = panels.map((panel) => `#${panel.id}`);
  const chapters = [...root.querySelectorAll<HTMLAnchorElement>('[data-chapter]')];
  if (!stage || !composition || !readingWindow || panels.length !== 3)
    throw new Error('Continuation scene is incomplete');
  const decoders = panels.map((panel) => createDecoder(panel));
  const filePanel = root.querySelector<HTMLElement>('#file-description');
  const installPanel = root.querySelector<HTMLElement>('.install-methods');
  if (!filePanel || !installPanel) throw new Error('Detail tabs are incomplete');
  const fileDecoder = createDecoder(filePanel, '[data-file-decode]');
  const installDecoder = createDecoder(installPanel, '[data-install-decode]');
  const fileSwap = createSwap(invalidate, () => {
    fileDecoder.measure();
    decoders[1]?.measure();
  });
  const installSwap = createSwap(invalidate, () => {
    fitPanels();
    for (const decoder of decoders) decoder.measure();
    fileDecoder.measure();
    installDecoder.measure();
  });
  let progress = 0;
  let target = 0;
  let entryProgress = 0;
  let entryTarget = 0;
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
  }

  function destination(hash: string) {
    const index = hash === '#details' ? 0 : hashes.indexOf(hash);
    const panel = panels[index];
    if (!panel || !stage) return;
    const top =
      scrollY +
      root.getBoundingClientRect().top +
      ((index + 0.45) / 3) * (root.offsetHeight - stage.offsetHeight);
    return { element: panel, top };
  }

  function seek(hash: string) {
    const next = destination(hash);
    if (!next) return;
    initialHash = '';
    dirty = true;
    window.scrollTo({ top: next.top, behavior: 'instant' });
    readScroll();
    paint({ deltaMs: 0, snap: true });
    invalidate();
  }

  function fitPanels() {
    root.classList.remove('is-tight');
    root.classList.toggle(
      'is-tight',
      root.classList.contains('is-compact') &&
        panels.some((panel) => panel.offsetHeight > (readingWindow?.clientHeight ?? 0)),
    );
  }

  function measure() {
    if (destroyed || !stage || !composition || !readingWindow) return;
    dirty = true;
    root.classList.add('is-pinned', 'is-measuring');
    root.classList.remove('is-compact', 'is-tight');
    const available = stage.clientHeight;
    const compact = window.innerWidth <= 850 || composition.offsetHeight > available - 88;
    root.classList.toggle('is-compact', compact);
    fitPanels();
    root.style.height = `${available * 4}px`;
    root.classList.remove('is-measuring');
    for (const decoder of decoders) {
      decoder.measure();
    }
    fileDecoder.measure();
    installDecoder.measure();
    current = -1;
    readScroll();
    progress = target;
    entryProgress = entryTarget;
    paint({ deltaMs: 0, snap: true });
    if (initialHash && document.fonts.status === 'loaded') {
      const hash = initialHash;
      initialHash = '';
      seek(hash);
    }
    invalidate();
  }

  function paint(frame: Frame) {
    const swapping = fileSwap.advance(frame);
    const installing = installSwap.advance(frame);
    if (
      !dirty &&
      !swapping &&
      !installing &&
      fileSwap.amount() === lastFileAmount &&
      installSwap.amount() === lastInstallAmount &&
      progress === target &&
      entryProgress === entryTarget &&
      frame.snap === lastSnap
    )
      return false;
    dirty = false;
    lastSnap = frame.snap;
    progress = target;
    entryProgress = entryTarget;
    const { index, amount } = decodeStage(progress);
    if (current !== index) {
      current = index;
      for (const [number, panel] of panels.entries()) {
        const active = number === index;
        panel.dataset.active = String(active);
        panel.inert = !active;
        panel.setAttribute('aria-hidden', String(!active));
      }
      for (const [number, chapter] of chapters.entries()) {
        if (number === index) chapter.setAttribute('aria-current', 'step');
        else chapter.removeAttribute('aria-current');
      }
    }
    const panelAmount = (number: number) => (frame.snap || number !== index ? 1 : amount);
    for (const [number, decoder] of decoders.entries()) decoder.paint(panelAmount(number));
    lastFileAmount = fileSwap.amount();
    lastInstallAmount = installSwap.amount();
    fileDecoder.paint(Math.min(panelAmount(1), lastFileAmount));
    installDecoder.paint(Math.min(panelAmount(2), lastInstallAmount));
    return swapping || installing;
  }

  let lastFileAmount = 1;
  let lastInstallAmount = 1;
  const unmountFiles = mountFiles(root, fileSwap.request);
  const unmountInstall = mountInstall(root, installSwap.request);
  const unmountCopy = mountCopy(root);

  return {
    measure,
    readScroll,
    paint,
    getProgress: () => progress,
    getEntryProgress: () => entryProgress,
    destination,
    seek,
    destroy() {
      destroyed = true;
      unmountFiles();
      unmountInstall();
      unmountCopy();
      for (const decoder of decoders) decoder.destroy();
      fileDecoder.destroy();
      installDecoder.destroy();
      root.classList.remove('is-enhanced', 'is-pinned', 'is-measuring', 'is-compact', 'is-tight');
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
