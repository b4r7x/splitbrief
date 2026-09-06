import { mountCopyButton } from './features/copy-button';
import { mountDiagram } from './features/diagram/mount';

const cta = document.querySelector<HTMLButtonElement>('.cta');
if (cta) mountCopyButton(cta);

const diagram = document.querySelector<HTMLElement>('.diagram');
if (diagram) mountDiagram(diagram);
