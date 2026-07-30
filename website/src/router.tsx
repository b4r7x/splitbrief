import { createRouter } from '@tanstack/react-router';
import { NotFoundSurface } from './features/landing/metadata-surfaces.js';
import { routeTree } from './routeTree.gen.js';

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultNotFoundComponent: NotFoundSurface,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
