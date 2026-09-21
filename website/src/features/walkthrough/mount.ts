import type { Frame, Scene } from '../../lib/scene.js';
import { createScrub } from './scrub.js';
import { createTimeline, phases } from './timeline.js';

function required(root: HTMLElement, selector: string) {
  const node = root.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`Missing walkthrough element: ${selector}`);
  return node;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

export function mountWalkthrough(
  root: HTMLElement,
  invalidate: () => void,
): Scene & { getArtProgress(): number } {
  const stage = required(root, '[data-scroll-stage]');
  const documentBody = required(root, '.work-document');
  const documentWindow = required(root, '.work-window');
  const terminal = required(root, '.terminal');
  const caption = required(root, '#phase-caption');
  const buildFill = required(root, '.build-progress span');
  const chapters = phases.map((phase) => required(root, `#${phase.id}`));
  const steps = [...root.querySelectorAll<HTMLButtonElement>('.timeline-step')];
  const reveals = [...root.querySelectorAll<HTMLElement>('[data-reveal]')].map((node) => {
    const [begin, end] = (node.dataset.reveal ?? '').split(',').map(Number);
    if (begin === undefined || end === undefined || !Number.isFinite(begin + end) || end <= begin) {
      throw new Error('Invalid walkthrough reveal range');
    }
    return { node, begin, end };
  });
  let timeline: ReturnType<typeof createTimeline> | undefined;
  let target = 0;
  let progress = 0;
  let displayedOffset = 0;
  const scrub = createScrub();
  let resetScrub = true;
  let clickedPhase = -1;
  let lastPhase = -1;
  let pinned = false;
  let dirty = true;
  let lastSnap = false;
  let scrollStart = 0;
  let scrollDistance = 0;
  const disposers: Array<() => void> = [];

  function measure() {
    dirty = true;
    resetScrub = true;
    const compact = matchMedia('(max-width: 850px), (max-height: 700px)').matches;
    pinned = document.documentElement.classList.contains('is-enhanced');
    root.dataset.compact = String(compact);
    root.dataset.pinned = String(pinned);
    root.dataset.density = 'roomy';
    documentBody.style.setProperty('--view-height', '0px');
    const fits = () =>
      chapters.every((chapter) => chapter.offsetHeight <= documentWindow.clientHeight);
    if (pinned && compact) {
      for (const density of ['compact', 'tight']) {
        if (fits()) break;
        root.dataset.density = density;
      }
    }
    if (pinned && (documentWindow.clientHeight < 96 || (compact && !fits()))) {
      pinned = false;
      root.dataset.pinned = 'false';
    }
    const lead =
      pinned && compact
        ? Math.max(0, terminal.getBoundingClientRect().top - stage.getBoundingClientRect().top - 12)
        : 0;
    root.style.setProperty('--intro-height', `${lead}px`);
    documentBody.style.setProperty(
      '--view-height',
      pinned ? `${documentWindow.clientHeight}px` : '0px',
    );
    const stageHeight = stage.getBoundingClientRect().height;
    const frameHeight = stageHeight - lead;
    scrollDistance = pinned ? frameHeight * 5.5 : 0;
    root.style.height = pinned ? `${Math.ceil(stageHeight + scrollDistance)}px` : '';
    if (pinned) scrollDistance = root.getBoundingClientRect().height - stageHeight;
    scrollStart = root.getBoundingClientRect().top + scrollY + (pinned ? lead : 0);
    timeline = createTimeline(
      chapters.map((chapter) => ({ top: chapter.offsetTop, height: chapter.offsetHeight })),
      documentWindow.clientHeight,
      documentBody.scrollHeight,
    );
  }

  function readScroll() {
    const bounds = root.getBoundingClientRect();
    const distance = pinned ? scrollDistance : root.offsetHeight - innerHeight;
    target = distance > 0 ? clamp((pinned ? scrollY - scrollStart : -bounds.top) / distance) : 0;
  }

  function paint(frame: Frame) {
    const now = performance.now();
    const destination = pinned ? (timeline?.offset(target) ?? 0) : 0;
    scrub.set(
      destination,
      now,
      frame.snap || resetScrub || !pinned || target === 0 || target === 1,
    );
    resetScrub = false;
    const offset = scrub.read(now);
    const next = pinned ? (timeline?.progressAtOffset(offset, target) ?? target) : target;
    const settling = offset !== destination;
    if (!dirty && progress === next && displayedOffset === offset && frame.snap === lastSnap)
      return settling;
    dirty = false;
    lastSnap = frame.snap;
    progress = next;
    displayedOffset = offset;
    documentBody.style.transform = pinned ? `translateY(${(-offset).toFixed(2)}px)` : '';
    const phaseIndex = timeline?.phaseAt(progress) ?? 0;
    const phase = phases[phaseIndex];
    if (!phase) return false;
    const clicked = phases[clickedPhase];
    if (clicked && (progress < clicked.start - 0.001 || progress > clicked.end + 0.001))
      clickedPhase = -1;
    const revealedValue = clickedPhase === phaseIndex ? Math.max(progress, phase.end) : progress;
    for (const { node, begin, end } of reveals) {
      const amount = !pinned
        ? 1
        : frame.snap
          ? Number(revealedValue >= begin)
          : clamp((revealedValue - begin) / (end - begin));
      node.style.clipPath = amount === 1 ? '' : `inset(0 ${(100 - amount * 100).toFixed(2)}% 0 0)`;
    }
    buildFill.style.transform = `scaleX(${pinned ? clamp((revealedValue - 0.37) / 0.09) : 1})`;
    if (phaseIndex !== lastPhase) {
      lastPhase = phaseIndex;
      caption.textContent = phase.caption;
      for (const [index, node] of steps.entries()) {
        node.dataset.state =
          index < phaseIndex ? 'done' : index === phaseIndex ? 'current' : 'waiting';
        if (index === phaseIndex) node.setAttribute('aria-current', 'step');
        else node.removeAttribute('aria-current');
      }
    }
    return settling;
  }

  for (const [index, node] of steps.entries()) {
    const phase = phases[index];
    const chapter = chapters[index];
    if (!phase || !chapter) continue;
    const onClick = () => {
      dirty = true;
      resetScrub = true;
      clickedPhase = index;
      if (pinned) {
        scrollTo({
          top: Math.ceil(scrollStart + phase.start * scrollDistance),
          behavior: 'instant',
        });
        target = phase.start;
      } else chapter.scrollIntoView({ behavior: 'instant', block: 'start' });
      invalidate();
    };
    node.addEventListener('click', onClick);
    disposers.push(() => node.removeEventListener('click', onClick));
  }

  function destroy() {
    for (const dispose of disposers) dispose();
    root.style.removeProperty('height');
    root.style.removeProperty('--intro-height');
    delete root.dataset.pinned;
    delete root.dataset.compact;
    delete root.dataset.density;
    documentBody.style.removeProperty('transform');
    documentBody.style.removeProperty('--view-height');
    buildFill.style.removeProperty('transform');
    for (const { node } of reveals) node.style.removeProperty('clip-path');
  }

  return {
    measure,
    readScroll,
    paint,
    destroy,
    getArtProgress: () => target,
  };
}
