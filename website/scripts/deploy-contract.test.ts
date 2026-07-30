// @vitest-environment node

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WEBSITE_ROOT } from './site.js';

describe('static deployment contract', () => {
  it('pins official multi-platform image digests and copies only the client artifact', async () => {
    const dockerfile = await readFile(resolve(WEBSITE_ROOT, 'deploy/Dockerfile'), 'utf8');
    const packageJson = await readFile(resolve(WEBSITE_ROOT, 'package.json'), 'utf8');

    expect(dockerfile).toContain(
      'node:22.23.1-alpine3.24@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2',
    );
    expect(dockerfile).toContain(
      'nginx:1.29.8-alpine3.23@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de',
    );
    expect(dockerfile).toContain('RUN npm run build:container');
    expect(dockerfile).not.toContain('RUN npm run build\n');
    expect(packageJson).toContain(
      '"build:container": "npm run invalidate:built && npm run check:content && npm run check:links && npm run check:licenses && npm run generate:metadata && npm run check:og && vite build && npm run generate:csp && npm run check:artifacts && npm run record:built"',
    );
    expect(packageJson).not.toMatch(/"build:container"[^\n]*generate:og/);
    expect(dockerfile).toContain('COPY --from=build /app/dist/client /usr/share/nginx/html');
    expect(dockerfile).not.toContain('.output/public');
  });

  it('fails the image build when required static surfaces are missing or empty', async () => {
    const dockerfile = await readFile(resolve(WEBSITE_ROOT, 'deploy/Dockerfile'), 'utf8');

    for (const path of [
      'dist/client/index.html',
      'dist/client/404.html',
      'dist/client/api/search',
      'dist/client/og.png',
      'dist/client/llms.txt',
      'dist/client/sitemap.xml',
      'dist/client/robots.txt',
      'dist/client/THIRD_PARTY_NOTICES.txt',
      'dist/client/docs/getting-started/introduction.md',
      'dist/nginx-csp.conf',
    ]) {
      expect(dockerfile).toContain(`test -s ${path}`);
    }
  });

  it('keeps security and cache headers at server scope', async () => {
    const nginx = await readFile(resolve(WEBSITE_ROOT, 'deploy/nginx.conf'), 'utf8');
    const firstLocation = nginx.indexOf('  location ');
    const headerDirectives = [...nginx.matchAll(/ {2}add_header /g)].map(
      (match) => match.index ?? Number.POSITIVE_INFINITY,
    );

    expect(headerDirectives.length).toBeGreaterThanOrEqual(7);
    expect(headerDirectives.every((index) => index < firstLocation)).toBe(true);
    expect(nginx).toContain('gzip_static on;');
    expect(nginx).toContain('return 301 /docs/getting-started/introduction;');
    expect(nginx).toContain('default_type application/json;');
    expect(nginx).toContain('default_type text/markdown;');
    expect(nginx).toContain('error_page 404 =404 /404.html;');
    expect(nginx).not.toMatch(/Strict-Transport-Security/i);
  });

  it('serves content-fingerprinted fonts with an immutable cache policy', async () => {
    const fontDirectory = resolve(WEBSITE_ROOT, 'public/fonts');
    const [fontFiles, fontsCss, nginx, rootRoute] = await Promise.all([
      readdir(fontDirectory),
      readFile(resolve(WEBSITE_ROOT, 'src/styles/fonts.css'), 'utf8'),
      readFile(resolve(WEBSITE_ROOT, 'deploy/nginx.conf'), 'utf8'),
      readFile(resolve(WEBSITE_ROOT, 'src/routes/__root.tsx'), 'utf8'),
    ]);
    const woffFiles = fontFiles.filter((file) => file.endsWith('.woff2')).sort();
    const cssFontFiles = [...fontsCss.matchAll(/url\("\/fonts\/([^"]+\.woff2)"\)/g)]
      .map((match) => match[1] ?? '')
      .sort();

    expect(cssFontFiles).toEqual(woffFiles);
    for (const file of woffFiles) {
      const fingerprint = file.match(/-([a-f0-9]{12})\.woff2$/)?.[1];
      expect(fingerprint, `${file} must end with a 12-character content fingerprint`).toBeDefined();
      const digest = createHash('sha256')
        .update(await readFile(resolve(fontDirectory, file)))
        .digest('hex');
      expect(fingerprint).toBe(digest.slice(0, 12));
    }

    for (const preload of rootRoute.matchAll(/href: '\/fonts\/([^']+\.woff2)'/g)) {
      expect(woffFiles).toContain(preload[1]);
    }
    expect(nginx).toContain(
      '"~^/fonts/[^/]+-[a-f0-9]{12}\\.woff2$" "public, max-age=31536000, immutable";',
    );
  });
});
