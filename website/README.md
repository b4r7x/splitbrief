# SPLITBRIEF website

Static landing and documentation app for SPLITBRIEF. TanStack Start prerenders the site, and
headless Fumadocs supplies the documentation model. The deployable output is `dist/client`;
`dist/server` is build-time-only.

The app intentionally has no Nitro or `fumadocs-ui` dependency. Do not introduce
`.output/public` assumptions: every static consumer uses `dist/client`.

## Requirements

- Node.js `^22.19.0 || ^24.0.0 || ^26.0.0`; use a supported even-numbered release
- npm `10.9.7`

Run commands from `website/`:

```bash
npm ci
npx playwright install chromium
npm run dev
npm run build
npm run build:container
npm run generate:metadata
npm run generate:og
npm run generate:csp
npm run generate:licenses
npm run check:og
npm run check:artifacts
npm run check:licenses
npm run audit:production
npm run generate:routes
npm run generate:source
npm run format
npm run format:check
npm run check
npm run typecheck
npm run lint
npm test
npm run serve:test
npm run test:e2e
npm run test:e2e:built
npm run e2e
npm run lighthouse
npm run lighthouse:built
npm run verify:origin
npm run verify:production
```

Install Chromium once on a clean development machine before `build`, `test:e2e`, or
`generate:og`. The container build does not install or launch a browser.

`build` validates the content and links, writes canonical metadata, performs the first prerender,
captures and validates the 1200×630 Open Graph image, performs the final prerender, and hashes
every shipped inline script into `dist/nginx-csp.conf`; the final artifact check rejects missing
generated output, then the build records a digest of its source inputs. `build:container` is the
non-interactive image-build path: it validates
the reviewed `public/og.png` and performs one final prerender without launching Playwright, which
is unavailable in the pinned Node Alpine build stage. The Dockerfile alone should call this path.
`serve:test` serves an existing `dist/client` tree. `test:e2e` builds before running Playwright;
`e2e` is its alias, while `test:e2e:built` audits an existing build. The `:built` commands reject
output whose recorded source digest is missing or stale. `lighthouse` also builds first; use
`lighthouse:built` to audit the existing output. `verify:origin` runs all checks that do not
require `SITE_URL`, including a production-dependency vulnerability audit;
`verify:production` is the strict build, browser, and Lighthouse gate.
The Lighthouse gate runs three desktop audits for each of six representative routes, writes HTML
and JSON reports to `.lighthouseci/reports`, applies median performance thresholds, and requires
every accessibility and critical audit run to pass.

`public/THIRD_PARTY_NOTICES.txt` contains the notices for JavaScript packages included in the
browser client. `npm run check:licenses` validates it against the exact versions, SPDX license
identifiers, and legal files installed by `package-lock.json`; regenerate it only with
`npm run generate:licenses`. Font licenses remain next to the font files under `public/fonts/`.

## Production origin

`SITE_URL` is required for production builds. It must be the real HTTPS origin with no path,
query, fragment, credentials, or fallback. `scripts/site.ts` validates the value once; sitemap,
robots, route metadata, and the Docker build consume that source.

The deploy image is built from `website/`:

```bash
docker build --build-arg SITE_URL="$SITE_URL" -f deploy/Dockerfile -t splitbrief-website:local .
```

Configure the Coolify application with:

- Source: this GitHub repository.
- Base Directory: `/website`.
- Build Pack: Dockerfile.
- Dockerfile Location: `/deploy/Dockerfile`, relative to the base directory.
- Port Exposes: `80`.
- Force HTTPS: on.
- Health check: `GET /` on port `80`.
- Environment Variables: add `SITE_URL` in Normal view with **Build Variable** enabled. Runtime
  Variable may be disabled because the origin is baked into static files.
- Port Mappings: empty, so Traefik owns ingress and TLS.
- Static-site mode and custom nginx overrides: disabled; the image owns nginx configuration.

Coolify passes build variables to Dockerfile deployments as `--build-arg`, which satisfies the
explicit `ARG SITE_URL`. Runtime-only variables are unavailable while static files are generated.
The value is public metadata, not a secret, so Build Secrets are unnecessary. Deploy after the
maintainer commits and pushes the complete website bundle, including `package-lock.json`; future
pushes can trigger rebuilds. See the
[Coolify environment-variable contract](https://coolify.io/docs/knowledge-base/environment-variables).

## Generated files

Fumadocs generates `.source/`, and TanStack Router generates `src/routeTree.gen.ts`. Both are
recreated by the documented commands and ignored by Git. `generate:source` is explicit so
dependency installation never tries to generate from source files that have not been copied yet.
Playwright `*-snapshots/` directories are reviewable baselines and remain tracked.
