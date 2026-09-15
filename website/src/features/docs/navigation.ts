import { createDecoder } from '../../lib/decoder.js';
import type { Frame } from '../../lib/scene.js';
import { createSwap } from '../../lib/swap.js';

type Visit = { kind: 'push' } | { kind: 'pop'; key: number; top: number };

function historyEntry(state: unknown) {
  return state &&
    typeof state === 'object' &&
    'docsEntry' in state &&
    typeof state.docsEntry === 'number' &&
    'docsScroll' in state &&
    typeof state.docsScroll === 'number'
    ? { key: state.docsEntry, top: state.docsScroll }
    : undefined;
}

export function mountDocsNavigation(
  root: HTMLElement,
  invalidate: () => void,
  changed: () => void,
) {
  const abort = new AbortController();
  const docsRoot = new URL(root.dataset.docsRoot ?? './', location.href);
  root.dataset.docsRoot = docsRoot.href;
  const prefix = docsRoot.pathname;
  // Shell links keep their base when the next article has a different route depth.
  for (const link of root.querySelectorAll<HTMLAnchorElement>('.corners a, .docs-library a')) {
    link.setAttribute('href', link.href);
  }
  const restoration = history.scrollRestoration;
  const initialArticle = root.querySelector<HTMLElement>('.docs-article');
  if (!initialArticle) throw new Error('Missing documentation article');
  let article = initialArticle;
  let decoder = makeDecoder();
  let pending: AbortController | undefined;
  let displayedPath = location.pathname;
  const swap = createSwap(invalidate, () => decoder?.measure());
  const positions = new Map<number, number>();
  let currentEntry = historyEntry(history.state)?.key ?? 0;
  let nextEntry = currentEntry + 1;
  history.replaceState({ docsEntry: currentEntry, docsScroll: scrollY }, '');
  history.scrollRestoration = 'manual';

  function changeEntry(url: URL, reason: Visit) {
    if (reason.kind === 'pop') {
      currentEntry = reason.key;
      nextEntry = Math.max(nextEntry, currentEntry + 1);
    } else if (url.href !== location.href) {
      positions.set(currentEntry, scrollY);
      if (historyEntry(history.state)?.key === currentEntry) {
        history.replaceState({ docsEntry: currentEntry, docsScroll: scrollY }, '');
      }
      currentEntry = nextEntry++;
      history.pushState({ docsEntry: currentEntry, docsScroll: 0 }, '', url);
    }
  }

  function makeDecoder() {
    const heading = article.querySelector<HTMLElement>('.docs-heading');
    return heading ? createDecoder(heading, 'h1') : undefined;
  }

  function restoreText() {
    decoder?.paint(1);
    article.style.removeProperty('opacity');
    article.removeAttribute('aria-busy');
    root.removeAttribute('data-navigating');
  }

  function cancel() {
    pending?.abort();
    swap.cancel();
    restoreText();
  }

  function position(url: URL, top: number | undefined) {
    const target = url.hash ? document.getElementById(decodeURIComponent(url.hash.slice(1))) : null;
    if (top !== undefined) scrollTo({ top, behavior: 'instant' });
    else if (target) target.scrollIntoView({ behavior: 'instant', block: 'start' });
    else scrollTo({ top: 0, behavior: 'instant' });
    const focus = target ?? article;
    if (focus) {
      focus.tabIndex = -1;
      focus.focus({ preventScroll: true });
    }
    invalidate();
  }

  async function visit(url: URL, reason: Visit) {
    cancel();
    if (url.pathname === displayedPath) {
      changeEntry(url, reason);
      changed();
      position(url, reason.kind === 'pop' ? reason.top : undefined);
      return;
    }
    const request = new AbortController();
    pending = request;
    article.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(url, { signal: request.signal });
      if (!response.ok) throw new Error(`Documentation returned ${response.status}`);
      const next = new DOMParser().parseFromString(await response.text(), 'text/html');
      const nextArticle = next.querySelector<HTMLElement>('.docs-article');
      const nextContents = next.querySelector<HTMLElement>('.docs-contents');
      const nextSource = next.querySelector<HTMLAnchorElement>('.docs-source');
      if (!nextArticle || !nextContents || !nextSource)
        throw new Error('Incomplete documentation page');
      if (request.signal.aborted) return;
      const install = () => {
        changeEntry(url, reason);
        decoder?.destroy();
        article.replaceWith(nextArticle);
        article = nextArticle;
        root.querySelector('.docs-contents')?.replaceWith(nextContents);
        root
          .querySelector('.docs-source')
          ?.setAttribute('href', nextSource.getAttribute('href') ?? '');
        document.title = next.title;
        document
          .querySelector('meta[name="description"]')
          ?.setAttribute(
            'content',
            next.querySelector('meta[name="description"]')?.getAttribute('content') ?? '',
          );
        displayedPath = url.pathname;
        decoder = makeDecoder();
        changed();
        position(url, reason.kind === 'pop' ? reason.top : undefined);
      };
      if (reason.kind === 'pop' || matchMedia('(prefers-reduced-motion: reduce)').matches) {
        install();
        restoreText();
      } else {
        decoder?.measure();
        root.setAttribute('data-navigating', '');
        swap.request(install);
      }
    } catch {
      if (!request.signal.aborted) location.assign(url.href);
    }
  }

  root.addEventListener(
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
      const link =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self'))
        return;
      const url = new URL(link.href);
      if (
        url.origin !== location.origin ||
        !url.pathname.startsWith(prefix) ||
        !url.pathname.endsWith('/')
      )
        return;
      event.preventDefault();
      void visit(url, { kind: 'push' });
    },
    { signal: abort.signal },
  );
  window.addEventListener(
    'popstate',
    (event) => {
      positions.set(currentEntry, scrollY);
      const target = historyEntry(event.state) ?? { key: nextEntry++, top: 0 };
      void visit(new URL(location.href), {
        kind: 'pop',
        key: target.key,
        top: positions.get(target.key) ?? target.top,
      });
    },
    { signal: abort.signal },
  );

  return {
    measure: () => decoder?.measure(),
    advance: (frame: Frame) => swap.advance(frame),
    paint() {
      const amount = swap.amount();
      if (amount === 1 && root.hasAttribute('data-navigating')) restoreText();
      else if (amount !== 1) {
        decoder?.paint(amount);
        article.style.setProperty('opacity', String(0.15 + amount * 0.85));
      }
      return amount !== 1;
    },
    destroy() {
      cancel();
      abort.abort();
      decoder?.destroy();
      history.scrollRestoration = restoration;
    },
  };
}
