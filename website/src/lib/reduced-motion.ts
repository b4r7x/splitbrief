const QUERY = '(prefers-reduced-motion: reduce)';

let media: MediaQueryList | undefined;

function query(): MediaQueryList {
  media ??= matchMedia(QUERY);
  return media;
}

export function prefersReducedMotion(): boolean {
  return query().matches;
}

export function onReducedMotionChange(callback: (reduced: boolean) => void): () => void {
  const listener = (event: MediaQueryListEvent): void => callback(event.matches);
  query().addEventListener('change', listener);
  return () => query().removeEventListener('change', listener);
}
