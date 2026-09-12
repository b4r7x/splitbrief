import { defineConfig } from 'vite';

const port = Number(process.env.PORT ?? 4173);

export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  preview: { port, strictPort: true },
});
