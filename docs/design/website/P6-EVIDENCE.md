# P6 security and metadata evidence

Recorded 2026-07-30. This is origin-independent evidence only. The production build remains
deliberately blocked until the maintainer supplies `SITE_URL`.

## Implemented contract

- `scripts/site.ts` validates one HTTPS origin and rejects missing values, HTTP, credentials,
  paths, queries, and fragments.
- `scripts/generate-metadata.ts` writes `sitemap.xml` and `robots.txt` from `sitePages()`. Only
  `kind: page` entries enter the sitemap.
- Landing and docs heads derive canonical, Open Graph, and Twitter URLs from the client-safe build
  constant injected by Vite after server-side validation. Landing JSON-LD uses the package version
  and the source-backed values from `CONTENT.md`.
- `/llms.txt` is in the single page enumeration and emits absolute Markdown-mirror links within
  the 5 KiB budget. `/llms-full.txt` and page mirrors remain separate metadata routes.
- `scripts/generate-og.ts` captured `public/og.png` at 1200×630 from the built `/og` route.
- `scripts/validate-og.ts` verifies that reviewed artifact is a nonempty 1200×630 PNG.
  Local `build` remains the two-pass Playwright capture path; Docker uses the dedicated
  `build:container` path, validates the reviewed image, and performs one final Vite build without
  trying to launch Playwright in Node Alpine.
- `scripts/generate-csp.ts` hashes every non-empty inline script in built HTML and emits the nginx
  include without `script-src 'unsafe-inline'`.
- `deploy/Dockerfile` uses digest-pinned official Node and nginx multi-platform images.
  `deploy/nginx.conf` keeps all cache and security headers at server scope, serves exact static
  shapes, owns the relative `/docs` redirect, and enables precompressed gzip. The image build
  fails unless the root, 404, search index, OG image, `llms.txt`, sitemap, robots file, CSP include,
  and a representative Markdown mirror all exist and are nonempty.

## Recipe delta: HTML-parser normalization before CSP hashing

The first browser-enforced CSP smoke failed on TanStack's hydration state. TanStack serializes
route IDs with literal NUL bytes. The HTML parser changes NUL to U+FFFD before the browser computes
the CSP hash; it also normalizes CRLF and CR to LF. Hashing the raw file string therefore produced
the wrong digest even though the draft recipe called for exact built bytes.

The generator now applies those two HTML input-stream normalizations before SHA-256. The regression
test injects the generated header into the built site and exercises landing hydration, matrix
selection, docs theme switching, and search. Result: 1/1 Playwright test passed with zero
`securitypolicyviolation`, console, or page errors. The focused CSP unit suite passed 4/4.

## Gate evidence

- Focused P6 tests: 8 files, 30 tests passed.
- Full website tests after the merged deploy and audit work: 56 files, 265 tests passed.
- TypeScript, Biome lint, and Biome format check passed over 192 files.
- OG artifact: PNG, 1200×630, SHA-256
  `df2bfe6606a2f71d23167f698b5682aabeb7abd2e4ddb01484484d75d0ffd9e9`.
- Generated CSP over the origin-free verification build: 36 unique inline-script hashes; browser
  smoke passed after parser normalization.
- Both base manifests resolved:
  - `node:22.23.1-alpine3.24@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2`
  - `nginx:1.29.8-alpine3.23@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de`
- `env -u SITE_URL npm run build` exited 1 before Vite and reported:
  `SITE_URL is required for canonical metadata. Set it to the production HTTPS origin.`
- `env -u SITE_URL npm run build:container` likewise completed content/link validation and stopped
  at metadata generation with the same explicit error. Its command graph contains no
  `generate:og` or Playwright launch.
- No reserved test origin appears in `public/` or `dist/client`.

## Open gates

- The maintainer must supply the real `SITE_URL`. Until then, canonical metadata, sitemap,
  robots, `/llms.txt`, JSON-LD, the final two-pass build, final CSP, full e2e, and Lighthouse cannot
  be closed against the production-bound artifact.
- Docker 28.1.1 is installed, but its daemon is unavailable at
  `/Users/voitz/.docker/run/docker.sock`. Static tests cannot close nginx syntax, header
  inheritance, `gzip_static`, image contents, or Docker-served CSP behavior.
- Coolify and live-origin verification remain maintainer-owned. Add `SITE_URL` in Coolify's
  Environment Variables UI with **Build Variable** enabled; runtime-only variables do not reach
  the Docker build.

## Fresh primary sources

- [TanStack Start static prerendering](https://tanstack.com/start/latest/docs/framework/react/guide/static-prerendering)
- [TanStack Router document head management](https://tanstack.com/router/latest/docs/guide/document-head-management)
- [MDN CSP implementation guidance](https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/CSP)
- [Docker build best practices: digest pinning](https://docs.docker.com/build/building/best-practices/)
- [nginx gzip static module](https://nginx.org/en/docs/http/ngx_http_gzip_static_module.html)
- [Coolify build-time environment variables](https://coolify.io/docs/knowledge-base/environment-variables)
