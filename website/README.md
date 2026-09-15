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
- `src/lib/scene.ts` defines the shared controller contract; `motion.ts` owns the sole animation clock and global motion events. Shared navigation, decoding, tab transitions and clipboard behavior live alongside them. Page scrolling remains native.
- `src/features/walkthrough/` owns the six-stage terminal and transcript timeline.
- `src/features/continuation/` owns the pinned details scene, session-file descriptions and npm/source installation tabs.
- `src/features/ascii/` owns bridge geometry, the three continuation poses, canvas rendering and the drifting background ribbons.
- `src/styles/` holds palette, font declarations, the shared header, page composition and accessibility rules. Feature styles stay with their feature.
- `src/docs.ts` composes documentation with the shared ASCII renderer and motion clock. `src/features/docs/` owns article transitions, page filtering, contents navigation and styles.
- `build/catalog.ts` discovers the repository Markdown. `build/docs.ts` renders static pages through the one `docs/index.html` template; `build/markdown.ts` renders articles and resolves links. Marked runs only during development and builds.
- `build/header.html` is the single header for landing and docs, inserted by `build/header.ts`.

Feature modules do not import each other. The composition root passes progress into the renderer. Tests are colocated; browser scenarios live in `tests/e2e/`. Import concrete modules with `.js` suffixes, without internal barrels.

The design and interaction contract is in [DESIGN.md](./DESIGN.md). Integration details are in [HANDOFF.md](./HANDOFF.md).

## Documentation sources

`/docs/` lists the full documentation. Every Markdown file under the repository's `docs/` directory gets a route, including nested directories. Root README, CONTRIBUTING and CHANGELOG are also included. Navigation groups and order come from `docs/README.md`; unlisted guides remain discoverable under More guides or Design notes. Adding or editing a source updates development output and the next production build. Article content is never copied into the website.

Links between mapped Markdown files resolve locally, preserving section anchors. Source-code links remain on GitHub. Routes and assets work below a hosting prefix. Without JavaScript, every article, page link and contents list is ordinary HTML. With JavaScript, article navigation encodes and decodes while retaining the header and artwork; browser history restores reading position. The page filter searches titles, not article bodies.

## Removing the documentation site

The docs implementation remains separable from the landing:

1. Remove `docs/`, `build/catalog.ts`, `build/catalog.test.ts`, `build/docs.ts`, `build/markdown.ts`, `src/docs.ts`, `src/features/docs/` and `tests/e2e/docs.e2e.ts`. Remove the docs screenshot steps in `tests/e2e/shots.e2e.ts`.
2. Remove the `docsSite` import and plugin from `vite.config.ts`, and return the build input to `index.html` alone. Remove the docs entry from `knip.json`; narrow the entry exceptions in `dependency-cruiser.config.cjs` back to `src/main.ts`.
3. Point the docs links in `build/header.ts` and `index.html` back to GitHub, and update the corresponding assertion in `page.e2e.ts`.
4. Run `npm uninstall --save-dev marked --ignore-scripts`, then `npm run check`.

Keep the canonical repository Markdown, `build/header.*`, npm instructions and shared runtime modules. The landing animations do not depend on the docs feature.
