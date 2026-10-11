import { defineConfig } from 'vite';
import { docsSite } from './build/docs.js';
import { siteHeader } from './build/header.js';
import { siteMetadata } from './build/site.js';

const port = Number(process.env.PORT ?? 4173);

export default defineConfig({
  base: './',
  plugins: [siteHeader(), siteMetadata(), docsSite()],
  build: {
    target: 'es2022',
    rolldownOptions: { input: ['index.html', 'docs/index.html', '404.html'] },
  },
  preview: { port, strictPort: true },
});
