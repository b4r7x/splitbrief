import { createFileRoute } from '@tanstack/react-router';
import { NotFoundSurface } from '../features/landing/metadata-surfaces.js';

export const Route = createFileRoute('/404')({
  head: () => ({
    meta: [{ title: '404 | SPLITBRIEF' }, { name: 'robots', content: 'noindex' }],
  }),
  component: NotFoundSurface,
});
