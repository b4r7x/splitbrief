import { useSyncExternalStore } from 'react';

export const MATRIX_DESKTOP_QUERY = '(min-width: 700px)';
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export type MatrixLayout = 'desktop' | 'mobile';
export type MatrixLayoutSnapshot = MatrixLayout | 'prerender';

function subscribeToMedia(query: string, onChange: () => void): () => void {
  const media = window.matchMedia(query);
  media.addEventListener('change', onChange);

  return () => media.removeEventListener('change', onChange);
}

function subscribeToLayout(onChange: () => void): () => void {
  return subscribeToMedia(MATRIX_DESKTOP_QUERY, onChange);
}

function getLayoutSnapshot(): MatrixLayout {
  return window.matchMedia(MATRIX_DESKTOP_QUERY).matches ? 'desktop' : 'mobile';
}

function getPrerenderLayoutSnapshot(): MatrixLayoutSnapshot {
  return 'prerender';
}

function subscribeToReducedMotion(onChange: () => void): () => void {
  return subscribeToMedia(REDUCED_MOTION_QUERY, onChange);
}

function getReducedMotionSnapshot(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function getPrerenderReducedMotionSnapshot(): boolean {
  return false;
}

export function useMatrixLayout(): MatrixLayoutSnapshot {
  return useSyncExternalStore(subscribeToLayout, getLayoutSnapshot, getPrerenderLayoutSnapshot);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionSnapshot,
    getPrerenderReducedMotionSnapshot,
  );
}
