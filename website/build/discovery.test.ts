import type * as fs from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadCatalog } from './catalog.js';
import { discoveryFiles } from './discovery.js';
import { absoluteUrl, documentTitle, pageMetadata, site } from './site.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmUrl = `https://www.npmjs.com/package/splitbrief`;

const decode = (value: string) =>
  value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');

const attribute = (tag: string, name: string) =>
  decode(tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? '');

// Every `<meta>` or `<link>` tag whose key attribute has this value, as decoded content.
function head(html: string, key: 'name' | 'property' | 'rel', value: string) {
  const tag = key === 'rel' ? 'link' : 'meta';
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*\\s${key}="${value}"[^>]*>`, 'g'))].map(
    ([match]) => attribute(match, key === 'rel' ? 'href' : 'content'),
  );
}

// Builds the site with the real Vite config and the given npm state from site.json.
async function buildSite(published: boolean) {
  vi.resetModules();
  vi.doMock('node:fs', async (importOriginal) => {
    const real = await importOriginal<typeof fs>();
    const readFileSync = ((path: fs.PathOrFileDescriptor, options?: unknown) => {
      const text = real.readFileSync(path, options as BufferEncoding);
      if (!String(path).endsWith('/site.json')) return text;
      const json = JSON.parse(String(text));
      return JSON.stringify({ ...json, npm: { ...json.npm, published } });
    }) as typeof real.readFileSync;
    return { ...real, default: { ...real, readFileSync }, readFileSync };
  });
  const [{ build }, { default: config }] = await Promise.all([
    import('vite'),
    import('../vite.config.js'),
  ]);
  const outDir = await mkdtemp(join(tmpdir(), `splitbrief-site-${published}-`));
  await build({
    ...config,
    root,
    configFile: false,
    logLevel: 'silent',
    mode: 'production',
    build: { ...config.build, outDir, emptyOutDir: true },
  });
  vi.doUnmock('node:fs');
  const read = (file: string) => readFile(join(outDir, file), 'utf8');
  return { outDir, read };
}

describe('discovery files', () => {
  it('lists every guide in llms.txt', async () => {
    const catalog = await loadCatalog();
    const files = discoveryFiles(catalog);
    for (const page of catalog.pages.filter((page) => page.source !== 'docs/README.md'))
      expect(files['llms.txt']).toContain(`- [${page.title}](${absoluteUrl(page.route)}): `);
  });

  it('give each route one absolute canonical URL shared by its Open Graph tags', () => {
    const head = pageMetadata({
      route: 'docs/getting-started/',
      title: 'Getting started · SPLITBRIEF',
      description: 'A <short> description.',
      type: 'article',
    });
    const url = `${site.origin}/docs/getting-started/`;
    expect(head).toContain(`<link rel="canonical" href="${url}">`);
    expect(head).toContain(`<meta property="og:url" content="${url}">`);
    expect(head).toContain(`<meta property="og:image" content="${site.origin}/social.png">`);
    expect(head).toContain('content="A &lt;short&gt; description."');
  });
});

describe.each([false, true])('the built site with npm.published %s', (published) => {
  let built: Awaited<ReturnType<typeof buildSite>>;
  beforeAll(async () => {
    built = await buildSite(published);
  }, 120_000);
  afterAll(async () => {
    if (built) await rm(built.outDir, { recursive: true, force: true });
  });

  it('emits the complete sitemap and robots file', async () => {
    const catalog = await loadCatalog();
    const sitemap = await built.read('sitemap.xml');
    const robots = await built.read('robots.txt');
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) =>
      decode(match[1] ?? ''),
    );
    expect(locations).toEqual([
      `${site.origin}/`,
      ...catalog.pages.map((page) => `${site.origin}/${page.route}`),
    ]);
    expect(robots).toBe(`User-agent: *\nAllow: /\n\nSitemap: ${site.origin}/sitemap.xml\n`);
  });

  it('gives every route its own canonical, Open Graph and Twitter identity', async () => {
    const catalog = await loadCatalog();
    const routes = [
      { route: '', title: undefined, description: undefined, type: 'website' },
      ...catalog.pages.map((page) => ({
        route: page.route,
        title: documentTitle(page.title),
        description: page.description,
        type: page.source === 'docs/README.md' ? 'website' : 'article',
      })),
    ];
    for (const { route, title, description, type } of routes) {
      const html = await built.read(`${route}index.html`);
      const url = `${site.origin}/${route}`;
      const documentName = decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '');
      const summary = head(html, 'name', 'description');
      expect(summary, route).toHaveLength(1);
      if (title) expect(documentName, route).toBe(title);
      if (description) expect(summary[0], route).toBe(description);
      const single = (key: 'name' | 'property' | 'rel', value: string) => {
        const found = head(html, key, value);
        expect(found, `${route} ${value}`).toHaveLength(1);
        return found[0];
      };
      expect(single('rel', 'canonical'), route).toBe(url);
      expect(single('property', 'og:url'), route).toBe(url);
      expect(single('property', 'og:type'), route).toBe(type);
      expect(single('property', 'og:site_name'), route).toBe('SPLITBRIEF');
      expect(single('property', 'og:title'), route).toBe(documentName);
      expect(single('property', 'og:description'), route).toBe(summary[0]);
      expect(single('property', 'og:image'), route).toBe(`${site.origin}/social.png`);
      expect(single('name', 'twitter:card'), route).toBe('summary_large_image');
      expect(single('name', 'twitter:title'), route).toBe(documentName);
      expect(single('name', 'twitter:description'), route).toBe(summary[0]);
      expect(single('name', 'twitter:image'), route).toBe(`${site.origin}/social.png`);
      const icon = single('rel', 'icon');
      expect(new URL(icon ?? '', url).href, route).toBe(`${site.origin}/favicon.svg`);
    }
  });

  it('describes the landing as one SoftwareApplication with the npm link only when published', async () => {
    const html = await built.read('index.html');
    const blocks = [
      ...html.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g),
    ].map((match) => JSON.parse(match[1] ?? ''));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'SPLITBRIEF',
      url: `${site.origin}/`,
      description: head(html, 'name', 'description')[0],
      sameAs: [site.repository],
      license: `${site.repository}/blob/main/LICENSE`,
    });
    expect(blocks[0].downloadUrl).toBe(published ? npmUrl : undefined);
  });

  it('offers the npm command only when the package is published', async () => {
    const html = await built.read('index.html');
    const llms = await built.read('llms.txt');
    const panel = html.slice(html.indexOf('id="install-npm"'), html.indexOf('id="install-source"'));
    expect(html).not.toContain('<!-- npm:');
    expect(html).not.toMatch(/\{\{[\w-]+\}\}/);
    if (published) {
      expect(panel).toContain('id="install-command"');
      expect(panel).toContain('data-copy="install"');
      expect(panel).toContain('<code>npm install -g splitbrief</code>');
      expect(panel).toContain(`<a href="${npmUrl}">`);
      expect(panel).not.toContain('first npm release');
      expect(llms).toContain('npm install -g splitbrief');
      expect(llms).toContain(npmUrl);
    } else {
      expect(panel).not.toContain('id="install-command"');
      expect(panel).not.toContain('data-copy="install"');
      expect(panel).not.toContain('npm install -g');
      expect(panel).toContain('The first npm release is coming.');
      expect(panel).toContain(`<a href="${site.repository}">`);
      expect(html).not.toContain(npmUrl);
      expect(llms).not.toContain(npmUrl);
      expect(llms).toContain('The npm package is not published yet');
    }
  });

  it('serves the not-found page with the site header and assets from any depth', async () => {
    const html = await built.read('404.html');
    expect(html).toContain('<title>Page not found · SPLITBRIEF</title>');
    expect(head(html, 'name', 'robots')).toEqual(['noindex']);
    expect(html).toContain('class="not-found-page"');
    expect(html).toContain('class="logo-figlet"');
    const deep = `${site.origin}/docs/missing/page/`;
    const references = [...html.matchAll(/\s(?:href|src)="([^"#][^"]*)"/g)].map(
      (match) => new URL(decode(match[1] ?? ''), deep),
    );
    const local = references.filter((url) => url.origin === site.origin);
    expect(local.map((url) => url.pathname)).toEqual(
      expect.arrayContaining(['/', '/docs/', '/favicon.svg']),
    );
    const assets = local.filter((url) => url.pathname.startsWith('/assets/'));
    expect(assets.length).toBeGreaterThan(0);
    for (const url of [...assets, ...local.filter((url) => url.pathname === '/favicon.svg')])
      expect(existsSync(join(built.outDir, url.pathname)), url.pathname).toBe(true);
    for (const asset of assets.filter((url) => url.pathname.endsWith('.css'))) {
      const css = await readFile(join(built.outDir, asset.pathname), 'utf8');
      const fonts = [...css.matchAll(/url\(([^)]+)\)/g)].map(
        (match) => new URL(match[1] ?? '', asset).pathname,
      );
      expect(fonts.length, asset.pathname).toBeGreaterThan(0);
      for (const font of fonts) expect(existsSync(join(built.outDir, font)), font).toBe(true);
    }
  });
});
