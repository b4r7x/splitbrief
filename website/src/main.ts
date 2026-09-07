import { mountCopyButton } from './features/copy-button';
import { mountDiagram } from './features/diagram/mount';
import { mountFragments } from './features/fragments/mount';
import { onReducedMotionChange, prefersReducedMotion } from './lib/reduced-motion';

const cta = document.querySelector<HTMLButtonElement>('.cta');
if (cta) mountCopyButton(cta);

const layer = document.createElement('div');
layer.className = 'fragments';
layer.setAttribute('aria-hidden', 'true');
document.body.prepend(layer);
const TYPE_AND_GHOSTS =
  '.wordmark, .tagline, .links, .mark, .steps span, .draft-mark, .claim, h1, .lede, .cta, .works, .label, .seat, .brief, .route, .cross, canvas';
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

const keepClear = (): DOMRect[] =>
  atRest(() =>
    [...document.querySelectorAll(TYPE_AND_GHOSTS)].map((element) =>
      element.getBoundingClientRect(),
    ),
  );

const diagram = document.querySelector<HTMLElement>('.diagram');
const motion = [mountFragments(layer, keepClear), ...(diagram ? [mountDiagram(diagram)] : [])];

function setMotion(reduced: boolean): void {
  for (const feature of motion) {
    if (reduced) feature.stop();
    else feature.start();
  }
}

setMotion(prefersReducedMotion());
onReducedMotionChange(setMotion);
