# SPLITBRIEF Website — Master Spec (context & assumptions)

This file exists so that an agent with **zero prior context** understands everything behind the bundle. Nothing here requires access to the planning conversation. Read order for the whole bundle: `SPEC.md` (this file) → `DIRECTION.md` → `CONTENT.md` → `PLAN.md` → `RECIPES.md` → `SKILLS.md`; `KICKOFF.md` is the compressed entry prompt.

## 1. What is being built, in one paragraph

A public website for SPLITBRIEF: a creative, distinctive landing page at `/` and a 32-page documentation site at `/docs/*`, built as ONE TanStack Start app in `website/` inside this repo, prerendered to pure static files, deployed via Coolify on the maintainer's Hostinger VPS (Dockerfile: nginx serving the build). The design direction is "The Pin Matrix" (see §5 and `DIRECTION.md`). The site launches with an honest, source-only `InstallBlock`; a future npm install is a separately reviewed content change, not a dormant mode.

## 2. The product (what SPLITBRIEF actually is)

SPLITBRIEF is an open-source terminal app (Ink 6 / React 19 TUI, Node 22+, MIT, macOS/Linux) that splits AI-assisted coding into exactly two roles:

- A **planner** — a supported CLI, API, or agent runner (for example Claude Code, Codex, Anthropic API, or Agent SDK) — researches the repo and compiles the user's request into **Task Briefs**.
- An **implementer** — a supported runner, including local models through Ollama or LM Studio and configured APIs such as DeepSeek or Groq — executes one brief at a time.

The **Task Brief** is the product's central artifact: a nine-section semantic contract (Identity, Intent, Scope, Code Context, Implementation Plan, Validation, Constraints, Escalation, Evidence — see `docs/TASK-CONTRACT.md`), stored on disk, human-reviewable and editable mid-run, quality-gated by a deterministic checker before any code is written, and drift-checked against the final diff afterward. It exists in three forms, all real: `state.json` (stable JSON, `state.tasks[]`), the **`tasks.md` markdown transport** (YAML frontmatter `id/title/action/file/depends_on` + `### …` section headings — the artifact users review at the approval gate), and the **rendered implementer prompt** (`## Task: <title>` with `### Action:` / `### File:` / `### Description`… headings, no frontmatter — `src/engine/spec/prompt-formatter.ts`). Site excerpts must reproduce one of these forms exactly, never a blend (see DIRECTION real-artifact rules).

The orchestrator between the two roles owns: validation per task (`typecheck → lint → test`, polyglot), 3 retries, 3 escalation tiers (intermediate model → planner hint → planner takeover), recovery actions, tiered approval gates (spec, plan, briefs, cost, per-file-write auto/sticky/confirm), hash-guarded snapshots with `/accept-run` `/reject-run`, deterministic drift reports, an evidence ledger, sessions with detach/attach/resume, git worktrees, headless `--json`/`--rpc` modes, an MCP server, hooks, and a tree-sitter+PageRank repo map.

Both roles accept five supported, interchangeable **runner kinds** — `cli` (six built-in tool IDs), `api` (configured OpenAI-compatible endpoints plus Anthropic), `shell`, `agent`, and `agent-sdk` — with `kind:` as the config discriminant (`version: 3` configs; full schemas in `docs/CONFIGURATION.md`). The site labels the nominal **pre-build planning calls** for `instant` / `quick` / `standard` / `speckit` as **1 / 1 / 4 / 5–6**. Final review adds one planner call to every successful mode; regeneration, continuation, estimate review, retries, or escalation may add more. The TUI's phase rail renders **`Spec › Plan › Briefs → Build → Verify`** (lowercase `RAIL_STAGES` tokens in `src/features/workflow/layout/chrome-rows.ts`, title-cased by `src/core/phase-display.ts`, joined by the `›`/`→` connector glyphs from `src/lib/glyphs.ts`).

Product visual identity (the site agrees with the design language, not with literal terminal output): near-black stepped grounds instead of borders — the doctrine is stated in `docs/VISION.md` (`#0a0a0a → #141414 → #1e1e1e`; `theme.tsx` panels use `#1a1a1a`, the HTML report export uses the doctrine hexes); a **planner/implementer two-color duality** — the TUI's `terminalTheme` uses named ANSI `magenta`/`cyan` (actual hue depends on the user's terminal; the `monoTheme` preset maps the same roles to violet/light-blue), so the site's magenta/cyan tokens are the site's own fixed rendering of that duality, not copied hexes; figlet "Splitbrief" wordmark (`src/features/home/logo.ts`); bordered composer `> Describe your feature…`; braille spinners; one straight phase rail rendered `Spec › Plan › Briefs → Build → Verify`. Naming: SPLITBRIEF in prose, `splitbrief` as binary/package. The repository directory still uses a prior machine identity, and the product previously used a retired display identity — a CI brand gate (`scripts/check-brand.ts`) bans both, and **all pre-existing visual assets (design PNGs, gallery frames) carry the retired display identity and must be regenerated before use**.

Honest project state: version 0.1.0, **not yet published to npm** (install, complete: `git clone https://github.com/b4r7x/splitbrief.git && cd splitbrief && npm install && npm run build && npm link`), no Windows support, no published benchmarks (so no numeric savings claims are usable anywhere).

## 3. Positioning — and the history behind it (important)

The product's own docs often lead with cost ("cost-aware task compiler", savings stats in the TUI). During planning the maintainer **explicitly rejected** selling the site on "you'll implement cheaply". Verbatim intent, translated: *"I don't want to sell this as 'cheap implementation' but as 'connect two tools or APIs for implementation' — and this must run globally through the whole app."* Cost matters to them as a driver but they wanted it minimized in marketing; they delegated the exact balance, and the decided rule is:

- **Thesis (everywhere, globally):** SPLITBRIEF pairs a supported planner runner with a supported implementer runner; the Task Brief is the contract between them. Composition, control, auditability.
- **Cost = whisper:** on the landing exactly one quiet sentence ("You pay for the thinking once."); no percentages, no "cheap", no price-first headlines. Docs may discuss cost properly (a Cost management guide exists in the IA). Content-faithful imports retain their voice while accepting narrow, verified factual corrections.

Why this is also strategically right: the audience (developers already using AI coding agents) is hype-allergic and will verify artifacts; the product's voice already includes honesty guarantees ("SPLITBRIEF never invents fake savings"); and the supported-runner composition plus contract-artifact story is more credible than a broad connector promise, while "cheaper AI coding" is a crowded, low-credibility claim.

## 4. Decision log (all confirmed with the maintainer, 2026-07-30)

| # | Decision | Chosen | Rejected & why |
|---|---|---|---|
| 1 | Where the site lives | `website/` folder in this repo, self-contained package (own package.json + lockfile), excluded from root CI gates | npm-workspace conversion (structural churn on a 1500-file repo); separate repo (docs drift, two-PR updates) |
| 2 | App shape | ONE TanStack Start app: landing `/` + docs `/docs/*`, all prerendered | Two apps like the reference site (its landing was framework-free vanilla; unnecessary split here — one identity, one build, one deploy) |
| 3 | Positioning | Interop-first, cost as whisper (see §3) | Cost-first framing (maintainer veto); equal two pillars (blurry message) |
| 4 | Creative direction | **The Pin Matrix** (see §5) | Seven other directions (see §5) |
| 5 | Docs UI | Headless `fumadocs-core` + fully custom UI | `fumadocs-ui` theme (recognizable template; identity would end at colors; deep customization fights its Base UI internals) |
| 6 | Docs scope | Full IA 32 pages from day 1, hand-authored MDX in `website/content` (curated, no auto-sync from `docs/*.md`) | 12-page MVP (site would look immature; most content is rewriting existing well-toned docs anyway) |
| 7 | Deployment | Maintainer's Hostinger VPS running **Coolify**: Dockerfile build pack (nginx:alpine + our nginx.conf, base directory `website/`), Traefik/SSL handled by Coolify | Cloudflare/GH Pages/Vercel (maintainer preference: own VPS); Coolify static+Nixpacks pack (cannot take a custom nginx config, which headers + the /docs 301 require); raw rsync+vhost (superseded by Coolify) |
| 8 | Launch CTA | Honest source-only `InstallBlock`; npm can replace it in a separately reviewed change after publication | A dormant source/npm switch; waiting for npm before launch; GitHub-only CTA |
| 9 | Quality toolchain | Full set: single page enumeration → prerender+sitemap+link-check; llms.txt/llms-full.txt/per-page .md mirrors; Lighthouse budgets; axe + Playwright e2e on built output; visual baselines; OG/robots/404; Dockerfile+nginx (Coolify) | Minimal/staged variants. Explicitly skipped: CSP-nonce pipeline (static hosting → headers via nginx) and the reference site's artifact-sync machinery (product-specific) |

Also fixed by repo rules: the implementer **never commits/stages anything** (hook-enforced; maintainer commits manually).

## 5. Creative history — what was explored and why Pin Matrix won

Two divergence waves produced eight genuinely different directions (all interop-checked after the positioning pivot):

- **Wave 1 (pre-pivot, cost-framed):** Datasheet (engineering spec-sheet, cost ratings table hero) · The Printed Brief (print-proof folio of a brief, blue-pencil planner annotations) · Computing Center 1978 (green-bar timesharing job-accounting printout) · Exposed Pipeline (white brutalism, box-drawing state machine) · The Split (page bisected by a seam the brief crosses).
- **Pivot:** the maintainer's interop-first correction killed the cost-framed hearts. *Computing Center 1978 died* (its soul was billing). The other four were re-cut: Datasheet's hero became a brief pin-out; Printed Brief gained a counter-signature block (two machine signatories); Exposed Pipeline gained swappable end-sockets on the state machine; The Split re-argued its palette from brass/green to the product's magenta/cyan.
- **Wave 2 (interop-native):** The Pin Matrix (EMS Synthi pin-matrix patch field, 1969) · Corner Casting (ISO 668 shipping-container standardization; the brief as the standardized box) · Interlocking (British railway signalling; gates as signals).

**Winner: The Pin Matrix**, chosen by the maintainer from the final four (Pin Matrix, The Split re-cut, Interlocking, Corner Casting). Judge's reasoning, recorded: it turns supported kind-to-kind composition into an interactive object; it carries the product's planner/implementer color duality so the site agrees with the TUI's design language (a credibility artifact for a skeptical audience; see §2 — the tokens are the site's own rendering of that duality, not copied hexes); the hero emits real copy-paste-runnable YAML (proof-in-hero beats metaphor); the 1969 EMS Synthi world is precise and ownable; it is feasible in HTML/CSS/light JS. Runner-up (The Split) and the operational fallback (Exposed Pipeline, maintainer-triggered only) are recorded in `DIRECTION.md`.

Named cliché lanes that are BANNED (they are the statistical defaults of AI-generated landings; full list in `DIRECTION.md` gate): the Linear default (navy + blue/purple gradient aura + glass cards), the indigo slop stack, the tasteful-cream + editorial serif + terracotta counterslop, the acid-green broadsheet, emoji feature icons, fake-typing terminal chrome as the only idea, "supercharge/10x/seamless" copy.

## 6. Research digest — lessons the plan is built on

**Reference site** (`~/Projects/diffgazer-workspace`, the maintainer's earlier project; landing + docs for a code-review tool — the direct inspiration for this work):

- *Worth replicating (proven there):* reduced-motion as a designed end-state, not a fallback; one-idiom discipline (one ease, one shadow, one link idiom); a single typed data source feeding every demo surface so numbers can't drift; a11y tests against the real shipped markup; testing against the **built** output, not the dev server; the **single-enumeration pattern** (one page list feeding prerender + sitemap + link checker); `isVitest` vite-config gating; meta.json nav conventions; Lighthouse budget file; self-hosted fonts.
- *Mistakes to avoid (its own audit):* named a body font it never shipped (visitors got system fallback); no preload on the identity font (guaranteed FOUT); gimmick density at the ceiling (canvas rain + cursor effects + scramble + scrub on one page — our direction allows exactly ONE motion concept); a hand-inlined second palette in the 404 that drifted from tokens; nothing real ever shown (all simulated demos — our rule: real artifacts only); desktop-first responsive patches instead of designed mobile.

**Stack facts (web-verified 2026-07-30; sources in PLAN):** TanStack Start is RC with API declared stable (~1.168); built-in `tanstackStart({ prerender })` does SSG and **nitro must be dropped** (beta; conflicts with prerender); fumadocs officially supports TanStack Start (core ~16.13, mdx ~15.2 — a major over the reference's v14); Orama static search runs fully in-browser off a build-time index; llms.txt/llms-full.txt/per-page .md is the 2026 docs baseline and fumadocs has first-class support; there is NO `render: 'static'` route option — prerendering is driven by the pages list; the no-nitro static output dir is `dist/client`.

## 7. Assumptions register (label-checked)

| Claim | Status |
|---|---|
| Product facts in §2 (rail rendering, brief forms, config keys, install commands) | **Verified** against repo source, file paths cited — including a second pass after an empty-context audit corrected the rail separators, brief-frontmatter claim, and palette attribution |
| Site magenta/cyan tokens | **Site's own rendering** of the product's role duality (TUI uses terminal-dependent ANSI names / preset-dependent hexes) — a deliberate design decision, not a copied fact |
| Stack versions & recipes | **Verified** against registries/docs 2026-07-30 — re-verify at install time; APIs may drift (RC) |
| Coolify Dockerfile pack + base directory `website/` works as described | **Verified** against Coolify docs/discussions 2026-07-30 (static+Nixpacks cannot take custom nginx config); UI details may drift — the Dockerfile stays the source of truth |
| Production domain (`SITE_URL`) | **Unknown** — required maintainer input at the start of P4 (llms routes emit absolute links; also configured on the Coolify app) |
| fumadocs-mdx v15 works cleanly on Vite 7 | **Probable, unproven** — fallback pairing pinned in PLAN Risks |
| Gallery fixtures can be made production-plausible without breaking visual tests | **Assumption** — P0 task validates it |

## 8. Glossary (terms used across the bundle)

**Task Brief** — the nine-section contract artifact. **Planner / implementer** — the two runner roles. **Runner kind** — one of `cli|api|shell|agent|agent-sdk`. **Modes** — instant/quick/standard/speckit. **Phase rail** — rendered `Spec › Plan › Briefs → Build → Verify`. **Drift report** — deterministic diff-vs-brief check. **Evidence ledger** — per-task audit trail. **tui-shots** — the deterministic TUI screenshot gallery (`npm run tui-shots` → `.test-artifacts/ui/…`, PNG/SVG/txt/ansi). **Jack / pin / crosshair** — Pin Matrix vocabulary (see DIRECTION). **Panel strip** — the landing's section primitive. **Single enumeration** — `scripts/pages.ts` as the one URL universe. **OUTPUT_DIR** — `dist/client`. **SITE_URL** — canonical origin constant.
