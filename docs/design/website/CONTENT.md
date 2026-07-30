# SPLITBRIEF Website — Content Plan

Companion to `DIRECTION.md` (design) and `PLAN.md` (architecture/tasks). Everything here derives from the repo's own docs; the per-page source mapping tells the implementer exactly which file feeds which page. Verified against the repo by an adversarial critic pass — counts, section numbers, and artifact shapes below are checked facts.

## Voice guide

Match the product's existing register (README, MENTAL-MODEL): engineer-to-engineer, declarative, zero hype. Signature moves to keep: aphoristic two-beat lines ("The planner thinks. The implementer types."), explicit non-goals, tables over prose, hedged claims. Sentence case everywhere. Active voice; buttons say what they do ("Copy install commands", not "Get started"). Errors and empty states direct, never apologetic. Banned vocabulary and its scope are defined in `DIRECTION.md` gate row 7. Never promise savings; state mechanisms.

## Landing anatomy (single page, panel strips in this order)

1. **HERO — the instrument face.** Wordmark legend, live pin matrix (pre-seated claude-code × Ollama), emitted YAML, headline + sub-line, source install CTA — viewport priority order per DIRECTION.md. Headline (frozen): **"Patch your planner into your implementer."** Sub-line: "The Task Brief is the signal between them." Any counted claim must match the artifact it sits above — re-count against `pairings.ts` before ship.
2. **THE SIGNAL — the Task Brief.** Panel strip showing the **`tasks.md` transport block** — the on-disk artifact the user actually reviews at the approval gate: YAML frontmatter (`id: T001` / `title` / `action` / `file` / `depends_on`) followed by `### Description` and `### Scope` headings. Source it from `docs/TASK-CONTRACT.md` §"Example task entry" or a real session's `tasks.md` — never compose freehand (the exact shape is also specified for planners in `src/engine/spec/prompts/task-format-example.ts`). Beside it, the nine semantic section names from `docs/TASK-CONTRACT.md` as an engraved legend. Copy: the brief is a nine-section contract on disk — the planner writes it, you approve it, the implementer executes exactly it. One line on drift: the final diff is checked back against the brief.
3. **THE PATCH FIELD — runner kinds.** The 5×5 kinds table (`cli / api / shell / agent / agent-sdk` each side), with supported tool names chipped under each kind (cli: claude-code, codex, opencode, aider, copilot, kilo-code; api: Ollama, LM Studio, OpenRouter, DeepSeek, Groq, Together, Anthropic). Copy: "Five supported runner kinds on either side." Every kind-to-kind intersection can be expressed when its required fields and runner contract are supplied; do not imply that every arbitrary tool is built in. Link to the Backends guide. (The hero matrix shows six *jacks*, which are named tools/providers, not kinds.)
4. **THE CONSOLE — the product itself.** One real tui-shots SVG frame: scenario `workflow-implementation`, **120×40 viewport**, from `testing/visual/catalog.ts`. The exported frame is grayscale (`#101010` / `#d4d4d4`); planner and implementer are identified by its labels, while the site's magenta/cyan role colors stay outside the artifact. Write real alt text describing what the frame shows (the capture ships with a generic `aria-label="Terminal capture"` — replace it). The frame's SVG uses the gallery's own mono stack, not Fragment Mono — accept that; it is the real artifact. The frame contains **no cost line** — do not composite one. The cost whisper is the single sentence beneath the frame: "You pay for the thinking once." Nothing else about price. Fixture credibility is a P0 task (PLAN.md).
5. **THE INTERLOCK — orchestration.** Phase rail **`Spec › Plan › Briefs → Build → Verify`** (title-cased `RAIL_STAGES` with the product's real connector glyphs `›`/`→` — see DIRECTION real-artifact rules) as a strip; copy covers gates (spec/briefs/tiered file-write), validation (`typecheck → lint → test`), retries → escalation tiers → recovery, snapshots and resume. Three or four short declarative lines, not a feature grid. Note: the CONSOLE frame above renders the rail in its ascii tier with clipped labels — that is the real capture; the strip below it uses the full-width rendering; both are product-true tiers.
6. **MODES.** instant / quick / standard / speckit with explicitly labeled **nominal pre-build planning calls** (1 / 1 / 4 / 5–6) — one ruled row each. A note below the rows says final review adds one planner call to every successful mode and non-happy paths can add more.
7. **INSTALL — ordering information.** A source-only `InstallBlock` with the complete README commands, Node 22+, macOS/Linux, "not yet on npm" honesty, and links: `[ Documentation ] [ GitHub ] [ MIT License ]`. No dormant npm variant ships.

Footer: minimal — docs, GitHub, license, `llms.txt`.

### Pin matrix data (hero)

Left jacks (planner): `claude-code`, `codex`, `opencode`, `aider` (cli), `anthropic (api)`, `agent-sdk`. Top jacks (implementer): `ollama (api)`, `lm-studio (api)`, `deepseek (api)`, `groq (api)`, `openrouter (api)`, `together (api)`. (`shell` was deliberately dropped from the hero jacks: its schema requires a real local `command:` script, so its YAML could never be copy-paste-runnable — it stays in strip 3's kinds table where it belongs.)

The six-by-six matrix has exactly **36 displayed pairings**. Every pairing emits a complete config with `version`, `planner`, `implementer`, `validation`, and `workflow` root blocks. Pin an explicit supported model ID for every model-bearing jack and store its official source URL plus `modelVerifiedOn` date in `pairings.ts`; `model: auto` is forbidden in hero output. The current Groq value is `openai/gpt-oss-120b`, verified against [Groq's production model list](https://console.groq.com/docs/models) on 2026-07-30. The pre-seated Ollama default follows the repo catalog: `qwen3-coder:30b`. Re-verify every external provider model immediately before implementation and update the recorded date rather than guessing or silently falling back. Pattern:

```yaml
# cli planner × api implementer (pre-seated default)
version: 3
planner:
  kind: cli
  tool: claude-code
implementer:
  kind: api
  provider: ollama
  apiBase: http://localhost:11434/v1
  model: qwen3-coder:30b
validation:
  typecheck: true
  lint: true
  test: true
workflow:
  mode: standard
  approve: default
  maxRetries: 3
  git:
    commitStrategy: none
```

The implementer builds the typed `pairings.ts` data map and generates all 36 documents from it. Acceptance is exact cardinality plus YAML parse and `ConfigSchema.safeParse` success for every complete document (`src/core/schemas/config.ts`), with assertions that required root blocks exist, API runners use `provider`/`apiBase`/`model` (never `baseUrl`), CLI runners use `tool`, no hero model equals `auto`, and every model has a non-empty source URL and verification date. This is a P3 gate test. The YAML frame carries a copy button (kill-test: copy-paste-runnable).

## Docs IA — full tree with source mapping

32 pages: 14 as-is, 15 rewrite, 3 new. Disposition: **as-is** (content-faithful subject to the verified factual-correction policy below; links and file paths remapped), **rewrite** (strip internal file paths/pointers, keep substance), **new** (write fresh). Source files live in `docs/`.

**URL shape & slugs:** `/docs/<group>/<page>` with kebab-case slugs derived from the page titles below; groups are `getting-started`, `concepts`, `guides`, `reference`, `project`. First page (the `/docs` 301 target and nginx config value): `/docs/getting-started/introduction`. `meta.json`: root file spreads the five groups with `---Label---` separators; per-group `meta.json` orders pages as listed below.

**As-is import policy (binding — "as-is" means content-faithful, not knowingly stale):** preserve structure and voice, but apply narrow corrections verified against current source before import. The audited exception pages are **Cookbook, API key security, Debugging a run, Slash commands & keys, Configuration, Task Brief format, Troubleshooting, and Migration**; their known correction topics are editor-key routing, the wrapped `--json` envelope and cost fields, planner-call scope, drift score direction, hook environment syntax, API-runner YAML, and Task Brief transport wording. `docs/TASK-CONTRACT.md`'s repaired "Example task entry" is canonical and must not be reconstructed or reverted. Every internal `.md` link is remapped at import: target is a public page → its site route; target stays internal → link to the file on GitHub (`https://github.com/b4r7x/splitbrief/blob/main/docs/<file>`) or drop the sentence if the pointer is purely internal navigation. Inline `src/...` path mentions remain. `check-links` must pass.

| Nav | Page | Source | Disposition |
|---|---|---|---|
| Getting started | Introduction | MENTAL-MODEL.md | rewrite |
| | Installation | README §install | new (source-only at launch) |
| | Quickstart | GETTING-STARTED.md | rewrite |
| | Choosing models | README §models (VRAM table) | new |
| Concepts | The two-role model | GETTING-STARTED.md §5 + VISION.md | rewrite |
| | Task Briefs | TASK-CONTRACT.md (contract half) | rewrite |
| | Workflow modes & phases | WORKFLOW.md | rewrite (drop reducer tables) |
| | Approval, escalation & recovery | APPROVAL-AND-RECOVERY.md | rewrite |
| | Sessions & persistence | CONCEPTS.md §sessions/artifacts | rewrite |
| | Glossary | CONCEPTS.md | rewrite |
| Guides | Cookbook | USAGE-EXAMPLES.md (44 recipes) | as-is |
| | Planners & implementers | PLANNERS-AND-IMPLEMENTERS.md + README tables | rewrite |
| | Cost management & budgets | FEATURES.md §cost telemetry | rewrite (EXEMPT from the cost-vocabulary gate — this page is the sanctioned home for cost; it may show the product's real UI strings verbatim, savings percentages included, because they are artifacts, not marketing) |
| | Safety: snapshots, drift, approval | FEATURES.md §safety | rewrite |
| | Hooks | HOOKS-CONFIG.md | as-is |
| | Worktrees & parallel sessions | WORKTREES.md | as-is |
| | Headless & CI (`--json`, `--rpc`) | FEATURES.md + CLI-REFERENCE.md | rewrite |
| | MCP & handoff packs | FEATURES.md §interop | rewrite |
| | Repo-map | REPOMAP.md | as-is |
| | Observability (OTel) | OTEL.md | as-is |
| | API key security | API-KEYS.md | as-is |
| | Debugging a run | DEBUGGING.md | as-is |
| Reference | CLI | CLI-REFERENCE.md | as-is |
| | Slash commands & keys | SLASH-COMMANDS-REFERENCE.md | as-is |
| | Configuration | CONFIGURATION.md | as-is |
| | Task Brief format | TASK-CONTRACT.md (incl. breaking-change policy) | as-is |
| | Troubleshooting | TROUBLESHOOTING.md | as-is |
| | Migration | MIGRATION.md | as-is |
| | Changelog | CHANGELOG.md (docs/) | as-is |
| Project | Why SPLITBRIEF / comparison | VISION.md (USP table; the added "vs plain Claude Code/aider" row is NEW competitive copy — draft it, flag it for explicit maintainer approval before ship) | rewrite |
| | Roadmap | FUTURE.md | rewrite (strip code pointers) |
| | FAQ | — | new (seed questions from TROUBLESHOOTING.md symptoms, README caveats — Windows, npm status, savings honesty — and the non-goals list in VISION.md) |

**Stays internal** (never on the site): HOW-IT-WORKS, ARCHITECTURE, ENGINE, SUBSYSTEMS, EXTENDING, STORES, STORES-AND-UI, STRUCTURE, LAYERS, TYPES, ERRORS, HOOKS (React), NO-BARRELS, INVARIANTS, PRINCIPLES, CODE-STANDARD, TESTING, BOOTSTRAP, DIRECTION, COST-AWARE-IMPLEMENTER-DIRECTION, WORKFLOW-CONVERSATION-SCROLL, CONCEPTS (superseded by its rewrites), FEATURES (mined by rewrites), docs/README.

Interop-first ordering note: "Planners & implementers" leads the Guides group on purpose — it is the thesis guide. Every rewrite frames features through supported-runner composition, not savings or arbitrary-tool promises. Content-faithful pages keep their original register, including cost talk, after the verified factual corrections above.

Sidebar jack bullets (per DIRECTION.md): filled magenta = planner-leaning pages (Planners & implementers, Task Briefs, Workflow modes), hollow/ring cyan = implementer-leaning (Choosing models, Headless & CI, Repo-map), neutral otherwise. Shape and fill carry the role distinction alongside color.

## Generated metadata & static extras

- `llms.txt` (index with absolute links from the `SITE_URL` constant, ≤5KB) and `llms-full.txt` — TanStack Start **server-route GET handlers**, prerendered via the `scripts/pages.ts` enumeration. Per-page markdown mirrors (`/docs/<slug>.md`) — a splat server-route GET handler using the local `lib/get-llm-text.ts` helper (the fumadocs recipe — it is NOT a package export), which requires `postprocess: { includeProcessedMarkdown: true }` in `source.config.ts`. Mirrors are enumerated in `pages.ts` as their own page kind: **prerendered, excluded from sitemap.xml**. (`render: 'static'` is not a real fumadocs/TanStack API — do not go looking for it.)
- `sitemap.xml` + `robots.txt` generated from the same enumeration.
- OG: `public/og.png` 1200×630 is **generated, not hand-painted** — a hidden `/og` route styled from the same tokens (panel black, wordmark legend, matrix motif, headline), screenshotted by `scripts/generate-og.ts` (Playwright — a website devDependency, installed at P1). Ordering (two-pass, decided): build once → serve `OUTPUT_DIR` → screenshot `/og` into `public/og.png` → final build ships it. Per-page `<title>` + description from frontmatter; JSON-LD `SoftwareApplication` on the landing with values from real sources only: name/version from `package.json`, license MIT, `operatingSystem: "macOS, Linux"`, `applicationCategory: "DeveloperApplication"`, `downloadUrl` = the GitHub repo.
- 404 page: instrument-face styled, generated from the same tokens (the reference site hand-inlined a second palette into its 404 and it drifted).
- Favicon: SVG derived from the pin motif.
