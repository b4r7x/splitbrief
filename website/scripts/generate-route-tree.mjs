import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Generator, getConfig } from '@tanstack/router-generator';

const WEBSITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = getConfig(
  {
    routeFileIgnorePattern: '\\.test\\.tsx$',
    addExtensions: 'js',
    routeTreeFileFooter: [
      `import type { getRouter } from './router.tsx'
import type { createStart } from '@tanstack/react-start'
declare module '@tanstack/react-start' {
  interface Register {
    ssr: true
    router: Awaited<ReturnType<typeof getRouter>>
  }
}`,
    ],
  },
  WEBSITE_ROOT,
);
const generator = new Generator({ config, root: WEBSITE_ROOT });
await generator.run();
console.log('[generate-route-tree] Generated src/routeTree.gen.ts');
