/// <reference types="vitest/config" />

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import mdx from 'fumadocs-mdx/vite';
import { defineConfig } from 'vite';
import { prerenderPages } from './scripts/pages.js';
import { OUTPUT_DIR, requireSiteUrl } from './scripts/site.js';
import { stripStaticNotFoundScripts } from './scripts/static-not-found.js';

const isVitest = Boolean(process.env.VITEST);
const staticNotFoundPath = fileURLToPath(new URL(`${OUTPUT_DIR}/404.html`, import.meta.url));

export default defineConfig(({ command }) => {
  const siteOrigin = command === 'build' && !isVitest ? requireSiteUrl() : '';

  return {
    define: {
      __SPLITBRIEF_SITE_ORIGIN__: JSON.stringify(siteOrigin),
    },
    plugins: [
      mdx(),
      tailwindcss(),
      isVitest
        ? null
        : tanstackStart({
            router: {
              routeFileIgnorePattern: '\\.test\\.tsx$',
              addExtensions: 'js',
            },
            prerender: {
              enabled: true,
              autoStaticPathsDiscovery: false,
              autoSubfolderIndex: true,
              crawlLinks: false,
              failOnError: true,
              onSuccess: async ({ page, html }) => {
                if (page.path === '/404') {
                  await writeFile(staticNotFoundPath, stripStaticNotFoundScripts(html));
                }
              },
            },
            pages: prerenderPages(),
            sitemap: { enabled: false },
          }),
      viteReact(),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        collections: fileURLToPath(new URL('./.source', import.meta.url)),
      },
    },
    build: {
      outDir: 'dist',
    },
    ...(isVitest
      ? {
          test: {
            environment: 'jsdom',
            setupFiles: ['./src/test-setup.ts'],
          },
        }
      : {}),
  };
});
