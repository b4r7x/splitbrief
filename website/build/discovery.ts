import type { loadCatalog } from './catalog.js';
import { escapeHtml } from './escape.js';
import { absoluteUrl, site } from './site.js';

type Catalog = Awaited<ReturnType<typeof loadCatalog>>;

function sitemap(catalog: Catalog) {
  const urls = ['', ...catalog.pages.map((page) => page.route)]
    .map((route) => `  <url><loc>${escapeHtml(absoluteUrl(route))}</loc></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

const robots = () => `User-agent: *\nAllow: /\n\nSitemap: ${absoluteUrl('sitemap.xml')}\n`;

// The llms.txt convention: a title, a summary quote, then link lists by section.
function llms(catalog: Catalog) {
  const install = site.npm.published
    ? `Install it with \`npm install -g splitbrief\`. npm package: ${site.npm.url}.`
    : 'The npm package is not published yet; build it from source as the Getting started guide describes.';
  const sections = catalog.groups.map(
    (group) =>
      `## ${group.title}\n\n${group.pages
        .map((page) => `- [${page.title}](${absoluteUrl(page.route)}): ${page.description}`)
        .join('\n')}`,
  );
  return [
    '# SPLITBRIEF',
    '> SPLITBRIEF is an open-source command-line tool. A stronger AI coding tool plans, writes self-contained Task Briefs and reviews; a smaller one implements each brief. SPLITBRIEF validates the work, retries, escalates and keeps the evidence in the repository.',
    `Source code: ${site.repository}. ${install} Documentation index: ${absoluteUrl('docs/')}.`,
    ...sections,
  ].join('\n\n');
}

/** Files for crawlers and language models, derived from the documentation catalog. */
export const discoveryFiles = (catalog: Catalog) => ({
  'sitemap.xml': sitemap(catalog),
  'robots.txt': robots(),
  'llms.txt': `${llms(catalog)}\n`,
});
