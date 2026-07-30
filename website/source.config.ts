import type { RehypeCodeOptions } from 'fumadocs-core/mdx-plugins';
import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { remarkContentSecurity } from './scripts/remark-content-security.js';
import { splitbriefDark, splitbriefDocsLight } from './src/design/shiki-themes.js';

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

const rehypeCodeOptions = {
  engine: 'oniguruma',
  themes: {
    dark: splitbriefDark,
    light: splitbriefDocsLight,
  },
  defaultColor: false,
} satisfies RehypeCodeOptions;

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions,
    remarkPlugins: (plugins) => [remarkContentSecurity, ...plugins],
  },
});
