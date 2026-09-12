import { mountReveal } from './features/aura/reveal';
import { mountCopyButton } from './features/copy-button';
import { mountDiagram } from './features/diagram/mount';
import { mountBackdrop } from './features/fragments/mount';
import { onReducedMotionChange, prefersReducedMotion } from './lib/reduced-motion';

const cta = document.querySelector<HTMLButtonElement>('.cta');
if (cta) mountCopyButton(cta);

const backdrop = document.createElement('div');
backdrop.className = 'backdrop';
backdrop.setAttribute('aria-hidden', 'true');
document.body.prepend(backdrop);

const diagram = document.querySelector<HTMLElement>('.diagram');
const motion: { start(): void; stop(): void }[] = [
  mountBackdrop(backdrop),
  ...(diagram ? [mountDiagram(diagram)] : []),
];
mountReveal([...document.querySelectorAll('.lower section')]);

function setMotion(reduced: boolean): void {
  for (const feature of motion) {
    if (reduced) feature.stop();
    else feature.start();
  }
}

setMotion(prefersReducedMotion());
onReducedMotionChange(setMotion);
