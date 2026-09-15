# SPLITBRIEF website

The landing page explains the two-tool workflow through a pinned terminal, then a second scene for configuration, session files and installation. It uses Vite, strict TypeScript and native browser APIs. Runtime dependencies: none.

## Development

From `website/`:

```sh
npm ci
npm run dev -- --port 4317 --strictPort
npm run build
npm run preview
```

The production build goes to `dist/` and uses relative asset URLs, so it can be served below a path prefix. Fonts live in `src/assets/fonts/`; their license texts live in `public/licenses/` and are copied unchanged to `dist/licenses/`. The page does not request remote fonts.

## Checks

```sh
npm run typecheck
npm run lint
npm run check:structure
npm test
npm run e2e
SHOT_DIR=../.test-artifacts/website npm run shots
```

`npm run check` runs the complete sequence, including the production build used by Playwright. E2E uses installed Chrome and starts a preview on port 4173; set `PORT` to use a different port. Screenshot capture is opt-in through `SHOT_DIR`; the command above saves both scenes at desktop and phone sizes.

Structural checks use dependency-cruiser and Knip from the repository's root dev dependencies. Install the root dependencies before running those checks. Keeping the tooling there avoids Knip 5's TypeScript peer-version conflict with this package; the website build itself remains independent. CI installs both dependency sets and runs the full website check.

## Code ownership

- `src/main.ts` mounts the page and disposes it during Vite HMR.
- `src/lib/scene.ts` defines the shared controller contract; `motion.ts` owns the sole animation clock and global motion events.
- `src/features/walkthrough/` owns the six-stage terminal and transcript timeline.
- `src/features/continuation/` owns the pinned details scene, deterministic text decoder, session-file tabs and clipboard controls.
- `src/features/ascii/` owns bridge geometry, the three continuation poses, canvas rendering and the drifting background ribbons.
- `src/styles/` holds palette, font declarations, page composition and accessibility rules. Feature styles stay with their feature.

Feature modules do not import each other. The composition root passes progress into the renderer. Tests are colocated; browser scenarios live in `tests/e2e/`. Import concrete modules with `.js` suffixes, without internal barrels.

The design and interaction contract is in [DESIGN.md](./DESIGN.md). Integration details are in [HANDOFF.md](./HANDOFF.md).
