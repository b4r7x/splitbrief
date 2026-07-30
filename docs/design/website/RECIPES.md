# SPLITBRIEF Website — Technical Recipes

Concrete shapes for the trickiest wiring, distilled from a working reference implementation (`~/Projects/diffgazer-workspace/apps/docs` — readable on this machine) and verified 2026-07-30 against the published package sources for the exact versions below. These are implementation skeletons, but their imports, option nesting, generated-collection paths, route IDs, and output paths are version-specific contracts. Change them only with fresh package-source evidence and record the delta.

## 0. Exact package pins

`website/package.json` uses exact versions—no `^` or `~`. This is the validated framework/build set:

```json
{
  "name": "splitbrief-website",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": "^22.12.0 || >=24.0.0"
  },
  "scripts": {
    "postinstall": "fumadocs-mdx",
    "dev": "vite",
    "routes": "node scripts/generate-route-tree.mjs",
    "generate:metadata": "tsx scripts/generate-metadata.ts",
    "generate:csp": "tsx scripts/generate-csp.ts",
    "check:links": "tsx scripts/check-links.ts",
    "build": "npm run generate:metadata && vite build && npm run generate:csp && npm run check:links",
    "typecheck": "npm run routes && tsc --noEmit",
    "test": "npm run routes && vitest run",
    "test:e2e": "npm run build && playwright test"
  },
  "dependencies": {
    "@tanstack/react-router": "1.170.18",
    "@tanstack/react-start": "1.168.33",
    "fumadocs-core": "16.13.0",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@axe-core/playwright": "4.12.1",
    "@biomejs/biome": "2.5.6",
    "@chialab/vitest-axe": "0.19.1",
    "@lhci/cli": "0.15.1",
    "@playwright/test": "1.62.0",
    "@tailwindcss/vite": "4.3.3",
    "@tanstack/router-generator": "1.167.21",
    "@testing-library/dom": "10.4.1",
    "@testing-library/jest-dom": "7.0.0",
    "@testing-library/react": "16.3.2",
    "@testing-library/user-event": "14.6.1",
    "@types/mdx": "2.0.14",
    "@types/node": "22.20.1",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    "@vitejs/plugin-react": "5.2.0",
    "axe-core": "4.12.1",
    "fumadocs-mdx": "15.2.0",
    "jsdom": "28.1.0",
    "tailwindcss": "4.3.3",
    "tsx": "4.23.1",
    "typescript": "6.0.3",
    "vite": "7.3.6",
    "vitest": "4.1.10",
    "yaml": "2.9.0"
  }
}
```

The website supports Node 22.12+ LTS and supported even-major Node releases; its engine range is `^22.12.0 || >=24.0.0`, deliberately excluding Node 23 in line with Vitest/jsdom support. `@tanstack/react-start@1.168.33` resolves `@tanstack/react-router@1.170.18`. Keep `@tanstack/router-generator@1.167.21` as a direct dev dependency because the non-Vite test/typecheck entry points invoke it. Do not add Nitro or `fumadocs-ui`.

## 1. `vite.config.ts` — plugin order + isVitest gating

```ts
import { fileURLToPath } from 'node:url'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'
import mdx from 'fumadocs-mdx/vite'
import { defineConfig } from 'vite'
import { prerenderPages } from './scripts/pages.js'

const isVitest = Boolean(process.env.VITEST)

export default defineConfig({
  plugins: [
    mdx(),                                // MUST come first; discovers and watches source.config.ts
    tailwindcss(),
    isVitest ? null : tanstackStart({
      router: {
        routeFileIgnorePattern: '\\.test\\.tsx$',
        addExtensions: 'js',
      },
      prerender: {
        enabled: true,
        autoStaticPathsDiscovery: false,
        autoSubfolderIndex: true,
        crawlLinks: false,
        failOnError: true,
      },
      pages: prerenderPages(),            // top-level sibling of prerender
      sitemap: { enabled: false },        // scripts/generate-metadata.ts owns sitemap.xml
    }),
    viteReact(),                          // React transforms are also required under Vitest
  ].filter(Boolean),
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      collections: fileURLToPath(new URL('./.source', import.meta.url)),
    },
  },
  build: { outDir: 'dist' },
  ...(isVitest ? { test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'] } } : {}),
})
```

Gotchas: `pages` is a top-level `tanstackStart()` option, not nested inside `prerender`. Both `autoStaticPathsDiscovery` and link crawling default on in this package line, so both are explicitly disabled to preserve the one-enumeration invariant. The list is evaluated when Vite parses config—`scripts/pages.ts` must not import build-generated code. `mdx()` receives no forced config object: that lets `fumadocs-mdx@15.2.0` discover and watch `source.config.ts`. The Start plugin alone is omitted under Vitest; the React plugin stays. Use the two explicit aliases above instead of `vite-tsconfig-paths@6.1.1`: its `tsconfck` dependency line lags TypeScript 6, and this app only needs two mappings. Keep those mappings identical in `tsconfig.json`. Do not add Nitro. Keep `routeFileIgnorePattern` and `addExtensions` byte-for-byte aligned with `scripts/generate-route-tree.mjs`.

## 2. `source.config.ts`

```ts
import { defineConfig, defineDocs, frontmatterSchema } from 'fumadocs-mdx/config'

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: frontmatterSchema,            // title, description — extend with zod if needed
    postprocess: { includeProcessedMarkdown: true },   // REQUIRED for get-llm-text / md mirrors
  },
})

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      themes: { dark: splitbriefDark, light: splitbriefLight },  // TWO custom TextMate themes built
      defaultColor: false,                                        // from DIRECTION tokens — stock themes banned
    },
  },
})
```

The custom shiki themes are plain TextMate JSON objects: silkscreen base, planner-magenta (text tone `#E85FA8`) for keys/keywords, implementer-cyan for strings/values, AA-passing dim tier for comments; light theme uses the re-toned text accents (`#A01A67` / `#0B5E66`).

`tsconfig.json` maps the generated files directly:

```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"],
      "collections/*": ["./.source/*"]
    }
  }
}
```

The `postinstall` command and Vite plugin generate `.source/server.ts`, `.source/browser.ts`, and `.source/dynamic.ts`. Keep the entire `.source/` directory gitignored. The v14-era `fumadocs-mdx:collections/*` alias is wrong for this pin.

## 3. Router shell + source loader + doc route

`getRouter()` creates a fresh instance, and the current Start root shape uses `shellComponent`:

```tsx
// src/router.tsx
import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen.js'

export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: 'intent',
    scrollRestoration: true,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
```

```tsx
// src/routes/__root.tsx
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { TanstackProvider } from 'fumadocs-core/framework/tanstack'
import type { ReactNode } from 'react'

export const Route = createRootRoute({
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <TanstackProvider>{children}</TanstackProvider>
        <Scripts />
      </body>
    </html>
  )
}
```

Add the font preloads, global SEO metadata, stylesheet, and pre-paint docs-theme script through the route's `head` configuration; keep the shell structure above. The initializer reads only the allowlisted values `dark|light` from `splitbrief-docs-theme`, applies them only when the pathname is `/docs` or starts with `/docs/`, and forces dark outside that scope. It mutates `data-theme` before hydration, which is why the root `<html>` has `suppressHydrationWarning`; the theme toggle itself must keep server and first-client markup stable rather than relying on that root-level escape hatch for descendants. The post-build CSP generator hashes this inline initializer together with TanStack's own inline bootstrap scripts. This uses the headless provider from `fumadocs-core`, not the `fumadocs-ui` provider.

```ts
// src/lib/source.ts (this is genuinely the whole file)
import { docs } from 'collections/server'
import { loader } from 'fumadocs-core/source'

export const source = loader({ baseUrl: '/docs', source: docs.toFumadocsSource() })
```

Never import `docs` from `source.config.ts`; that file declares compile-time collections. Runtime data comes from generated `.source` entries through `collections/server` and `collections/browser`.

The doc route uses the generated browser collection for lazy MDX:

```tsx
// src/routes/docs/$.tsx
import { createFileRoute, notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import browserCollections from 'collections/browser'
import { source } from '../../lib/source.js'

const loadDoc = createServerFn({ method: 'GET' })
  .validator((slugs: string[]) => slugs)
  .handler(({ data: slugs }) => {
    const page = source.getPage(slugs)
    if (!page) throw notFound()

    return {
      path: page.path,
      title: page.data.title,
      description: page.data.description,
      toc: page.data.toc,
    }
  })

const clientLoader = browserCollections.docs.createClientLoader({
  component({ default: MDX }) {
    return <MDX />
  },
})

export const Route = createFileRoute('/docs/$')({
  loader: async ({ params }) => {
    const data = await loadDoc({ data: params._splat?.split('/') ?? [] })
    await clientLoader.preload(data.path)
    return data
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData?.title },
      { name: 'description', content: loaderData?.description },
    ],
  }),
  component: DocPage,
  pendingMs: 150,
  staleTime: Infinity,
})

function DocPage() {
  const data = Route.useLoaderData()
  return clientLoader.useContent(data.path)
}
```

The real `clientLoader.component` composes the docs shell and passes the project MDX component map; the snippet only fixes the data boundary. `routes/docs/index.tsx` remains a development-parity redirect to the first page. Do not add `/docs` to `prerenderPages()`—the static harness and production server own that redirect.

## 4. llms + markdown mirrors + search (server-route GET handlers, prerendered)

There is NO `render: 'static'` option anywhere. The mechanism: each of these is a **server route with a GET handler**, and it becomes static because its path is in the prerender `pages` list.

- `/llms.txt` — index built from `source` (fumadocs `llms()` helper if exported by installed version, else walk `source.getPages()` yourself): blockquote summary + absolute links (from `SITE_URL`), keep ≤5KB.
- `/llms-full.txt` — concatenation of every page's markdown with `---` separators.
- `/docs/<slug>.md` mirrors — the exact filename is `src/routes/docs/{$}[.]md.ts` and the exact route ID is `/docs/{$}.md`. A dot-escaped `docs.md` directory followed by a wildcard would generate the wrong `/docs.md/*` URL family.
- `/api/search` — current static Orama: `createFromSource(source)` from `fumadocs-core/search/server`; the handler returns `server.staticGET()`. The client passes `oramaStaticClient()` from `fumadocs-core/search/client/orama-static` to `useDocsSearch()` from `fumadocs-core/search/client`. The static client caches the downloaded index and searches in-browser.

```ts
// src/routes/docs/{$}[.]md.ts
import { createFileRoute } from '@tanstack/react-router'
import { getLLMText } from '../../lib/get-llm-text.js'
import { source } from '../../lib/source.js'

export const Route = createFileRoute('/docs/{$}.md')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const slugPath = (params['_splat'] ?? '').replace(/\.md$/, '')
        const page = source.getPage(slugPath.split('/').filter(Boolean))

        if (!page) return new Response('Document not found', { status: 404 })

        return new Response(await getLLMText(page), {
          headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
        })
      },
    },
  },
})
```

`getLLMText` is a local helper, not a package export. It reads the processed markdown enabled by `includeProcessedMarkdown`, then prepends the page title and description.

```ts
// src/routes/api/search.ts
import { createFileRoute } from '@tanstack/react-router'
import { createFromSource } from 'fumadocs-core/search/server'
import { source } from '../../lib/source.js'

const searchServer = createFromSource(source)

export const Route = createFileRoute('/api/search')({
  server: {
    handlers: {
      GET: () => searchServer.staticGET(),
    },
  },
})
```

```ts
// inside the headless search UI module
import { useDocsSearch } from 'fumadocs-core/search/client'
import { oramaStaticClient } from 'fumadocs-core/search/client/orama-static'

const searchClient = oramaStaticClient({ search: { limit: 16 } })

export function useSearchResults() {
  return useDocsSearch({ client: searchClient, delayMs: 150 })
}
```

Render explicit loading, error, empty, and success states from `query`; do not rebuild fetching, cancellation, or debouncing around the official hook.

## 5. `scripts/pages.ts` — the single enumeration

```ts
export type PageKind = 'page' | 'md-mirror' | 'metadata'
export interface SitePage {
  path: string
  kind: PageKind
  prerender?: { outputPath: string }
}

const FIXED_PAGES = [
  { path: '/', kind: 'page' },
  { path: '/llms.txt', kind: 'metadata' },
  { path: '/llms-full.txt', kind: 'metadata' },
  { path: '/api/search', kind: 'metadata' },
  { path: '/og', kind: 'metadata' },
  {
    path: '/404',
    kind: 'metadata',
    prerender: { outputPath: '/404.html' },
  },
] satisfies SitePage[]

// Add FIXED_PAGES to one content/docs walk that emits every '/docs/<slug>' page
// and its '/docs/<slug>.md' mirror. Deliberately do not add '/docs':
// the static-server harness and production server own that redirect.
export function sitePages(): SitePage[] { /* one walk, no duplicates */ }

export function prerenderPages() {
  return sitePages().map(({ path, prerender }) => ({
    path,
    ...(prerender ? { prerender } : {}),
  }))
}
```

Consumers: Vite prerender (all kinds) · `generate-metadata.ts` sitemap (`kind === 'page'` only) · `check-links.ts` (membership check against all kinds). The explicit `/404.html` override is necessary because global `autoSubfolderIndex: true` would otherwise emit `404/index.html`. The link checker is ~150 lines in the reference and near copy-paste: regex `[x](href)` + `href="…"` out of every MDX file, resolve relative hrefs via `new URL(href, SITE_URL + routePath)`, assert membership, print `file:line href -> resolved`, exit 1.

With `build.outDir: 'dist'`, Start emits the deployable tree under `dist/client` and its build-time prerender server under `dist/server`. Expected deployable shapes:

```text
dist/client/
├── index.html
├── 404.html
├── docs/<slug>/index.html
├── docs/<slug>.md
├── llms.txt
├── llms-full.txt
├── api/search
├── og/index.html
└── assets/*
```

Deploy only `dist/client`; `dist/server/server.js` and its chunks exist to execute the build/prerender and are not runtime hosting artifacts.

## 6. Design tokens — CSS skeleton (values are the DIRECTION contract)

```css
:root, [data-theme='dark'] {
  --ground: #0B0B0D; --surface-1: #141416; --surface-2: #1E1E21;
  --fg: #E8E6E1;
  --grid-decorative: #2A2A2E;  /* hairline texture only — AA-exempt by rule */
  --grid-functional: #6E6E76;  /* cell boundaries, jack outlines — >=3:1 on surface-2 */
  --planner: #E0409A;          /* non-text only on surface-2 */
  --planner-text: #E85FA8;     /* magenta at text sizes */
  --implementer: #3FD2E0;
  --pin: #C9A26B;              /* the seated pin ONLY */
  --focus: var(--fg);
  --wash-crosshair: color-mix(in oklab, var(--planner) 8%, transparent); /* sole wash */
}
[data-theme='light'] {  /* docs only — re-toned, never inverted; worst case = darkest step */
  --ground: #E8E6E1; --surface-1: #DDDBD6; --surface-2: #D2D0CB;
  --fg: #1A1A1C; --dim: #55554F;
  --grid-decorative: #D2D0CB; --grid-functional: #6E6E68;
  --planner: #B01D72; --planner-text: #B01D72; /* darken toward #A01A67 on stepped surfaces */
  --implementer: #0B5E66;
  --pin: #7A5F33;
  --focus: #1A1A1C;
}
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
```

Type: `--display: 'Archivo'` (variable, `wdth` axis retained — legends use `font-stretch: expanded`), `--body: 'Instrument Sans'`, `--mono: 'Fragment Mono'`; preload display+mono woff2 in `__root` head. Get variable woff2s from the google/fonts GitHub repo (OFL files alongside); subset to latin (pyftsubset `--flavor=woff2 --unicodes=U+0000-00FF,U+2013-2014,U+2018-201D,U+2022,U+00D7` — keep `×` U+00D7, it's in the pairing names).

## 7. The matrix — semantics skeleton

```
<table role="grid" aria-label="Planner × implementer pairings">
  thead: <th role="columnheader"> per implementer jack
  tbody rows: <th role="rowheader" scope="row"> planner jack
              <td role="gridcell" tabindex={active ? 0 : -1} aria-selected={seated}>
```

Roving tabindex across gridcells (arrows/Home/End; Enter/Space seats). Seat action: update `aria-selected`, run the pulse (row → pin → column, ~400ms, skipped under `prefers-reduced-motion`), swap YAML from `pairings.ts`, announce via visually-hidden `role="status"`: "Config updated: claude-code × ollama". YAML frame: plain region + copy button (never `aria-live`). Under 700px render the picker instead: two `role="radiogroup"`s (Planner / Implementer), `aria-checked` + brass dot on current, selections independent, same status announcer + YAML below.

`pairings.ts`: one typed map `{ [plannerJack]: { [implementerJack]: string } }` where every value is complete YAML (`version: 3` + both blocks), keys per `docs/CONFIGURATION.md`: cli → `tool:`; api → `provider:` + `apiBase:` + an explicit current `model:`; agent-sdk per its schema. `model: auto` is forbidden in every hero document. P3 gates validate all 36 fragments against the source schema and CONTENT.md's dated model provenance.

## 8. Coolify deploy — Dockerfile + nginx.conf

Hosting is **Coolify on a Hostinger VPS**. The static+Nixpacks pack cannot take this nginx contract, so the app uses the **Dockerfile build pack** with Base Directory `/website` and Dockerfile Location `/deploy/Dockerfile`. Coolify's Traefik terminates TLS and routes the domain; the container listens on port 80.

### 8.1 Build the CSP from the built HTML

TanStack emits inline hydration/bootstrap scripts, and the docs theme initializer is inline so it can run before paint. Therefore `script-src 'self'` alone breaks the shipped app, while a fixed nonce is not a nonce at all. Hash the exact built script bytes on every build:

```ts
// scripts/generate-csp.ts
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { OUTPUT_DIR } from './site.js'

const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
const CSP_INCLUDE_PATH = resolve('dist/nginx-csp.conf')

async function collectHtmlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return collectHtmlFiles(path)
      return entry.isFile() && entry.name.endsWith('.html') ? [path] : []
    }),
  )
  return paths.flat()
}

const hashes = new Set<string>()
for (const path of await collectHtmlFiles(resolve(OUTPUT_DIR))) {
  const html = await readFile(path, 'utf8')
  for (const match of html.matchAll(INLINE_SCRIPT)) {
    const [, attributes, source] = match
    if (/\bsrc\s*=/i.test(attributes) || source.trim().length === 0) continue

    const digest = createHash('sha256').update(source).digest('base64')
    hashes.add(`'sha256-${digest}'`)
  }
}

const scriptSources = ["'self'", ...[...hashes].sort()].join(' ')
const policy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'none'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `script-src ${scriptSources}`,
  "script-src-attr 'none'",
].join('; ')

await writeFile(
  CSP_INCLUDE_PATH,
  `add_header Content-Security-Policy "${policy}" always;\n`,
)
process.stdout.write(`CSP: ${hashes.size} inline script hashes\n`)
```

This script runs after `vite build`, never before it. A unit test builds representative HTML fixtures, recalculates every inline-script hash, and proves the generated include contains the complete sorted set while ignoring empty and `src` scripts. The P7 browser gate is the integration proof: zero `securitypolicyviolation` events while hydration, the theme toggle, matrix, and search all work. `style-src 'unsafe-inline'` is intentionally limited to styles; `script-src 'unsafe-inline'` is forbidden.

### 8.2 Image

The image pins its build and serving bases deliberately. Refresh them only with a reviewed dependency update:

```dockerfile
FROM node:22.23.1-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN test -f dist/client/index.html && test -f dist/nginx-csp.conf
RUN find dist/client -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' \
    -o -name '*.svg' -o -name '*.json' -o -name '*.txt' -o -name '*.xml' -o -name '*.md' \
    -o -path '*/api/search' \) \
    -exec sh -c 'for file in "$@"; do gzip -9 -k -f "$file"; touch -r "$file" "$file.gz"; done' sh {} +

FROM nginx:1.29.8-alpine3.23
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/nginx-csp.conf /etc/nginx/conf.d/splitbrief-csp.inc
COPY --from=build /app/dist/client /usr/share/nginx/html
EXPOSE 80
```

`website/.dockerignore` is required because the build context is all of `website/`: `node_modules`, `dist`, `.source`, `.test-artifacts`, `coverage`, `playwright-report`, and `*-snapshots`. The explicit lockfile `COPY` makes a missing `website/package-lock.json` fail immediately. Precompression includes Markdown mirrors and the extensionless search payload; `touch -r` satisfies `gzip_static`'s source/compressed-mtime contract.

### 8.3 nginx

The cache policy is one server-level header selected by an HTTP-scope map. This matters: a location-level `add_header Cache-Control` would suppress every inherited security `add_header` in that location. Only a Vite hash-shaped asset URL gets `immutable`; an un-hashed file under `/assets/` safely falls back to revalidation.

```nginx
map $uri $splitbrief_cache_control {
  default "public, max-age=0, must-revalidate";
  "~^/assets/[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$" "public, max-age=31536000, immutable";
}

server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;
  absolute_redirect off;
  server_tokens off;

  root /usr/share/nginx/html;
  index index.html;
  charset utf-8;
  charset_types text/html text/plain text/css text/markdown application/javascript application/json application/xml image/svg+xml;

  add_header Cache-Control $splitbrief_cache_control always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header X-Frame-Options "DENY" always;
  add_header Cross-Origin-Opener-Policy "same-origin" always;
  add_header Permissions-Policy "accelerometer=(), autoplay=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()" always;
  include /etc/nginx/conf.d/splitbrief-csp.inc;

  gzip_static on;
  gzip on;
  gzip_vary on;
  gzip_proxied any;
  gzip_min_length 256;
  gzip_comp_level 6;
  gzip_types text/plain text/css text/markdown application/javascript application/json application/xml image/svg+xml;

  location = /docs {
    return 301 /docs/getting-started/introduction;
  }

  location ^~ /api/ {
    default_type application/json;
    try_files $uri =404;
  }

  location ~ \.md$ {
    default_type text/markdown;
    try_files $uri =404;
  }

  location ^~ /assets/ {
    try_files $uri =404;
  }

  location / {
    try_files $uri.html $uri/index.html $uri =404;
  }

  error_page 404 =404 /404.html;
}
```

The `try_files`, Markdown/API MIME overrides, and `/404.html` target above depend on the output shapes verified in P1/P4. If the installed framework emits a different real tree, update this configuration from that evidence before running P7; do not add SPA fallback or silently serve `index.html` for missing routes. `absolute_redirect off` keeps `/docs` relative behind TLS-terminating Traefik and avoids an internal `http://` redirect. There is no brotli directive because the official image lacks that module.

### 8.4 Local and Coolify gates

From `website/`, with Docker running:

```bash
set -euo pipefail

npm ci
npm run build
test -f dist/client/index.html
test -f dist/client/404.html
test -f dist/client/api/search
test -f dist/nginx-csp.conf
test ! -e .output/public
! rg -n "script-src[^;]*'unsafe-inline'" dist/nginx-csp.conf

docker build --pull -f deploy/Dockerfile -t splitbrief-website:local .
docker run --rm splitbrief-website:local nginx -t
docker run --rm splitbrief-website:local nginx -V 2>&1 | rg -- '--with-http_gzip_static_module'
docker run --rm splitbrief-website:local sh -c 'test -f /usr/share/nginx/html/api/search.gz'
docker run --rm splitbrief-website:local sh -c 'find /usr/share/nginx/html/docs -type f -name "*.md.gz" -print -quit | grep -q .'
splitbrief_container=$(docker run -d --rm -p 127.0.0.1:8080:80 splitbrief-website:local)
trap 'docker stop "$splitbrief_container" >/dev/null' EXIT
```

Use `http://127.0.0.1:8080` as the local origin. The automated assertions must cover:

- `/docs` is exactly `301` with `Location: /docs/getting-started/introduction`, then resolves to `200` without a redirect loop.
- An unknown route is `404` and renders the token-styled 404 body.
- `/`, one hashed JS asset, `/api/search`, `/docs`, and the 404 response all carry CSP, nosniff, referrer policy, frame protection, COOP, permissions policy, and the one cache header.
- Only a hash-shaped `/assets/*` response is `public, max-age=31536000, immutable`; HTML, API, redirects, metadata, Markdown, and errors are `public, max-age=0, must-revalidate`.
- The search payload is JSON and a mirror is `text/markdown`, both under `nosniff`.
- Requests with `Accept-Encoding: gzip` return `Content-Encoding: gzip` and `Vary: Accept-Encoding` for JS, a Markdown mirror, and `/api/search`; requests without it remain unencoded.
- `sitemap.xml`, `llms.txt`, and `llms-full.txt` are reachable.
- Playwright, pointed at the nginx origin, records `securitypolicyviolation`, console errors, and page errors and fails on any event while it exercises a matrix selection, docs theme toggle + reload persistence, and search. Curl alone cannot prove CSP-compatible hydration.

The curl half is directly reproducible:

```bash
splitbrief_origin=http://127.0.0.1:8080
for splitbrief_attempt in $(seq 1 30); do
  curl -fsS "$splitbrief_origin/" >/dev/null && break
  sleep 1
done
curl -fsS "$splitbrief_origin/" >/dev/null

splitbrief_asset_file=$(find dist/client/assets -type f -name '*.js' -print -quit)
test -n "$splitbrief_asset_file"
splitbrief_asset="/${splitbrief_asset_file#dist/client/}"

splitbrief_headers() {
  curl -sS -D - -o /dev/null "$splitbrief_origin$1" | tr -d '\r'
}

for splitbrief_path in / "$splitbrief_asset" /api/search /docs /definitely-not-a-route; do
  splitbrief_response_headers=$(splitbrief_headers "$splitbrief_path")
  for splitbrief_header in \
    content-security-policy \
    x-content-type-options \
    referrer-policy \
    x-frame-options \
    cross-origin-opener-policy \
    permissions-policy \
    cache-control
  do
    rg -qi "^${splitbrief_header}:" <<<"$splitbrief_response_headers"
  done
done

test "$(curl -sS -o /dev/null -w '%{http_code}' "$splitbrief_origin/docs")" = 301
splitbrief_headers /docs | rg -qi '^location: /docs/getting-started/introduction$'
test "$(curl -sS -L --max-redirs 1 -o /dev/null -w '%{http_code}' \
  "$splitbrief_origin/docs")" = 200
test "$(curl -sS -o /dev/null -w '%{http_code}' "$splitbrief_origin/definitely-not-a-route")" = 404

splitbrief_headers "$splitbrief_asset" |
  rg -qi '^cache-control: public, max-age=31536000, immutable$'
splitbrief_headers / |
  rg -qi '^cache-control: public, max-age=0, must-revalidate$'
splitbrief_headers /definitely-not-a-route |
  rg -qi '^cache-control: public, max-age=0, must-revalidate$'

splitbrief_headers /api/search | rg -qi '^content-type: application/json'
splitbrief_headers /docs/getting-started/introduction.md |
  rg -qi '^content-type: text/markdown'

for splitbrief_path in \
  "$splitbrief_asset" \
  /docs/getting-started/introduction.md \
  /api/search
do
  ! splitbrief_headers "$splitbrief_path" | rg -qi '^content-encoding:'
  curl -sS -D - -o /dev/null -H 'Accept-Encoding: gzip' "$splitbrief_origin$splitbrief_path" |
    tr -d '\r' |
    rg -qi '^content-encoding: gzip$'
  curl -sS -D - -o /dev/null -H 'Accept-Encoding: gzip' "$splitbrief_origin$splitbrief_path" |
    tr -d '\r' |
    rg -qi '^vary: Accept-Encoding$'
done

curl -fsS "$splitbrief_origin/sitemap.xml" >/dev/null
curl -fsS "$splitbrief_origin/llms.txt" >/dev/null
curl -fsS "$splitbrief_origin/llms-full.txt" >/dev/null

docker stop "$splitbrief_container"
trap - EXIT
```

If Docker is unavailable, record the failed `docker info` output. The static harness can prove files and application behavior, but it cannot verify nginx syntax, header inheritance, `gzip_static`, proxy-relative redirects, or CSP delivery, so those P7 rows remain open.

Coolify handoff, using the UI's path form exactly:

- Source: the GitHub repository.
- Base Directory: `/website`.
- Build Pack: Dockerfile.
- Dockerfile Location: `/deploy/Dockerfile` relative to the base directory.
- Port Exposes: `80`; no host Port Mapping.
- Force HTTPS: enabled.
- Health check: `GET /`, port `80`, expected `200`.
- Static-site toggle: off; no custom nginx override in Coolify.
- Domain: the host from the maintainer-supplied `SITE_URL`; do not invent one or choose a `www` redirect policy before that value exists.

After the first live HTTPS deploy, the maintainer repeats the header/CSP/gzip/Lighthouse gates and then decides whether to add HSTS. Never infer `includeSubDomains` or preload eligibility from the application hostname alone.

## 9. Testing wiring

- `playwright.config.ts`: `webServer` = the small production-parity Node static harness over `dist/client`; it owns the `/docs` 301 to the first docs URL and otherwise serves the exact file shapes above. Do not prerender `/docs` just to accommodate the test server. Do not use `vite preview` or anything referencing `.output/public`. Set `reducedMotion: 'reduce'`; projects: `chromium` (all specs + `toHaveScreenshot` baselines, `maxDiffPixelRatio: 0.01`, animations disabled, dark scheme) and `mobile-chromium` (Pixel-class) with an **opt-in `testMatch` allowlist** so desktop specs never silently join the mobile run.
- e2e coverage floor: matrix keyboard contract (arrows/Enter/aria-selected/status announcement), picker at 390px, axe scan per applicable theme (landing dark; docs dark+light), `/docs` returns the harness-owned redirect and its target resolves, llms.txt + one `.md` mirror + `/api/search` payload served from the build, one visual baseline per surface.
- `scripts/generate-route-tree.mjs` uses the exact package API and the same router options as Vite:

```js
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Generator, getConfig } from '@tanstack/router-generator'

const websiteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = getConfig(
  {
    routeFileIgnorePattern: '\\.test\\.tsx$',
    addExtensions: 'js',
    routeTreeFileFooter: [
      `import type { getRouter } from './router.tsx'
import type { createStart } from '@tanstack/react-start'
declare module '@tanstack/react-start' {
  interface Register {
    ssr: true
    router: Awaited<ReturnType<typeof getRouter>>
  }
}`,
    ],
  },
  websiteRoot,
)
const generator = new Generator({ config, root: websiteRoot })

await generator.run()
```

Run this before `test` and `typecheck` because `routeTree.gen.ts` is gitignored.
The type-only `./router.tsx` import mirrors Start's native footer exactly; runtime route imports
still use `.js` through `addExtensions`.
- `lighthouserc.json` budgets: perf ≥0.90, a11y ≥0.95, FCP ≤2000, LCP ≤2500, CLS ≤0.1, TBT ≤300; `color-contrast`/`heading-order`/`errors-in-console` = error; desktop preset.

## 10. OG + 404 generation

`routes/og.tsx`: a token-styled 1200×630 card (ground, wordmark legend, matrix motif, headline) — excluded from sitemap. `scripts/generate-og.ts`: Playwright opens `/og` and `page.screenshot({ clip: 1200×630 })` → `public/og.png`, using the decided two-pass at P6: build → serve `OUTPUT_DIR` → screenshot → final build ships the png (the source of truth stays the token CSS; the png is left unstaged like everything else). The token-styled 404 route is enumerated as `{ path: '/404', kind: 'metadata', prerender: { outputPath: '/404.html' } }`, which guarantees `dist/client/404.html` even while other HTML uses subfolder indexes.
