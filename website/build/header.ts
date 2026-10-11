import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const source = fileURLToPath(new URL('./header.html', import.meta.url));

export function siteHeader(): Plugin {
  return {
    name: 'site-header',
    buildStart() {
      this.addWatchFile(source);
    },
    transformIndexHtml: {
      order: 'pre',
      async handler(html) {
        if (!html.includes('<!-- site-header -->')) return html;
        // The not-found page is served at any depth, so its links start at the site root.
        const [home, navHref, navLabel] = html.includes('class="docs-page"')
          ? ['{{site-root}}', '{{site-root}}', 'home']
          : html.includes('class="not-found-page"')
            ? ['/', '/docs/', 'docs']
            : ['#top', './docs/', 'docs'];
        const header = (await readFile(source, 'utf8'))
          .replace('{{home}}', home)
          .replace('{{nav-href}}', navHref)
          .replace('{{nav-label}}', navLabel);
        return html.replace('<!-- site-header -->', header);
      },
    },
  };
}
