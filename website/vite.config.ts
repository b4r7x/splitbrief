import { defineConfig } from 'vite';
import { docsSite } from './build/docs.js';
import { siteHeader } from './build/header.js';

const port = Number(process.env.PORT ?? 4173);

export default defineConfig({
  base: './',
  plugins: [siteHeader(), docsSite()],
  build: {
    target: 'es2022',
    rolldownOptions: { input: ['index.html', 'docs/index.html'] },
  },
  preview: { port, strictPort: true },
});
