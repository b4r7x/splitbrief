# SPLITBRIEF Website — Required Skills & Distilled Charters

Two layers: (A) skills to load by name if the implementing session has them; (B) the distilled content of each, written out so that a session WITHOUT these skills can still execute the same discipline. When a skill is loadable, load it — the distillates below are the floor, not the ceiling.

## A. Skills to load (by exact name, if available)

| Skill | Role in this project | When |
|---|---|---|
| `nuke-implement` | **orchestrator only:** owns the written contract, disjoint agent batches, fresh validators, evidence, and fix-loop convergence; it is never a substitute for a file-type skill | every phase |
| `nuke-code` | implementer/fixer batch discipline (think → build → self-sweep); it does not orchestrate this run | every implementation/fix batch |
| `nuke-lean` | diff minimalism contract + self-sweep | every code task |
| `nuke-creative` | UI charter: brief, anti-default gate, floor, critique loop | P2–P4 (all visual work) |
| `frontend-design` | design-lead sensibility: typography, hero-as-thesis, copy as design | P2–P4 |
| `nuke-think` | deep-reasoning protocol for judgment calls | when a plan assumption breaks, or any hard trade-off |
| `sota` | verify current official guidance, Context7 references, installed-version APIs, deprecations, and relevant library skills before stack decisions | before P1 and before first work in each new framework/library area |
| `code-quality` | enforce DRY/KISS/YAGNI/SRP and the ≥3-call-site extraction rule inside each owned batch and its fresh validation | every implementation/fix batch |
| `code-audit` | maximum-agent audit of the final changed scope, including two cross-cutting reviewers, full scorecard, and fix/re-audit loop | after P7 local evidence, before final verdict |
| `sota-structure` | file/folder/naming doctrine | P1 scaffold + any new file |
| `tanstack-start-best-practices` | framework guidance | P1, P4 |
| `tailwind-patterns` | Tailwind v4 CSS-first patterns | P2 |
| `react-senior-guide` → `react-anti-patterns` | mandatory route for every React/`.tsx` author and reviewer; load the senior guide first, then its anti-pattern checklist and any hook-specific skill it selects | every React/`.tsx` batch in P1–P4 and final audit |
| `webapp-testing` | e2e discipline | P6 |

Repo-local context: also read the root `CLAUDE.md` (the never-commit rule and repo conventions are binding).

## B. Distilled charters

### B1. Lean contract (from nuke-lean) — checked against every diff

1. The diff answers the task and nothing else — zero drive-by renames/refactors/reformats.
2. Validation exists exactly at trust boundaries. A fully-prerendered static site has almost none at runtime — build-time checks (link checker, YAML diff, gates) are where rigor lives. Do not add runtime guards to code whose inputs the build guarantees.
3. Every check names the concrete input that triggers it — can't name one, delete it.
4. Error handling only where a recovery action exists.
5. An abstraction needs ≥3 call sites today; a config option needs a second real value today; otherwise inline/hardcode.
6. Fallbacks never mask failures — no `?? default` on values the build guarantees.
End every task with a sweep line: `lean sweep: clean` or `lean sweep: deleted <what>`. Red flags: helper with one caller, options object passed one shape, try/catch that only logs, null check on a value you just produced.

### B2. Creative charter (from nuke-creative + frontend-design)

- The brief is written (DIRECTION.md) and the direction is CHOSEN — do not re-diverge. Every later choice (spacing, empty states, hover) answers to the direction: "would an EMS Synthi faceplate do this?"
- The anti-default gate (DIRECTION.md, 7 rows) and the floor (AA per lightest surface, focus ring, designed mobile, semantic HTML, reduced-motion, perf budgets) are pass/fail — a failed row is a redesign, not a caveat.
- Typography carries the personality: Archivo Expanded caps legends are the voice of the page — timid sizing is the most likely failure. Structure is information: panel strips and engraved legends must encode real grouping, not decoration.
- Spend boldness in ONE place (the matrix); keep everything around it quiet. Before shipping a surface, remove one accessory (Chanel rule).
- Copy is design material: plain verbs, sentence case, specific > clever, an action keeps its name through the whole flow. Write from the user's side ("Copy install commands"), never the system's.
- Rendered output is the material under judgment — screenshot it; code review alone judges the wrong artifact.

### B3. Critique loop — paste-ready critic prompt (fresh agent, NOT the author)

Run at P3 (cap 3 cycles) and once at P4. Give the critic ONLY the following + the screenshots (never the author's reasoning):

```
You are a design critic. You did not write this code and owe it nothing.
Read the repository's `docs/design/website/DIRECTION.md` in full.
Attached: screenshots of the built page at 1440px and 390px widths
(and for P4: three docs pages in both themes).

Judge the RENDER, not the code:
1. Feel words — does the render EARN "composable", "precise", "engineer-credible"?
   Verdict per word: earned | missed, with the visual evidence.
2. Anti-default gate — verdict per row 1-7: pass | fail, with evidence.
3. The floor — verdict per item: pass | fail (contrast estimates count as evidence;
   flag anything that needs a measured check).
4. Hero priority order — honor DIRECTION's viewport allowances; do not fail the
   hero for the install block being below the fold at short viewports.
Every "missed"/"fail" MUST carry a concrete, actionable fix
("matrix legends: Archivo Expanded caps ≥13px, 0.14em tracking"),
never "polish it" or "make it pop".
Kill-test (P3 only): state plainly whether clicking a crossing reads as
completing a circuit. If you fail gate row 4 or a feel word, say exactly what
would change your verdict.
```

Record every verdict in `docs/design/website/CRITIQUE.md` (cycle number, verdicts, fixes applied). After 3 failed cycles on gate row 4 or feel words → STOP, escalate to maintainer (fallback switching is maintainer-only).

### B4. Deep-reasoning protocol (from nuke-think) — for judgment moments only

When a plan assumption breaks or a real trade-off appears (not for mechanical work): 1) restate the decision + what evidence would settle it; 2) write ≥3 genuinely different options before evaluating any; 3) gather evidence per option, label each item fact vs assumption; 4) write the strongest refutation of your leader; 5) verdict + confidence + the falsifier; 6) answer in ≤3 sentences first, detail after. If it touches DIRECTION/PLAN decisions → escalate to maintainer instead of deciding.

### B5. Structure rules (from sota-structure, scoped to `website/`)

- kebab-case files/folders; basename = primary export; no grab-bags (`utils.ts`, `helpers.ts`).
- No path-echo (`features/landing/landing-matrix.tsx` is wrong; `features/landing/matrix/matrix.tsx` unit-folder is right, inner files drop the unit name).
- A unit gets a folder at 3+ files; tests colocate as `<name>.test.ts(x)`; e2e in `testing/e2e/*.e2e.ts`; never `__tests__/`.
- Zero internal barrels — framework-generated files (`routeTree.gen.ts`) and route files excepted.
- ≤200 lines per file target (per responsibility), warn >300; don't split cohesive logic to satisfy a number.
- Feature code in `features/<x>/`; cross-feature sharing promotes to `src/lib/` on the second consumer.

### B6. Verification discipline (from the ship rules)

- A phase gate passes on **evidence**: pasted command output, screenshot, or diff. "It should work" is not a state of the world.
- Test against the BUILT output (`dist/client` served statically), not the dev server — the reference project caught real bugs only there.
- Report failures as failures, verbatim output included. Never mark a task done with a failing gate, a skipped step, or an unverified claim.
- When blocked by a missing maintainer input (SITE_URL, Coolify app creation at P7), say so and pause that item — do not invent values.

### B7. User-requested quality stack — execution routing

- **`nuke-implement` stays at the orchestration boundary.** It writes and preserves the 2–5 done criteria, assigns disjoint file ownership, waits for the whole implementation wave, dispatches fresh validators, and converts every failed criterion, gate, or finding into an exact fix batch. Implementers and fixers load the skills for their files; they do not treat `nuke-implement` as a coding charter.
- **`sota` precedes stack work.** Before the first TanStack Start, Fumadocs, Tailwind, React, Playwright, axe, Lighthouse, nginx, or Coolify change, verify current official documentation and Context7 guidance against the installed versions. Record the sources and any `RECIPES.md` delta in the phase evidence; installed behavior wins over remembered APIs.
- **`code-quality` applies per batch, not only at the end.** Every implementation and fix batch checks DRY, KISS, YAGNI, SRP, dead code, and the ≥3-occurrence extraction threshold before handoff. Its fresh validator repeats that check over the batch diff and blast radius.
- **React work routes through `react-senior-guide` and `react-anti-patterns`.** The senior guide selects any hook-specific skill; every React author and fresh reviewer then checks derived state, effect cleanup/races, stale closures, stable keys, state shape, component boundaries, loading/error/empty states, and the repo's stricter zero-memoization rule. Project conventions win where generic React advice differs.
- **`code-audit` is the final convergence gate.** After P7 local evidence, launch the maximum available agents over `changed` scope, with at least one DRY reviewer and one architecture/SRP reviewer. Deduplicate findings, publish all 15 category scores, fix every severity in disjoint batches, re-run website/root gates, and repeat with fresh reviewers until all categories reach 5/5. If a category cannot reach 5/5, report the evidence-backed maximum, exact open finding, and blocker instead of claiming completion.
