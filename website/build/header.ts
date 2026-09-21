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
        const docs = html.includes('class="docs-page"');
        const header = (await readFile(source, 'utf8'))
          .replace('{{home}}', docs ? '{{site-root}}' : '#top')
          .replace('{{nav-href}}', docs ? '{{site-root}}' : './docs/')
          .replace('{{nav-label}}', docs ? 'home' : 'docs');
        return html.replace('<!-- site-header -->', header);
      },
    },
  };
}
