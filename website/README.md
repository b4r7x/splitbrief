# splitbrief website

Static marketing site for splitbrief. A self-contained Vite + TypeScript package; nothing here is shared with the CLI build.

- `npm install` · `npm run dev` · `npm run build` (writes `dist/`, deployable under any path) · `npm run preview` (serves `dist/` on :4173)
- `npm run typecheck` · `npm run lint` · `npm run format` (Biome)
- `npm test` (Vitest, colocated `*.test.ts`) · `npm run e2e` (Playwright on the installed Chrome, against `vite preview`)
- `SHOT_DIR=<dir> SHOT_TAG=<tag> npm run shots` writes `<tag>-1440.png`, `<tag>-fold.png`, `<tag>-390.png` (`SHOT_TIME_MS` seeks the animations, default 4000)
- `npm run render-static` prints the frame-0 ghost art pasted into the three `<pre class="ghost-fallback">` in `index.html`
- Design sheet: `DESIGN.md` — the contract for every file here; read it whole before editing. Handoff: `HANDOFF.md`.
