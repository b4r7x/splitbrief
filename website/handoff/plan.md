# Nuke Preflight — nuke-spec (light) → nuke-exec

feature: static marketing site for SPLITBRIEF under `website/` (separate from the CLI build), art-directed after `.nuke/website-prompt.md` + `reference.png` (the "orch" comp), with animated ASCII agent ghosts
source: `.nuke/website-prompt.md` (product renamed orch → splitbrief), `reference.png` (visual target), README / docs/MENTAL-MODEL.md / docs/VISION.md (copy truth)
scope area: `website/**` only — zero changes to `src/`, configs, or gates
mode: light (spec) → exec sequential, one implementer at a time (user constraint: usage limits, 5h windows)
run_dir: .nuke/2026-09-06-225118-spec-website

## Clarifications (answered 2026-09-06)
1. Install CTA → `$ npm install -g splitbrief` (future install line; package not on npm yet — accepted)
2. Hero artifact → `tasks.md`, labelled TASK BRIEF (the product's contract; not plan.md)
3. Wordmark + tagline → `splitbrief°` + ONE PLANS. / ONE EXECUTES. / ONE CONTRACT.
4. Fonts → Google Fonts CDN: Instrument Serif (display), JetBrains Mono (labels/body), Space Mono (wide manifesto face)

## Tiers (user-mandated)
- spec phases (requirements / design / architect): in-session (fable)
- spec completeness reviewer: opus (worker)
- implementers: **fable** for every phase that touches the render (all of them — design quality is the ask); opus only for non-visual chores (screenshot script)
- critics: fable, fresh context, judge screenshots vs `reference.png`
- one agent at a time; the user's usage window may cut a run — progress lives in `exec-progress.md`, resume from first non-done phase

## Gates (website/ has none in the repo — bootstrapped by the spec)
| path | check |
|---|---|
| `website/**` | `website/scripts/shot.sh <out>` renders 1440-full / 1440-fold / 390-full PNGs without error; `website/scripts/check.sh` — html validity (no unclosed tags via node DOM parse), no console errors in headless run, no horizontal overflow at 390 |

## Tooling
- screenshots: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new` (v152) — verified working; `--virtual-time-budget=N` advances animations
- chrome-devtools MCP available for interactive checks (mcp__chrome-devtools__*)

estimate: 6 build phases × (1 implementer + 1 critic + ≤2 fix cycles) ≈ 14–24 agents, sequential
