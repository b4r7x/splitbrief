import { createFileRoute } from '@tanstack/react-router';
import { OpenGraphSurface } from '../features/landing/metadata-surfaces.js';

export const Route = createFileRoute('/og')({
  head: () => ({
    meta: [{ title: 'SPLITBRIEF open graph composition' }, { name: 'robots', content: 'noindex' }],
  }),
  component: OpenGraphSurface,
});
