import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { type Guide, loadCatalog, repository, sourceLink } from './catalog.js';
import { escapeHtml, renderGuide } from './markdown.js';

const entry = fileURLToPath(new URL('../docs/index.html', import.meta.url));
type Catalog = Awaited<ReturnType<typeof loadCatalog>>;

function renderPage(template: string, page: Guide, catalog: Catalog) {
  const { article, contents } = renderGuide(page, catalog.pages);
  const base = '../'.repeat(page.route.split('/').length - 1);
  const href = (target: Guide) => `${base}${target.route}`;
  const pageLink = (target: Guide) =>
    `<a href="${href(target)}"${target === page ? ' aria-current="page"' : ''}>${escapeHtml(target.title)}</a>`;
  const index = catalog.pages.find((page) => page.source === 'docs/README.md');
  const library =
    (index ? `<div class="docs-overview">${pageLink(index)}</div>` : '') +
    catalog.groups
      .map(
        (group) =>
          `<details class="docs-group" open><summary>${escapeHtml(group.title)}</summary><ul>${group.pages.map((target) => `<li>${pageLink(target)}</li>`).join('')}</ul></details>`,
      )
      .join('');
  const group = catalog.groups.find((group) => group.pages.includes(page));
  const ordered = [...(index ? [index] : []), ...catalog.groups.flatMap((group) => group.pages)];
  const position = ordered.indexOf(page);
  const previous = ordered[position - 1];
  const next = ordered[position + 1];
  const pagination =
    (previous
      ? `<a href="${href(previous)}"><span>← Previous</span>${escapeHtml(previous.title)}</a>`
      : '<span></span>') +
    (next ? `<a href="${href(next)}"><span>Next →</span>${escapeHtml(next.title)}</a>` : '');
  const replacements: Record<string, string> = {
    '{{site-root}}': base,
    '{{title}}': escapeHtml(page.title),
    '{{description}}': escapeHtml(page.description),
    '{{group}}': escapeHtml(group?.title ?? 'All documentation'),
    '{{source}}': escapeHtml(sourceLink(page)),
    '<!-- guide-library -->': library,
    '<!-- guide-contents -->': contents,
    '<!-- guide-article -->': article,
    '<!-- guide-pagination -->': pagination,
  };
  // Vite compiles the one-level docs template; emitted routes can be deeper.
  let html = template.replaceAll('="../assets/', `="${base}assets/`);
  for (const [marker, content] of Object.entries(replacements))
    html = html.replaceAll(marker, () => content);
  return html;
}

export function docsSite(): Plugin {
  let catalog: Promise<Catalog> | undefined;
  const readCatalog = () => (catalog ??= loadCatalog());
  return {
    name: 'repository-documentation',
    async buildStart() {
      for (const page of (await readCatalog()).pages) this.addWatchFile(repository + page.source);
    },
    configureServer(server) {
      server.watcher.add([
        `${repository}docs`,
        ...['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md'].map((file) => repository + file),
      ]);
      const reload = (_event: string, path: string) => {
        if (!path.endsWith('.md') || !path.startsWith(repository)) return;
        catalog = undefined;
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('all', reload);
      server.httpServer?.once('close', () => server.watcher.off('all', reload));
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith('/docs')) return next();
        if (url.pathname !== '/docs' && !url.pathname.startsWith('/docs/')) return next();
        try {
          const current = await readCatalog();
          const route = url.pathname
            .replace(/\/index\.html$/, '/')
            .replace(/\/?$/, '/')
            .slice(1);
          const page = current.pages.find((page) => page.route === route);
          if (!page) {
            response.writeHead(404, { 'Content-Type': 'text/plain' });
            response.end('Documentation page not found.');
            return;
          }
          if (url.pathname !== `/${page.route}`) {
            response.writeHead(302, { Location: `/${page.route}${url.search}` });
            response.end();
            return;
          }
          const template = await server.transformIndexHtml(
            '/docs/index.html',
            await readFile(entry, 'utf8'),
          );
          response.writeHead(200, { 'Content-Type': 'text/html' });
          response.end(renderPage(template, page, current));
        } catch (error) {
          next(error);
        }
      });
    },
    generateBundle: {
      order: 'post',
      async handler(_options, bundle) {
        const entry = bundle['docs/index.html'];
        if (entry?.type !== 'asset' || typeof entry.source !== 'string') {
          this.error('The documentation HTML template was not emitted.');
        }
        const template = entry.source;
        const current = await readCatalog();
        for (const page of current.pages) {
          const source = renderPage(template, page, current);
          const fileName = posix.join(page.route, 'index.html');
          if (fileName === entry.fileName) entry.source = source;
          else this.emitFile({ type: 'asset', fileName, source });
        }
      },
    },
  };
}
