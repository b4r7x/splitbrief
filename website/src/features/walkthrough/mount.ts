import type { Frame, Scene } from '../../lib/scene.js';
import { createTimeline, phases } from './timeline.js';
import { advanceTravel } from './travel.js';

function required(root: HTMLElement, selector: string) {
  const node = root.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`Missing walkthrough element: ${selector}`);
  return node;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

export function mountWalkthrough(
  root: HTMLElement,
  invalidate: () => void,
): Scene & { getProgress(): number } {
  const stage = required(root, '[data-scroll-stage]');
  const documentBody = required(root, '.work-document');
  const documentWindow = required(root, '.work-window');
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
  let clickedPhase = -1;
  let lastPhase = -1;
  let pinned = false;
  let dirty = true;
  let lastSnap = false;
  let travel = { offset: 0, velocity: 0 };
  let resetTravel = true;
  const disposers: Array<() => void> = [];

  function measure() {
    dirty = true;
    resetTravel = true;
    pinned = document.documentElement.classList.contains('is-enhanced') && innerHeight >= 650;
    root.dataset.pinned = String(pinned);
    root.style.height = pinned ? `${Math.ceil(stage.offsetHeight * 6.5)}px` : '';
    documentBody.style.setProperty(
      '--view-height',
      pinned ? `${documentWindow.clientHeight}px` : '0px',
    );
    timeline = createTimeline(
      chapters.map((chapter) => ({ top: chapter.offsetTop, height: chapter.offsetHeight })),
      documentWindow.clientHeight,
      documentBody.scrollHeight,
    );
  }

  function readScroll() {
    const bounds = root.getBoundingClientRect();
    const distance = pinned
      ? root.offsetHeight - stage.offsetHeight
      : root.offsetHeight - innerHeight;
    target = distance > 0 ? clamp(-bounds.top / distance) : 0;
  }

  function paint(frame: Frame) {
    const destination = pinned ? (timeline?.offset(target) ?? 0) : 0;
    if (
      !dirty &&
      progress === target &&
      travel.offset === destination &&
      travel.velocity === 0 &&
      frame.snap === lastSnap
    )
      return false;
    dirty = false;
    lastSnap = frame.snap;
    const ease = frame.snap ? 1 : 1 - Math.exp(-frame.deltaMs / 72);
    progress += (target - progress) * ease;
    if (Math.abs(target - progress) < 0.00002) progress = target;
    travel =
      frame.snap || resetTravel || !pinned
        ? { offset: destination, velocity: 0 }
        : advanceTravel(travel, destination, frame.deltaMs);
    resetTravel = false;
    const boundedOffset = Math.min(timeline?.offset(1) ?? 0, Math.max(0, travel.offset));
    if (boundedOffset !== travel.offset) travel = { offset: boundedOffset, velocity: 0 };
    if (pinned && timeline) progress = timeline.progressAtOffset(travel.offset, progress);
    documentBody.style.transform = pinned ? `translateY(${(-travel.offset).toFixed(2)}px)` : '';
    const phaseIndex = timeline?.phaseAt(progress) ?? 0;
    const phase = phases[phaseIndex];
    if (!phase) return false;
    const clicked = phases[clickedPhase];
    if (clicked && (target < clicked.start - 0.001 || target > clicked.end + 0.001))
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
    return progress !== target || travel.offset !== destination || travel.velocity !== 0;
  }

  for (const [index, node] of steps.entries()) {
    const phase = phases[index];
    const chapter = chapters[index];
    if (!phase || !chapter) continue;
    const onClick = () => {
      dirty = true;
      clickedPhase = index;
      if (pinned) {
        const top = root.getBoundingClientRect().top + scrollY;
        scrollTo({
          top: top + phase.start * (root.offsetHeight - stage.offsetHeight),
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
    delete root.dataset.pinned;
    documentBody.style.removeProperty('transform');
    documentBody.style.removeProperty('--view-height');
    buildFill.style.removeProperty('transform');
    for (const { node } of reveals) node.style.removeProperty('clip-path');
  }

  return { measure, readScroll, paint, destroy, getProgress: () => progress };
}
