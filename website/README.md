# splitbrief website

Static marketing site for splitbrief. A self-contained Vite + TypeScript package; nothing here is shared with the CLI build.

- `npm install` · `npm run dev` · `npm run build` (writes `dist/`, deployable under any path)
- `npm test` (Vitest, colocated `*.test.ts`) · `npm run e2e` (Playwright against `vite preview`)
- `SHOT_DIR=<dir> SHOT_TAG=<tag> npm run shots` writes `<tag>-1440.png`, `<tag>-fold.png`, `<tag>-390.png` (`SHOT_TIME_MS` seeks the animations, default 4000)
- Design sheet: `DESIGN.md` — the contract for every file here; read it whole before editing.
