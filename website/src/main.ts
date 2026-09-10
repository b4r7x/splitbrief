import { fieldSpec, mountDots } from './features/aura/dots';
import { sectionKeepClear } from './features/aura/keep-clear';
import { mountReveal } from './features/aura/reveal';
import { mountCopyButton } from './features/copy-button';
import { mountDiagram } from './features/diagram/mount';
import { type KeepClear, mountFragments, type Rect } from './features/fragments/mount';
import type { Layer } from './features/fragments/place';
import { BRIEFS, CONTROL, HERO, VALIDATION } from './features/fragments/pool';
import { onReducedMotionChange, prefersReducedMotion } from './lib/reduced-motion';

const cta = document.querySelector<HTMLButtonElement>('.cta');
if (cta) mountCopyButton(cta);

const layer = document.createElement('div');
layer.className = 'fragments';
layer.setAttribute('aria-hidden', 'true');
document.body.prepend(layer);
const TEXT = [
  '.hero .steps li > *, .draft-mark, .hero .claim, h1, .lede, .cta, .works, .label, .seat, .brief',
  '.lower .grid :is(h2, p, li, pre), .foot p',
].join(', ');
const MARKS =
  '.route, .cross, canvas, .scatter span, .panel, .tree, .marg, .marg-list, .stop, .rail';
const NAV_QUIET = 24;
const RAIN = { top: 0.06, width: 42 };
const nav = document.querySelector('.nav');
const hero = document.querySelector('.hero');
const boxes = (selector: string): DOMRect[] =>
  [...document.querySelectorAll(selector)].map((element) => element.getBoundingClientRect());
const gutters = (width: number): Rect[] => [
  { left: 0, top: 0, right: width, bottom: innerHeight },
  { left: innerWidth - width, top: 0, right: innerWidth, bottom: innerHeight },
];
const blockAround = (selector: string): Rect[] =>
  [...document.querySelectorAll(selector)].map((element) => {
    const rect = element.getBoundingClientRect();
    const line = Number.parseFloat(getComputedStyle(element).lineHeight);
    return {
      left: rect.left - rect.width,
      top: rect.top - line,
      right: rect.right + rect.width,
      bottom: rect.bottom + line,
    };
  });
const rainColumns = (): Rect[] => {
  const rain = document.querySelector<HTMLElement>('.rain');
  if (!rain?.childElementCount) return [];
  const stage = rain.getBoundingClientRect();
  const fit = stage.width / rain.offsetWidth;
  return [...document.querySelectorAll('.tick--planner, .tick--implementer')].map((tick) => {
    const { left, right, top } = tick.getBoundingClientRect();
    const x = (left + right) / 2;
    return {
      left: x - (RAIN.width / 2) * fit,
      top: stage.top + RAIN.top * stage.height,
      right: x + (RAIN.width / 2) * fit,
      bottom: top,
    };
  });
};
function atRest<T>(measure: () => T): T {
  const entering = document.getAnimations().flatMap((animation) => {
    const end = animation.effect?.getComputedTiming().endTime;
    if (typeof end !== 'number' || !Number.isFinite(end)) return [];
    const was = animation.currentTime;
    animation.currentTime = end;
    return [{ animation, was }];
  });
  const result = measure();
  for (const { animation, was } of entering) animation.currentTime = was;
  return result;
}

const keepClear = (): KeepClear =>
  atRest(() => {
    const origin = layer.getBoundingClientRect();
    const rel = (r: Rect): Rect => ({
      left: r.left - origin.left,
      top: r.top - origin.top,
      right: r.right - origin.left,
      bottom: r.bottom - origin.top,
    });
    return {
      text: boxes(TEXT).map(rel),
      panels: [],
      marks: [
        ...(nav
          ? [
              {
                left: 0,
                top: 0,
                right: innerWidth,
                bottom: nav.getBoundingClientRect().bottom + NAV_QUIET,
              },
            ]
          : []),
        ...(hero ? gutters(hero.getBoundingClientRect().left) : []),
        ...blockAround('.label, .seat'),
        ...rainColumns(),
        ...boxes(MARKS),
      ].map(rel),
    };
  });

const diagram = document.querySelector<HTMLElement>('.diagram');
const motion: { start(): void; stop(): void }[] = [
  mountFragments(layer, keepClear, HERO),
  ...(diagram ? [mountDiagram(diagram)] : []),
];
const LAYERS: Record<string, Layer> = { briefs: BRIEFS, validation: VALIDATION, control: CONTROL };
const sections = [...document.querySelectorAll<HTMLElement>('.lower section')];
const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink-4').trim();
for (const section of sections) {
  const aura = section.querySelector<HTMLElement>('.aura');
  const spec = LAYERS[section.id];
  if (aura && spec) motion.push(mountFragments(aura, () => sectionKeepClear(section), spec));
  for (const canvas of section.querySelectorAll<HTMLCanvasElement>('canvas.dots'))
    motion.push(mountDots(canvas, fieldSpec(canvas), ink));
}
mountReveal(sections);

function setMotion(reduced: boolean): void {
  for (const feature of motion) {
    if (reduced) feature.stop();
    else feature.start();
  }
}

setMotion(prefersReducedMotion());
onReducedMotionChange(setMotion);
