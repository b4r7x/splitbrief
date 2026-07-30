# SPLITBRIEF Website — Implementation Plan

Landing + docs site for SPLITBRIEF, to be built by an implementer agent. Entry point: `KICKOFF.md`. Read `DIRECTION.md` (design contract) and `CONTENT.md` (copy + IA) first — this file covers architecture, tasks, and gates. Provenance: diffgazer-workspace reference teardown (`~/Projects/diffgazer-workspace/apps/{landing,docs}`), stack SOTA verified 2026-07-30, decisions confirmed with the maintainer, three-critic adversarial verification folded in.

## Goal & non-goals

**Goal:** one TanStack Start app at `website/` — fully custom landing at `/`, headless-fumadocs docs at `/docs/*` (32 pages), prerendered to pure static files, deployed via Coolify (Hostinger VPS) as an nginx container built from `deploy/Dockerfile`. This planning bundle (`docs/design/website/`) is internal — it never becomes site content.

**Non-goals:** no npm workspace conversion of the repo; no fumadocs-ui theme; no per-request CSP-nonce/SSR pipeline (the static build hashes its actual inline scripts and nginx serves that generated policy); no auto-sync from `docs/*.md` (content is hand-curated MDX); no CMS; no analytics.

## Hard constraints

1. **NEVER commit or stage anything** — all changes stay unstaged; the maintainer reviews and commits (repo-wide rule, hook-enforced). This includes Playwright visual baselines — generate them and leave them unstaged.
2. `website/` is self-contained: own `package.json`, own lockfile, own configs. Root gates (`npm run test-ci`) must pass untouched, and website must not join them.
3. Root files that MAY be touched, minimally: `biome.json` (Biome 2.4.10 folder exclusion: `!!website`) and root `.gitignore` (only if website's own `.gitignore` is insufficient). Root Knip already scopes its `project` patterns to `src/`, `scripts/`, `evals/`, and `testing/`, so adding `website/**` to `ignore` is redundant and produces a configuration hint. P0 additionally touches the visual-gallery fixture surface: `testing/visual/fixtures/**` AND the files that hardcode fixture strings — `testing/visual/catalog.ts` (the `workflow-implementation` readiness `marker:` references fixture transcript text) and `testing/visual/artifacts-bundle.test.ts` (asserts fixture strings) — keep marker, fixture text, and assertions in lockstep. Nothing else at root.
4. Positioning + honesty rules from `DIRECTION.md` bind every artifact: interop-first, cost as whisper, real YAML/brief/frames only, from-source CTA.

## Deployment identity (required inputs)

Hosting: **Coolify on the maintainer's Hostinger VPS** (maintainer decision). Deployment is a Coolify application built from the git repo with the **Dockerfile build pack** — the static+Nixpacks pack cannot take a custom nginx config, and we need custom headers, the `/docs` 301, and `gzip_static` ([Coolify discussion #3250](https://github.com/coollabsio/coolify/discussions/3250), [Coolify docs](https://coolify.io/docs/applications)). Coolify's Traefik proxy terminates TLS and routes the domain; our nginx container listens on port 80 behind it.

- **`SITE_URL`** — the canonical production origin. **Open input: the maintainer must supply the domain before P4** (the llms routes built in P4 emit absolute links; sitemap, OG URLs, JSON-LD, canonical tags follow at P6; the same domain is configured on the Coolify app). It lives as ONE exported constant (`scripts/site.ts` or equivalent) that `generate-metadata.ts`, the llms routes, and SEO heads all import — never invent a placeholder domain.
- **Coolify app settings (maintainer creates in the Coolify UI at P7):** source = the GitHub repo; base directory = `/website`; build pack = Dockerfile; Dockerfile location = `/deploy/Dockerfile` relative to that base; port exposes = `80`; Force HTTPS = on; health check = `GET /` on port `80`; domain = the host from `SITE_URL`. Leave port mappings empty so Traefik owns ingress, and do not enable the Nixpacks-only static-site toggle or paste a second nginx configuration into Coolify. Deploys trigger on push (the maintainer pushes; the implementer never commits) or manually in the UI.
- **`OUTPUT_DIR` = `dist/client`** — the static build output of `tanstackStart({ prerender })` without nitro (vite `build.outDir` default `dist` + `client`). All consumers reference this single constant: the Dockerfile COPY, the Playwright e2e `webServer`, and `run-lighthouse.ts`. **Do not copy reference-site scripts that hardcode `.output/public`** — that is nitro's layout and will never exist here. P1 gate verifies the real dir once and records it.

## Stack (exact pins, verified against package sources and registries 2026-07-30)

| Package | Version | Note |
|---|---|---|
| `@tanstack/react-start` | `1.168.33` | Requires Node 22.12+ LTS or a supported even-major Node; the package engine is `^22.12.0 || >=24.0.0`, excluding Node 23 |
| `@tanstack/react-router` | `1.170.18` | Exact version required by the Start package |
| `@tanstack/router-generator` | `1.167.21` | Direct dev dependency for non-Vite route-tree generation |
| `fumadocs-core` | `16.13.0` | Headless only: loader, page tree, TOC, static Orama search |
| `fumadocs-mdx` | `15.2.0` | Build-time dev dependency; Vite plugin plus `postinstall` generate runtime collections under `.source/` |
| `vite` | `7.3.6` | Vite 8 is out of scope for this pinned build |
| `@vitejs/plugin-react` | `5.2.0` | React plugin remains active under Vitest; Vite and TypeScript use the same two explicit aliases |
| `tailwindcss` + `@tailwindcss/vite` | `4.3.3` | CSS-first, no tailwind.config; tokens as CSS custom properties |
| `react` / `react-dom` | `19.2.8` | Exact pins |
| `typescript` | `6.0.3` | Exact dev pin |
| **no nitro** | — | built-in `tanstackStart({ prerender })` does SSG; the nitro plugin is beta and reported to conflict with prerendering |
| `zod` | `4.4.3` | Frontmatter schema |
| dev: `vitest` `4.1.10`, `jsdom` `28.1.0`, `@playwright/test` `1.62.0`, `@axe-core/playwright` `4.12.1`, `@lhci/cli` `0.15.1`, `@biomejs/biome` `2.5.6` | exact | Mirror the reference-site testing stance while retaining the Node 22 floor |

Version policy: copy these exact versions into `website/package.json`; do not substitute a newer patch during scaffolding. `website/package-lock.json` ships with the handoff and pins the full transitive graph. Do not install Nitro or `fumadocs-ui`.

Search: **Orama static** — build-time index export (`createFromSource(source)` → `staticGET`) served from a prerendered `/api/search` server-route; client uses `oramaStaticClient` from `fumadocs-core/search/client/orama-static`. Fully static, no server at runtime.

## Layout

```
website/
├── package.json / package-lock.json / .gitignore / .dockerignore / README.md
│                                      # .dockerignore: node_modules, dist, .source, .test-artifacts, coverage, playwright-report, *-snapshots
├── vite.config.ts              # explicit @→src + collections→.source aliases; plugin order: mdx() → tailwindcss() → conditional tanstackStart({prerender, top-level pages}) → react()
├── source.config.ts            # defineDocs({ dir: 'content/docs', docs: { postprocess: { includeProcessedMarkdown: true } } }); frontmatter zod; TWO custom shiki themes built from the site tokens (silkscreen base, magenta keys, cyan strings, AA dim comments — one per site theme, themes:{light,dark} + defaultColor:false; stock themes banned per DIRECTION gate row 2)
├── tsconfig.json / biome.json / playwright.config.ts / lighthouserc.json
├── content/docs/               # 32 MDX pages + meta.json nav (per CONTENT.md; fumadocs meta conventions: root, "---Label---" separators, "...folder" spreads)
├── public/                     # fonts/*.woff2 (+OFL licenses), favicon.svg, og.png (generated, P6), robots.txt+sitemap.xml (generated pre-build)
├── scripts/
│   ├── site.ts                 # SITE_URL + OUTPUT_DIR constants — the single source for origin and output dir
│   ├── pages.ts                # THE single enumeration: SitePage[] with a `kind` per entry and optional per-page prerender override (`/404` → `/404.html`)
│   ├── generate-metadata.ts    # sitemap.xml (kind=page only) + robots.txt into public/ pre-build
│   ├── generate-csp.ts         # post-build: hash every actual inline script in OUTPUT_DIR → dist/nginx-csp.conf
│   ├── check-links.ts          # resolve every href in MDX against the page set; exit 1 on rot
│   ├── generate-route-tree.mjs # @tanstack/router-generator for non-vite entries (tsc/vitest)
│   ├── generate-og.ts          # screenshot the hidden /og route at 1200×630 → public/og.png (Playwright)
│   └── run-lighthouse.ts       # serve OUTPUT_DIR statically + lhci autorun
├── deploy/
│   ├── Dockerfile              # multi-stage: exact Node 22 image builds + hashes CSP + precompresses text with preserved mtimes → exact nginx image serves only OUTPUT_DIR
│   └── nginx.conf              # port 80 behind Traefik; relative `/docs` 301; hash-shaped assets immutable, everything else revalidated; generated hash CSP + security headers; gzip_static + dynamic fallback
├── src/
│   ├── router.tsx / routes/__root.tsx        # fresh router per getRouter() call; shellComponent with HeadContent/Scripts; TanstackProvider from fumadocs-core/framework/tanstack
│   ├── routes/index.tsx                      # landing page (composes features/landing)
│   ├── routes/404.tsx (or the router's notFound route)   # token-styled 404; pages.ts sets prerender.outputPath='/404.html' explicitly
│   ├── routes/og.tsx                         # hidden token-styled OG card route (used only by generate-og.ts; excluded from sitemap)
│   ├── routes/docs/index.tsx                 # dev-parity redirect → first page (production authority is the nginx 301; both exist)
│   ├── routes/docs/$.tsx                     # doc page: source from collections/server; lazy MDX body from default import collections/browser
│   ├── routes/docs/{$}[.]md.ts               # route id /docs/{$}.md; per-page markdown mirrors via server-route GET + local lib/get-llm-text.ts
│   ├── routes/llms[.]txt.ts, llms-full[.]txt.ts, api/search.ts   # server-route GET handlers, prerendered via pages.ts (there is NO `render: 'static'` option — prerendering is driven by the pages list)
│   ├── lib/source.ts                         # import { docs } from 'collections/server'; never import runtime collections from source.config
│   ├── lib/get-llm-text.ts                   # page → markdown (requires includeProcessedMarkdown)
│   ├── styles/index.css                      # @import tailwindcss; token tiers per DIRECTION (both themes), type scale, panel-strip primitives
│   ├── test-setup.ts                         # vitest jsdom setup (referenced by vite.config's test branch)
│   ├── features/landing/                     # matrix/{matrix.tsx, pairings.ts, use-matrix-keys.ts, picker.tsx}, sections per CONTENT.md anatomy, install-block.tsx
│   └── features/docs-ui/                     # layout.tsx, sidebar.tsx (jack bullets + mobile INDEX disclosure), toc.tsx (+ mobile disclosure), search-dialog.tsx, mdx-components.tsx, theme-toggle.tsx (docs only), prev-next.tsx
└── tests colocated (*.test.ts[x]) + testing/e2e/*.e2e.ts
```

Structure rules (repo-standard + sota-structure): kebab-case; no internal barrels — `routeTree.gen.ts` and framework-required files excepted; tests colocated; no path-echo names; target ≤200 lines/file per responsibility.

## Key architecture decisions

1. **One vite config, `isVitest` gating:** under Vitest, omit only `tanstackStart()` and add the `test:` block; `viteReact()` remains installed in both modes. Route files are excluded via the byte-identical `routeFileIgnorePattern: "\\.test\\.tsx$"` in the Start router options and `generate-route-tree.mjs`; both also use `addExtensions: "js"` for repo-conformant generated route imports. Start's package-generated, type-only registration footer resolves the actual router entry as `./router.tsx`; the standalone generator reproduces that exact footer so Vite and non-Vite generation do not flap. This ignored generated line is the narrow exception to the handwritten `.js` suffix rule.
2. **Single enumeration with page kinds:** `scripts/pages.ts` exports the full URL universe once, each entry tagged `page | md-mirror | metadata`; `vite.config.ts` passes `prerenderPages()` as the plugin's top-level `pages` option. Set `prerender.autoStaticPathsDiscovery: false`, `crawlLinks: false`, and `failOnError: true`: the framework defaults static-path discovery and link crawling to on, which would violate the single-enumeration invariant. `/docs` is deliberately absent—the development route redirects locally, while the static-server harness and production server own redirect behavior. The `/404` entry carries `prerender: { outputPath: "/404.html" }`; `generate-metadata.ts` renders `kind=page` to the custom sitemap, and `check-links.ts` validates against the whole set. Because `pages.ts` must walk `content/docs` itself (it cannot import build-generated code from vite config), add a de-drift unit test: the walk's slug set equals `source.getPages()`'s slug set.
3. **MDX as lazy client chunk** via `createClientLoader`; add the pre-hydration preload (marker element + race timeout) only if a real skeleton flash is observed on the built output, not preemptively.
4. **Theme scope: the landing is Panel Black only — no toggle on `/`.** The re-toned light theme exists solely under `/docs/*`, toggled from the docs shell, persisted under one named localStorage key (`splitbrief-docs-theme`), pre-paint init script in `__root`. The initializer allowlists only `dark|light`, ignores the stored docs preference outside `/docs`, and mutates `<html data-theme>` before hydration; `<html>` therefore carries `suppressHydrationWarning`, while the toggle's first-render markup remains stable. Per-theme axe scans apply to docs pages; landing is scanned dark-only.
5. **404** generated from the same token file at build time — never a second hand-inlined palette.
6. **Landing JS budget:** the matrix (+ mobile picker) is the only interactive widget; the pulse is click-driven — **zero observers**, no rAF loops. If landing route JS (excluding React runtime chunks) exceeds ~30KB gz, cut features, not the budget.
7. **Docs-UI defaults:** anchor links on h2/h3 (hash affordance on hover/focus); copy button on every bordered code frame including the matrix YAML output; Cmd/Ctrl+K opens search; prev/next links from the page tree; SVG favicon from the pin motif. Explicitly OUT of v1: breadcrumbs, edit-on-GitHub links, last-updated stamps.
8. **Static CSP from the shipped artifact:** `generate-csp.ts` runs after prerender, hashes the exact bytes of every non-empty inline `<script>` without `src` in `dist/client/**/*.html`, sorts/deduplicates the SHA-256 sources, and writes `dist/nginx-csp.conf`. The final image copies that generated include beside `nginx.conf`; it never ships `script-src 'unsafe-inline'`, a fixed nonce, or a hand-maintained hash list. A Docker-served Playwright gate records `securitypolicyviolation`, console errors, and page errors while exercising theme persistence, matrix interaction, and search.

## Build pipeline

`build` script order: `generate-metadata` (into `public/`) → `vite build` (prerender all enumerated URLs) → `generate-csp` (from the finished HTML into `dist/nginx-csp.conf`) → `check-links`. Vite's build root is `dist`; Start emits deployable files under `dist/client` and a build-time-only server bundle under `dist/server`. With `autoSubfolderIndex: true`, HTML routes become `dist/client/<path>/index.html`; markdown mirrors retain `.md`; `/api/search` is extensionless; `/404` alone is overridden to `dist/client/404.html`. These shapes are expectations until the P1/P4 gates record the real tree; P7 derives `try_files`, MIME overrides, and `error_page` from that evidence rather than preserving a stale recipe. `test` = vitest. `test:e2e` = `npm run build && playwright test` with Playwright's `webServer` serving `OUTPUT_DIR` statically and implementing the same `/docs` redirect contract without adding `/docs` to prerender pages. Visual baselines live in Playwright's default `*-snapshots/` dirs next to the specs (`maxDiffPixelRatio: 0.01`, animations disabled), regenerated with `--update-snapshots`, left unstaged for the maintainer. `lighthouse` budgets: perf ≥ 0.90, a11y ≥ 0.95, FCP ≤ 2000, LCP ≤ 2500, CLS ≤ 0.1, TBT ≤ 300, `color-contrast`/`heading-order`/`errors-in-console` as errors.

## Phases & gates

Sequential; each gate must pass before the next phase. No phase is "done" with a failing gate.

- **P0 — Prep.**
  - Fixture credibility: make the workflow gallery fixture production-plausible while keeping determinism. The fixture surface spans `testing/visual/fixtures/screen-fixtures.ts` and `testing/visual/fixtures/workflow/projections.ts` — replace ALL synthetic strings a frame can display: task titles, file paths, `fixture-model-v1` → `qwen2.5-coder:7b`, `fixture-planner-v1` → a real planner name, `Synthetic local runner` → a real runner label, the `WORKFLOW_FEATURE`/transcript texts, and keep `estimatedCostSavings` in the product's real format. Respect the frozen `WORKFLOW_FIXTURE_BOUNDS` (`maxEventsPerFixture: 8`, `maxStringLength: 160`); bump `WORKFLOW_FIXTURE_VERSION` if the contract requires it. Update in lockstep: the `workflow-implementation` readiness `marker:` in `testing/visual/catalog.ts` and the string assertions in `testing/visual/artifacts-bundle.test.ts`. Re-run the visual suite so baselines stay green, then `npm run tui-shots` at repo root.
  - Copy the frames CONTENT.md needs into `website/public/frames/` — SVG, **120×40 viewport**, scenario `workflow-implementation` among them. Frames keep their own SVG-internal mono stack (real artifact); the landing supplies a real descriptive alt text.
  - Fonts: ship Archivo as a variable woff2 **retaining the `wdth` axis** (or named instances Archivo Expanded 500/700 + Archivo 400), Instrument Sans 400/500, Fragment Mono 400 — latin subset, from the Google Fonts repo, licenses alongside.
  - Gate: frames contain no retired-brand text; a font specimen rendering the same string in Archivo normal vs `font-stretch: expanded` shows a clearly wider run (≥5% advance-width difference is the bar; screenshot recorded); root visual suite green.
- **P1 — Scaffold.** `website/` package, vite config, source.config, router, empty routes, token CSS skeleton, and the root `biome.json` exclusion. Root Knip containment is already structural through its explicit `project` patterns. Gate: `npm run dev` serves a page; one `vite build` run confirms the prerender output lands in `dist/client` (recorded in `scripts/site.ts`) and records the root/404/asset output shapes that P7 must serve; root `npm run test-ci` still green.
- **P2 — Design system.** Both token tiers (dark + docs-light per DIRECTION — light is re-toned, not inverted), type scale, panel-strip primitives, bordered frame, jack bullet, focus ring, the two custom shiki themes. Gate: tokens demo route renders; axe unit pass; AA table recorded for every accent AND both functional-grid tokens (`#6E6E76` dark / `#6E6E68` light) **on all three surfaces of each theme, measured at each theme's worst-case step per DIRECTION** (magenta text token `#E85FA8`, light accents `#B01D72`/`#0B5E66` included).
- **P3 — Landing.** Matrix (pairings data + `role="grid"` table semantics + keyboard + crosshair mechanic + pulse), mobile picker (radiogroups per DIRECTION), all panel strips per CONTENT.md, install block, 404, hidden /og route. Gate: DIRECTION.md critique loop (fresh critic, 1440+390 screenshots, gate + floor + feel words) — all rows pass, verdicts in `CRITIQUE.md`; matrix keyboard contract e2e green; every `pairings.ts` YAML fragment diffed against `docs/CONFIGURATION.md`; rail rendering passes DIRECTION's real-artifact rule (labels = title-cased `RAIL_STAGES` entries; separators = the product's `›`/`→` connector glyphs); kill-test objective half (copy button yields runnable YAML) passes. If the critic fails gate row 4 or feel words after 3 cycles → STOP, escalate to maintainer (never self-switch to the fallback).
- **P4 — Docs shell.** Prerequisite: request `SITE_URL` from the maintainer NOW (the llms routes emit absolute links). Layout, sidebar from page tree (+ mobile INDEX disclosure), TOC (+ mobile disclosure), search (static Orama), MDX components, theme toggle, prev/next, llms + mirror routes. Gate: 3 sample pages render in both themes; search returns results on built output; keyboard nav through sidebar; docs page fully usable at 390px; one docs-shell critique cycle recorded in `CRITIQUE.md`; the development `/docs` route redirects without a trailing slash on its target, the static harness exercises the same production redirect, the prerender enumeration contains no `/docs` entry, and the built `.md` plus `/api/search` file shapes and MIME needs are recorded for P7.
- **P5 — Content.** All 32 MDX pages per CONTENT.md mapping + meta.json nav, applying CONTENT's as-is link-remap policy. Gate: `check-links` clean; every rewrite page re-read against its source doc for factual drift; banned-vocabulary grep over **landing copy, page titles/descriptions, and rewrite/new pages — except the Cost management guide** (the sanctioned cost page may quote the product's real UI strings verbatim, percentages included; as-is imports are exempt per DIRECTION gate row 7).
- **P6 — Quality toolchain.** sitemap/robots/OG (`generate-og.ts`, two-pass: build → screenshot `/og` from served output → `public/og.png` → final build)/JSON-LD (values per CONTENT.md); full e2e suite — axe per applicable theme (landing dark; docs both), visual baselines (landing 1440+390, one docs page per theme), static assets incl. llms.txt + one md mirror + search payload served; generated CSP include contains a hash for every actual inline script and no `script-src 'unsafe-inline'`; lighthouse over `/`, one page per docs group. Gate: full `build && test && test:e2e && lighthouse` green.
- **P7 — Deploy (Coolify). Split ownership — the implementer's gate is LOCAL evidence.** Implementer: write `deploy/Dockerfile` + `deploy/nginx.conf` from the recorded output tree; all cache/security `add_header` directives stay at server scope, with one HTTP-scope URI map making only Vite hash-shaped `/assets/*` immutable and every other response revalidate. Build locally from `website/` with `docker build -f deploy/Dockerfile .`; run the image on `127.0.0.1:8080:80`; prove `nginx -t`, the gzip-static module, relative `/docs` 301 to `/docs/getting-started/introduction`, custom 404 status/body, correct JSON/Markdown MIME under `nosniff`, security headers on HTML/assets/API/redirect/404, immutable hashed assets only, `Vary` + `Content-Encoding: gzip` on JS/Markdown/search, and sitemap/llms reachability. Run Playwright against the nginx origin and require zero CSP violations or hydration/console errors while matrix, docs theme persistence, and search work. If Docker is unavailable, record that explicitly: static-server curls can verify files and status behavior but **cannot close** the nginx-header/CSP/gzip portion of the gate. **Implementer's P7 gate closes only on that local evidence plus the handoff checklist.** Maintainer then commits the bundle (including `website/package-lock.json`, required by the Dockerfile's explicit `COPY` + `npm ci`), creates the Coolify app with source repo · Base Directory `/website` · Dockerfile build pack · Dockerfile Location `/deploy/Dockerfile` · Port Exposes `80` · Force HTTPS on · health check `GET /` port `80` · no port mapping · no static-site toggle/custom nginx override · domain from `SITE_URL`, deploys, and repeats the curl/CSP/Lighthouse checks against the live origin. Decide HSTS only after the real HTTPS host is confirmed; never infer an `includeSubDomains` policy. Live-origin verification is maintainer-owned because the implementer cannot push.

## Implementer charter (binding)

- **Lean contract:** the diff answers the task and nothing else; validation only at real boundaries (a static site trusts its own build); no abstraction under 3 call sites; no config option without a second real value; no `?? default` masking a build-time guarantee. End each task with a self-sweep line (`lean sweep: clean` or what was deleted).
- **Design authority:** `DIRECTION.md` wins over taste. Any gate-row conflict = stop and redesign, don't caveat. Fallback switching is maintainer-only (see P3 gate).
- **Verify before "done":** every phase gate is evidence-based (command output, screenshot, diff) — no claims without artifacts. Report failures as failures.
- **Never commit.** Leave everything unstaged, baselines included.

## Risks

1. **Fumadocs generated-collection drift** — the validated pair is `fumadocs-mdx@15.2.0` + `fumadocs-core@16.13.0`; keep `mdx()` config discovery and the `collections/server` / default `collections/browser` imports. Do not silently fall back to v14-era aliases or add `fumadocs-ui`; investigate against the pinned package source and change versions only as an explicit architecture decision.
2. **TanStack Start RC drift** — pin exact versions; upgrade only deliberately with release notes.
3. **Matrix a11y/mobile** is the hardest craft in the project — it has its own gate (P3) and an escalation path; the fallback is never self-triggered.
4. **Accent AA drift** — tone adjustments allowed, hue roles fixed; every change re-recorded in the P2 AA table.
5. **Root-gate leakage** — P1 gate re-runs root `test-ci`; if any root tool starts crawling `website/`, fix exclusions before proceeding.
6. **Coolify specifics drift** — the Dockerfile pack + base-directory combination is the verified path for custom nginx config (static+Nixpacks cannot take one); if the Coolify UI options differ at deploy time, keep the Dockerfile as the source of truth and adapt the app settings, not the image.
7. **CSP/build drift** — TanStack may change its inline bootstrap shape. Hash the finished HTML on every build and exercise the Docker-served app; never copy hashes from another build, reuse a fixed nonce, or loosen scripts to `'unsafe-inline'` to silence a violation.
