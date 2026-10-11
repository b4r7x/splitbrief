import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { escapeHtml } from './escape.js';

function readSite() {
  const { origin, repository, npm } = JSON.parse(
    readFileSync(new URL('../site.json', import.meta.url), 'utf8'),
  );
  if (
    typeof origin !== 'string' ||
    new URL(origin).origin !== origin ||
    typeof repository !== 'string' ||
    typeof npm?.package !== 'string' ||
    typeof npm?.published !== 'boolean'
  )
    throw new Error(
      'website/site.json needs an origin without a path, a repository URL and npm.package/npm.published.',
    );
  const { package: name, published }: { package: string; published: boolean } = npm;
  return {
    origin,
    repository,
    npm: { published, url: `https://www.npmjs.com/package/${name}` },
  };
}

/** Production identity from `website/site.json`, the one place the origin and npm status live. */
export const site = readSite();

type PageMetadata = {
  route: string;
  title: string;
  description: string;
  type: 'website' | 'article';
};

const landing: PageMetadata = {
  route: '',
  title: 'SPLITBRIEF — two tools, one clear handoff',
  description:
    'SPLITBRIEF connects a stronger planning tool with a smaller coding tool through self-contained Task Briefs, validation and review.',
  type: 'website',
};

export const absoluteUrl = (route: string) => new URL(route, `${site.origin}/`).href;

const socialImage = {
  url: absoluteUrl('social.png'),
  width: '1200',
  height: '630',
  alt: 'The SPLITBRIEF wordmark above the line: Two tools. One clear handoff.',
};

/** Title, description, canonical URL, Open Graph and Twitter tags for one route. */
export function pageMetadata({ route, title, description, type }: PageMetadata) {
  const url = absoluteUrl(route);
  const tags: Array<[string, string, string]> = [
    ['property', 'og:type', type],
    ['property', 'og:site_name', 'SPLITBRIEF'],
    ['property', 'og:title', title],
    ['property', 'og:description', description],
    ['property', 'og:url', url],
    ['property', 'og:image', socialImage.url],
    ['property', 'og:image:width', socialImage.width],
    ['property', 'og:image:height', socialImage.height],
    ['property', 'og:image:alt', socialImage.alt],
    ['name', 'twitter:card', 'summary_large_image'],
    ['name', 'twitter:title', title],
    ['name', 'twitter:description', description],
    ['name', 'twitter:image', socialImage.url],
    ['name', 'twitter:image:alt', socialImage.alt],
  ];
  return [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    ...tags.map(
      ([key, name, content]) => `<meta ${key}="${name}" content="${escapeHtml(content)}">`,
    ),
  ].join('\n  ');
}

function softwareApplication() {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'SPLITBRIEF',
    description: landing.description,
    url: absoluteUrl(''),
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Linux, Windows through WSL',
    softwareRequirements: 'Node.js 22 or later',
    license: `${site.repository}/blob/main/LICENSE`,
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    sameAs: [site.repository],
    ...(site.npm.published ? { downloadUrl: site.npm.url } : {}),
  };
  return `<script type="application/ld+json">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script>`;
}

// The landing keeps the install copy for both npm states; the build keeps the current one.
const npmState = /[ \t]*<!-- npm:(published|unpublished) -->\n([\s\S]*?)[ \t]*<!-- \/npm:\1 -->\n/g;

/**
 * Landing metadata and the install copy for the npm state. The server returns `404.html` at
 * any depth, so the not-found page names its build assets from the site root.
 */
export function siteMetadata(): Plugin {
  return {
    name: 'site-metadata',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (html.includes('class="docs-page"')) return html;
        return html
          .replace(
            '<!-- page-metadata -->',
            () => `${pageMetadata(landing)}\n  ${softwareApplication()}`,
          )
          .replace(npmState, (_block, state: string, content: string) =>
            (state === 'published') === site.npm.published ? content : '',
          )
          .replaceAll('{{npm-url}}', () => escapeHtml(site.npm.url))
          .replaceAll('{{repository}}', () => escapeHtml(site.repository));
      },
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const page = bundle['404.html'];
        if (page?.type !== 'asset' || typeof page.source !== 'string')
          this.error('The not-found page was not emitted.');
        page.source = page.source.replaceAll('="./', '="/');
      },
    },
  };
}

export const documentTitle = (title: string) => `${title} · SPLITBRIEF`;
