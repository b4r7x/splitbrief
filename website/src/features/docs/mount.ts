import { mountCopy } from '../../lib/copy.js';
import type { Scene } from '../../lib/scene.js';
import { mountLibrary } from './library.js';
import { mountDocsNavigation } from './navigation.js';

export function mountDocs(
  root: HTMLElement,
  invalidate: () => void,
): Scene & { progress(): number } {
  let unmountCopy = mountCopy(root);
  const library = mountLibrary(root);
  let headings = [...root.querySelectorAll<HTMLElement>('.docs-article h2')];
  let links = [...root.querySelectorAll<HTMLAnchorElement>('.docs-contents nav a')];
  const narrow = matchMedia('(max-width: 900px)');
  const compact = matchMedia('(max-width: 1200px)');
  const abort = new AbortController();
  let active = '';
  let progress = 0;
  const navigation = mountDocsNavigation(root, invalidate, () => {
    unmountCopy();
    unmountCopy = mountCopy(root);
    headings = [...root.querySelectorAll<HTMLElement>('.docs-article h2')];
    links = [...root.querySelectorAll<HTMLAnchorElement>('.docs-contents nav a')];
    active = '';
    library.update();
    onLayout();
  });

  function readScroll() {
    progress = Math.min(
      1,
      Math.max(0, scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight)),
    );
    let current = headings[0]?.id ?? '';
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top <= 120) current = heading.id;
    }
    if (active === current) return;
    active = current;
    for (const link of links) {
      if (link.hash === `#${current}`) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }
  const onLayout = () => {
    const menu = root.querySelector<HTMLDetailsElement>('.docs-menu');
    const contents = root.querySelector<HTMLDetailsElement>('.docs-contents details');
    if (menu) menu.open = !narrow.matches;
    if (contents) contents.open = !compact.matches;
    invalidate();
  };
  narrow.addEventListener('change', onLayout, { signal: abort.signal });
  compact.addEventListener('change', onLayout, { signal: abort.signal });
  root.addEventListener('toggle', invalidate, { capture: true, signal: abort.signal });
  root.classList.add('docs-enhanced');
  onLayout();

  return {
    measure: navigation.measure,
    advance: navigation.advance,
    readScroll,
    paint: navigation.paint,
    progress: () => progress,
    destroy() {
      navigation.destroy();
      abort.abort();
      library.destroy();
      unmountCopy();
      root.classList.remove('docs-enhanced');
      for (const details of root.querySelectorAll('details')) details.open = true;
      for (const link of links) link.removeAttribute('aria-current');
    },
  };
}
