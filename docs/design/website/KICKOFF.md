# SPLITBRIEF Website — Implementer Kickoff

Paste-ready brief for the implementing agent. The bundle is fully self-contained — a session with zero prior context has everything it needs in the seven files of this directory.

## Prompt (copy from here down into the implementer session)

You are implementing the SPLITBRIEF website: a landing + docs site (TanStack Start, headless fumadocs, fully prerendered static output) inside the repo at `website/`. The plan bundle is complete and adversarially verified — your job is execution with craft, not re-planning.

**Read the bundle in `docs/design/website/`, in this order, before writing any code:**
1. `SPEC.md` — the context you don't have: what SPLITBRIEF is, the positioning and its history (why cost is a whisper), the full decision log with rationale, the creative history (why "The Pin Matrix" won and what it beat), the research digest, the assumptions register, and the glossary.
2. `DIRECTION.md` — the design contract (tokens, the Pin Matrix spec, anti-default gate, floor, critique loop, fallback protocol). It wins over your taste.
3. `CONTENT.md` — landing anatomy, docs IA with per-page source mapping, real-artifact shapes.
4. `PLAN.md` — architecture, stack pins, deployment identity, file tree, phases P0–P7 with gates, your charter, risks.
5. `RECIPES.md` — code-level skeletons for the tricky wiring (vite config, fumadocs, llms/mirror routes, matrix semantics, nginx, testing). Verify each against installed versions; reality wins, record deltas.
6. `SKILLS.md` — the skills to load by name if your session has them, AND the distilled charters (lean contract, creative charter, paste-ready critic prompt, deep-reasoning protocol, structure rules, verification discipline) so a missing skill never blocks you. Load what exists; execute the distillates regardless.

Also read the repo root `CLAUDE.md` — its rules (especially never-commit) bind you.

**Reference implementations on this machine** (read for patterns, never copy blindly — some of their choices are explicitly rejected in PLAN.md, e.g. nitro and `.output/public`): `~/Projects/diffgazer-workspace/apps/docs` and `~/Projects/diffgazer-workspace/apps/landing`.

**Working discipline:**
- One phase at a time, in order (P0 → P7). A phase is done only when its gate passes with evidence (command output, screenshot, or diff — pasted, not claimed). Never proceed past a failing gate.
- The critique loop is mandatory at P3 (full, cap 3 cycles) and P4 (one cycle) — use the paste-ready critic prompt in `SKILLS.md` §B3 with a fresh agent that did not author the code; record verdicts in `docs/design/website/CRITIQUE.md`.
- Every artifact on the site must be real — YAML valid per `docs/CONFIGURATION.md`, brief excerpts in one of the three real forms named in DIRECTION's real-artifact rules (never blended), phase rail rendered `Spec › Plan › Briefs → Build → Verify` with the product's connector glyphs, TUI frames from the regenerated gallery only.
- **NEVER run `git commit`, `git add`, or `git stage`** — a repo hook blocks them; leave everything unstaged for the maintainer, including Playwright baselines.
- End every code task with the lean-sweep line (`SKILLS.md` §B1).
- If the P3 critic still fails the matrix after 3 cycles, or a plan assumption breaks in a way `PLAN.md` Risks and `SPEC.md` §7 don't cover: STOP and report to the maintainer. Do not improvise a new design direction — fallback switching is maintainer-only.

**Open inputs to request from the maintainer when you reach them (not before):**
- `SITE_URL` — canonical production origin. **Request at the start of P4** (the llms routes emit absolute links); it also feeds sitemap/OG/JSON-LD at P6 and the Coolify domain at P7. Never invent a placeholder.
- At P7: your gate closes on LOCAL evidence (Docker or static-server curl checks) plus a handoff checklist; the maintainer then commits the bundle (incl. `website/package-lock.json` — the Dockerfile's `npm ci` needs it), creates the Coolify application (Hostinger VPS — source repo, base directory `website/`, Dockerfile build pack, domain) and runs the live-origin checks.

Begin with P0 and report the gate evidence for each phase as you complete it.
