# splitbrief website

Static marketing site for splitbrief. A self-contained Vite + TypeScript package; nothing here is shared with the CLI build.

- `npm install` · `npm run dev` · `npm run build` (writes `dist/`, deployable under any path) · `npm run preview` (serves `dist/` on :4173, or `$PORT`)
- `npm run typecheck` · `npm run lint` · `npm run format` (Biome)
- `npm test` (Vitest, colocated `*.test.ts`) · `npm run e2e` (Playwright on the installed Chrome, against `vite preview`)
- `SHOT_DIR=<dir> SHOT_TAG=<tag> npm run shots` writes `<tag>-1440.png`, `-fold.png`, `-390.png`, `-1920.png`, `-1920-fold.png`, `-1024.png`, `-768.png`, `-1920-s02/-s03/-s04.png` and `<tag>-hero-1440/1920.json` (`SHOT_TIME_MS` seeks the animations, default 4000)
- `SHOT_DIR=<dir> SHOT_TAG=<tag> npx playwright test tests/e2e/frames.e2e.ts` writes the spark and transcript frames.
- `npm run render-static` prints the frame-0 ghost art pasted into the three `<pre class="ghost-fallback">` in `index.html`
- Design sheet: `DESIGN.md` — §16 is the lower page, §1–§14 the hero and the shared rules; read it whole before editing. Handoff: `HANDOFF.md`.
