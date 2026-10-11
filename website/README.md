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

The production build goes to `dist/` and uses relative asset URLs. Canonical links, Open Graph tags, the sitemap and `llms.txt` use absolute URLs from `site.json`, so they assume the site is served at the root of its origin. Fonts live in `src/assets/fonts/`; their license texts live in `public/licenses/` and are copied unchanged to `dist/licenses/`. The page does not request remote fonts.

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
- `build/catalog.ts` lists the published Markdown and derives titles, descriptions and navigation groups. `build/docs.ts` renders static pages through the one `docs/index.html` template; `build/markdown.ts` renders articles and resolves links. Marked runs only during development and builds.
- `site.json` is the one place for the production origin, the repository URL and the npm package status. `build/site.ts` reads it and owns every page's head metadata: title, description, canonical link, Open Graph and Twitter tags, and the landing's JSON-LD. It also keeps the landing's install copy for the npm state: `index.html` holds both versions between `<!-- npm:published -->` and `<!-- npm:unpublished -->` markers, and the build keeps one.
- `build/discovery.ts` derives `sitemap.xml`, `robots.txt` and `llms.txt` from the catalog.
- `build/header.html` is the single header for the landing, the docs and the not-found page, inserted by `build/header.ts`.

Feature modules do not import each other. The composition root passes progress into the renderer. Tests are colocated; browser scenarios live in `tests/e2e/`. Import concrete modules with `.js` suffixes, without internal barrels.

The design and interaction contract is in [DESIGN.md](./DESIGN.md). Integration details are in [HANDOFF.md](./HANDOFF.md).

## Documentation sources

`/docs/` is the documentation index (`docs/README.md`). The site publishes only the user guides in the `published` list in `build/catalog.ts`, the same set the npm package ships, plus `CHANGELOG.md`. Maintainer pages stay on GitHub. Navigation groups and order come from `docs/README.md`; published guides that it does not list appear under More guides. Editing a published source updates development output and the next production build. To publish another guide, add it to the list. Article content is never copied into the website.

Each page's title is the first heading of its source without a leading product name. Each page's description is the first paragraph of its source, reduced to plain text and cut at a sentence end within 160 characters. Pages whose first paragraph is not a summary take a short explicit description from `descriptions` in `build/catalog.ts`. A title that wraps in the narrow menu takes a short library label from `labels` in the same file.

Links between published Markdown files resolve locally, preserving section anchors. Links to unpublished guides and to source code go to the file on GitHub. A link whose text is only a file name, such as `WORKFLOW.md §Apply`, shows the target's title instead: a published page's title, the first heading of an unpublished guide under `docs/`, or the file name as words for any other file. On the index, the "New here?" reading order lists only published guides, so a new reader stays on the site. Routes and assets work below a hosting prefix. Without JavaScript, every article, page link and contents list is ordinary HTML. With JavaScript, article navigation encodes and decodes while retaining the header and artwork; browser history restores reading position. The page filter searches titles, not article bodies.

## Site identity and production

`public/favicon.svg` is the `[ / ]` mark. `public/social.png` is the 1200 × 630 sharing image: the header wordmark and the landing headline in the site's own fonts, rendered once with Chromium. Replace it with an image of the same size if the headline changes. `404.html` is a built page with the shared header, fonts and `src/styles/not-found.css`. The server returns it for a missing page at any depth, so the build rewrites its asset URLs to start at the site root.

To change the domain, edit `origin` in `site.json`. Until the package is on npm, the install panel says that the first npm release is coming and links the repository. When the package is on npm, set `npm.published` to `true`. The install panel then shows `npm install -g splitbrief` and links the npm page; the JSON-LD and `llms.txt` also name the npm URL. The production image, the server contract and the deploy procedure are in [`deploy/WEBSITE_DEPLOYMENT.md`](../deploy/WEBSITE_DEPLOYMENT.md).

## Removing the documentation site

The docs implementation remains separable from the landing:

1. Remove `docs/`, `build/catalog.ts`, `build/catalog.test.ts`, `build/docs.ts`, `build/markdown.ts`, `build/discovery.ts`, `build/discovery.test.ts`, `src/docs.ts`, `src/features/docs/` and `tests/e2e/docs.e2e.ts`. Remove the docs screenshot steps in `tests/e2e/shots.e2e.ts`. Without the catalog, the build emits no sitemap, `robots.txt` or `llms.txt`; write a static `public/robots.txt` if you still want one.
2. Remove the `docsSite` import and plugin from `vite.config.ts`, and return the build input to `index.html` and `404.html`. Remove the docs entry from `knip.json`; narrow the entry exceptions in `dependency-cruiser.config.cjs` back to `src/main.ts`.
3. Point the docs links in `build/header.ts`, `index.html` and `404.html` back to GitHub, and update the corresponding assertion in `page.e2e.ts`. The live checks in `.github/workflows/deploy-website.yml` and the checks in `scripts/verify-website-image.sh` request docs routes; remove those checks too.
4. Run `npm uninstall --save-dev marked --ignore-scripts`, then `npm run check`.

Keep the canonical repository Markdown, `build/header.*`, `build/site.ts`, `site.json`, npm instructions and shared runtime modules. The landing animations do not depend on the docs feature.
