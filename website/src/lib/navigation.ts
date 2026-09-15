import type { Scene } from './scene.js';

type Destination = { element: HTMLElement };

export function mountNavigation({
  resolve,
  seek,
  invalidate,
}: {
  resolve(hash: string): Destination | undefined;
  seek(hash: string): void;
  invalidate(): void;
}): Scene {
  const abort = new AbortController();

  function finish(destination: Destination, focus: boolean) {
    seek(`#${destination.element.id}`);
    if (focus) {
      destination.element.tabIndex = -1;
      destination.element.focus({ preventScroll: true });
    }
    invalidate();
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
      if (
        !anchor ||
        anchor.hasAttribute('download') ||
        (anchor.target && anchor.target !== '_self')
      )
        return;
      const url = new URL(anchor.href);
      if (
        url.origin !== location.origin ||
        url.pathname !== location.pathname ||
        url.search !== location.search
      )
        return;
      const destination = resolve(url.hash);
      if (!destination) return;
      event.preventDefault();
      if (location.hash !== url.hash) history.pushState(null, '', url.hash);
      finish(destination, !anchor.hasAttribute('data-chapter'));
    },
    { signal: abort.signal },
  );

  window.addEventListener(
    'hashchange',
    () => {
      const destination = resolve(location.hash);
      if (destination) finish(destination, false);
    },
    { signal: abort.signal },
  );
  return {
    measure() {},
    readScroll() {},
    paint: () => false,
    destroy() {
      abort.abort();
    },
  };
}
