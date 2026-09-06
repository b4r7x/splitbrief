import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  preview: { port: 4173, strictPort: true },
});
