# Extension research — T-009 (2026-09-08)

Page as built (DESIGN §3–§10, `website/handoff/p5-1440.png`): nav · hero (steps, claim, headline, lede, CTA, works-with, the three ghosts routed through a `tasks.md` card) · routes table · manifesto · footer. Height ≈ 1920 px at 1440. Constraints carried into every candidate: no image assets (§0 — a TUI proof is typed characters, never a PNG), tokens from §1 only, no motion outside §7 (the lower sections are static), no cards, label style uppercase with a period, every block closed by `.dash`, claims on the col-11 rail.

## (a) Inventory — what the page leaves out or only gestures at

- The brief has nine sections — `docs/TASK-CONTRACT.md:87` "Every Task Brief v1 covers nine semantic sections" (Identity, Intent, Scope, Code Context, Implementation Plan, Validation, Constraints, Escalation, Evidence). The page shows three filenames.
- One file per brief — `docs/MENTAL-MODEL.md:26` "Each brief describes exactly one file operation — create or modify"; `docs/TASK-CONTRACT.md:292` lists `multi_file_task` as a blocking error.
- The implementer sees only its brief — `docs/MENTAL-MODEL.md:35` "It has no access to the spec, the plan, or other tasks."
- Fresh context per brief — `README.md:9` "one brief at a time, in fresh context"; `README.md:37` "no memory of the last one".
- Stop-and-ask is part of the contract — `docs/MENTAL-MODEL.md:27-32` "When to stop and ask instead of guessing".
- Quality gate and refusal — `docs/TASK-CONTRACT.md:37` "may enter implementation only when the current deterministic Brief Quality report has zero errors"; `:333` "any error keeps the result `CONTRACT BLOCKED`".
- Briefs are reviewed before code — `docs/MENTAL-MODEL.md:160` "The user reviews tasks.md before any code is written."
- The validation ladder — `docs/MENTAL-MODEL.md:142` "a deterministic pipeline of typecheck → lint → test, run in the real project after promotion, stopping at the first failure attributable to the task". The manifesto names the three stages and nothing else.
- Pre-existing red does not count — `docs/APPROVAL-AND-RECOVERY.md:277` "a task that introduces no new failure is accepted even when the tree was already red".
- Retries — `docs/APPROVAL-AND-RECOVERY.md:281` "retries with the error message appended to its context … up to `workflow.maxRetries` times (default 3)".
- Three tiers — `docs/MENTAL-MODEL.md:146-148` Tier 0 a mid-tier model, only when configured · Tier 1 the planner writes a hint, one retry · Tier 2 "the planner takes over and writes the code itself".
- Recovery is a human choice — `docs/MENTAL-MODEL.md:150` "retry the same worker, route to a bigger worker, skip the task, pause, or abort"; action table `docs/FEATURES.md:349-357`.
- The honest exception — `README.md:15` "when a task exhausts retries and the last escalation tier fires, the planner writes the code itself and then reviews its own work. Escalated tasks are the exception the blind-spot argument does not cover."
- Isolation — `docs/PLANNERS-AND-IMPLEMENTERS.md:285` "a git worktree created once per run … Project dependencies are reachable inside it".
- Promotion is hash-guarded — `docs/APPROVAL-AND-RECOVERY.md:150` "hash-guarded and all-or-nothing … the whole promotion is refused"; `README.md:68` "refuses to overwrite a file that changed while the task was running".
- The API path never touches the tree — `README.md:68` "SPLITBRIEF writes each file itself, one approval gate at a time".
- Not a sandbox — `docs/MENTAL-MODEL.md:136` "A worktree isolates files, not runtime and not trust … It is not a security boundary."
- Tiered approval — `docs/MENTAL-MODEL.md:161` classes `read` / `write_in_scope` / `write_out_of_scope` / `destructive` / `package_change`, tiers `auto` / `sticky` / `confirm`. The `workflow-review` capture shows the real prompt (Approve once · this session · always · Deny).
- The session folder — `README.md:113-123` tree (`config.yaml`, `active`, `sessions/<id>/state.json`, `session.jsonl`, `research.md`, `spec.md`, `plan.md`, `tasks.md`); `docs/MENTAL-MODEL.md:98-103` adds `summary.json` "Final cost, timing, outcomes" and `snapshots/` "Content-addressed working-tree snapshots for undo"; `docs/FEATURES.md:200` `review.md`, `summary.json`, `evidence.json` in all modes.
- state.json is the resume truth; session.jsonl the audit log — `docs/MENTAL-MODEL.md:98-99` "This is the source of truth for resume" / "append-only. The full audit log."
- The evidence ledger — `docs/TASK-CONTRACT.md:335-339` "the durable record of what each task was supposed to prove and what was actually observed"; `docs/FEATURES.md:436` observed strings `typecheck passed`, `diff written for <file>`, `final review written`; "Every entry carries `briefHash`".
- Drift report before review — `docs/TASK-CONTRACT.md:405` "comparing the Task Brief against the actual git diff and the evidence ledger".
- Final review reads the whole diff — `docs/FEATURES.md:144` "reviews the entire diff against the Task Brief and any supporting spec"; written to `review.md`.
- Snapshots restore is hash-guarded — `docs/FEATURES.md:380` "files modified after the snapshot was taken are reported as conflicts and skipped".
- Three modes — `docs/FEATURES.md:27-29` quick 1 call / no gate · standard 4 / spec · speckit 6–7 / spec + plan + constitution + analyze; `README.md:158` "`--mode quick|standard|speckit` … The default is `standard`."
- Four runner kinds — `README.md:218-229` seven `cli` tools (claude-code, codex, opencode, copilot, kilo-code, cursor, command-code), `api` "Any OpenAI-compatible endpoint", `shell`, `agent`. Works-with (§4) omits Command Code and never names the kinds.
- The cross-lab argument is a label on the page, not an argument — `README.md:15` "A model reviewing its own output repeats its own blind spots — the assumptions that produced the bug are the same ones reading the diff."; `docs/VISION.md:11` "SPLITBRIEF has not measured it".
- Same-lab still works — `README.md:17` "You give up the blind-spot argument, not the pipeline."
- Two roles, three seats; the reviewer is read-only — `docs/VISION.md:28` "one stateless, read-only call over the run diff. It cannot plan, cannot write files, and holds no session."
- What it is NOT — `docs/VISION.md:17-24` not a universal AI connector, not a multi-agent coordinator, not a swarm manager, not a kanban board, not a plan archive.
- Cost is a consequence — `README.md:19` "Cost falls out of the same split rather than driving it"; `README.md:349-351` "arithmetic, not a benchmark … It does not promise a ratio." The page's `02 LOWER SPEND` carries none of the qualifier.
- No spend cap unless set — `README.md:353` "`workflow.maxBudget` in config, or `--budget` on the command line".
- Maturity — `README.md:5` "Early software, pre-1.0 … no evaluation run has been recorded yet, so nothing below is a claim about output quality on your repo"; `README.md:357-359` first-pass rate and cross-lab review effectiveness "Neither is measured yet." **Overclaim check on the existing page:** `01 HIGHER QUALITY` (§9) and `BETTER OUTPUT.` (§10) are the output-quality claims README:5 declines to make — for the owner / T-010 to decide.
- Install — `README.md:76` "SPLITBRIEF is not published to npm yet. Install from source". **The CTA `$ npm install -g splitbrief` (§4) contradicts it** (nuke-design tell #9) — owner's call, out of this task's scope.
- The commands a user types — `README.md:149-154` `start`, `spec`, `init`, `doctor`, `resume`, `status`; `README.md:106` "`splitbrief init` # checks installed CLI tools and reachable providers, then you pick both sides"; `docs/CLI-REFERENCE.md:27-45` nineteen commands including `continue`, `last`, `explain`.
- Interaction mid-run — `README.md:140-141` queue a message, Ctrl-C aborts the call; `README.md:170-174` `/revise-spec`, `/redo-task`.
- The TUI as proof — `README.md:70` "event cards, inline diffs, real-time cost tracking"; the real row grammar: `validate  ✓ typecheck  ✓ lint  ✗ test` (`src/features/workflow/conversation-rows/event-format.ts:57-72`), `retry  attempt N/M` (`…/event-rows/dispatch.ts:193-198`), `escalate tier N — hint` (`…/event-rows/execution.ts:154-175`), byline `Validating…` (`src/features/workflow/display/live-activity.ts:47`), the `CONTRACT BLOCKED` panel (capture 5 below).
- Requirements — `README.md:74` "Node.js 22+ and a git repository with at least one commit"; `README.md:387` "macOS and Linux only".

## (b) Candidates

**C1 — The brief (the contract).** Claim: *One brief, one file. The implementer sees its brief and nothing else.* Artefact: a `tasks.md` block in the docs' own shape — frontmatter plus `### Description … ### Constraints` (`docs/PLANNERS-AND-IMPLEMENTERS.md:172-224`), filled with the page's running example (`T2 guard.ts`, README's own "add user authentication with JWT", `README.md:24`). Composition: the hero's `tasks.md` card opened to full size — same hairline box, `--bg`, `--text-micro` mono, cols 1–7; the nine section names as a `[ ]` rail in cols 9–10; the claim on the col-11 rail; the sheet cropped by the section's bottom rule (a cut-off object, nuke-design rule 3). Static. Density: dense. Slot: routes → **brief** → manifesto. **Keep** — the product is named after it and the page never shows one.

**C2 — The ladder (the proof).** Claim: *Correctness is not the implementer's to judge.* Artefact: a run transcript typed from the real row grammar (a task fails `test`, retries with the error, passes), the ladder as a list (`docs/MENTAL-MODEL.md:142-150`), and the config lines that set it (`README.md:196-203`). Composition: one terminal block on cols 1–8 (hairline, `--bg`, the TUI's own `*` `@` `└` markers, the pipeline bar as its top line), the ladder as a numbered rail on cols 11–12 with the `°` on the passing stage; the `✗ test` row is the only `--ink` in the block and `✓ test` the only green. Static — the packet on the hero is the page's one moving thing, and this block is the same task in text. Density: dense; mid-performance. Slot: manifesto → **ladder** → record. **Keep** — pays off the manifesto's "validates every task — typecheck, lint, test — retries, escalates" with the product's own rows.

**C3 — The record (the evidence).** Claim: *Every run leaves a folder you can read.* Artefact: the `.splitbrief/` tree (`README.md:113-123`) completed with `evidence.json`, `review.md`, `summary.json`, `snapshots/` (`docs/FEATURES.md:200`, `docs/MENTAL-MODEL.md:102-103`), one `//` annotation per file, the four commands (`README.md:106-107,153-154`), and the measurement line (`README.md:357-359`). Composition: tree in `--text-label` mono on cols 1–5 with `├──`/`└──`, annotations in `--ink-3` on cols 6–9, a `$` command strip under the tree, the small print on the col-11 rail closed by `.dash`. Static. Density: mid — a tree has air in it and lowers the page toward the footer. Slot: ladder → **record** → footer. **Keep** — pays off `REAL EVIDENCE.` (§4) and `03 REAL EVIDENCE` (§9), and is the only honest home for the maturity note.

**C4 — Modes.** Claim: *Three modes set how much planning precedes the briefs.* Artefact: `docs/FEATURES.md:27-29`. Composition: three rows in the routes table's grammar. Density: dense. Slot: after routes. **Cut** — a second table in the routes' vocabulary (uniformity, tell #8); a knob, not the argument. Folded into C3 as one annotation line.

**C5 — What it is not.** Claim: *Two roles. Three seats. One workflow at a time.* Artefact: `docs/VISION.md:17-28`. Composition: a second breath in the wide face with the negations in mono. Density: breath. Slot: before the footer. **Cut** — a second breath turns the thumbnail into dense / breath / dense / breath, which is stripes; the manifesto owns the wide face. Held in reserve if the owner wants the positioning line.

**C6 — Runner kinds and config.** Claim: *Four kinds of runner on either side.* Artefact: `README.md:218-229`, the `config.yaml` excerpt `README.md:176-198`. Composition: a YAML excerpt beside works-with. Density: dense. Slot: hero. **Cut** — works-with already carries the tools; `cli | api | shell | agent` is config vocabulary for the docs. Its two useful lines (`validation:` and `maxRetries: 3`) ride in C2 as an annotation.

## (c) Recommendation

Three sections, in page order: **routes → C1 brief → manifesto → C2 ladder → C3 record → footer.** The brief sits before the breath so the manifesto's "SPLITBRIEF HOLDS THE REST" summarises what the reader has just seen; the ladder and the record follow it as the small print the §0 audience reads. C4 folds into C3 (one line), C6 folds into C2 (two lines), C5 is cut for the arc.

- Proof: **C2** — a failing `test`, a retry with the error attached, a pass; the product mid-performance, typed in its own row grammar. Contract: **C1** — the brief itself.
- Seams: the brief's sheet is cropped by the rule above the manifesto; C2 and C3 share a paired eyebrow (`AFTER EVERY TASK` / `AFTER THE RUN`) and the col-11 rail; C3's small print ends on the footer's `[ github ]`.
- Thumbnail: hero (dense) · routes (dense) · brief (dense) · manifesto (breath) · ladder (dense) · record (mid) · footer. Three dense blocks of three different shapes — table, sheet, terminal — so it reads dense → breath → dense, not stripes.
- Added height at 1440: brief ≈ 560 px (eyebrow + a 30-line sheet at 11 px/16 px pitch) · ladder ≈ 500 px (13 rows at 18 px, statement, rail) · record ≈ 460 px (16-line tree, 4 commands, small print) · three section gaps 288 px → **≈ 1 800 px**, page ≈ 3 700 px. If T-010 wants it under 1 500, the brief sheet drops to the seven sections that carry meaning on a page (no Signature / Current Code / Pattern) and saves ≈ 180 px.
- Two contradictions on the existing page are named in (a) for the owner: the npm CTA against `README.md:76`, and `HIGHER QUALITY` / `BETTER OUTPUT.` against `README.md:5`. The addendum must not add a third; every string below is docs-backed or marked `derived`.

## (d) Copy bank

Citations: `[README:n]`, `[MM:n]` MENTAL-MODEL, `[TC:n]` TASK-CONTRACT, `[PI:n]` PLANNERS-AND-IMPLEMENTERS, `[AR:n]` APPROVAL-AND-RECOVERY, `[FE:n]` FEATURES, `[VI:n]` VISION; `derived` = built from the cited grammar or example, not quoted.

### A — The brief (C1)

- Eyebrow: `THE TASK BRIEF` — `[TC:87]`.
- Rail claim: `ONE FILE.` / `ONE BRIEF.` / `NOTHING ELSE.` — derived `[MM:26,35]`.
- Statement: `The planner writes one brief per file. The implementer sees only its own brief — not the spec, not the plan, not the other tasks — and runs it in fresh context, with no memory of the last one.` — `[MM:26,35]`, `[README:9,37]`.
- Second line: `A brief with an error on its quality report never reaches an implementer. It reads CONTRACT BLOCKED until you retry, edit, or reject.` — `[TC:37,333]`, retry/edit/reject `[TC:28-30]`, capture 5.
- Section rail (nine labels): `IDENTITY` `INTENT` `SCOPE` `CODE CONTEXT` `IMPLEMENTATION PLAN` `VALIDATION` `CONSTRAINTS` `ESCALATION` `EVIDENCE` — `[TC:87-99]`.
- Annotation: `// stop and ask instead of guessing` — `[MM:32]`.
- The sheet (headings verbatim from `[PI:172-224]`; frontmatter keys `id` `title` `action` `file` `depends_on` verbatim; content derived from README's example feature `[README:24]` and the hero card §5):

```
---
id: T002
title: Add the auth guard
action: create
file: src/auth/guard.ts
depends_on: [T001]
---
### Description
Guard a route with the JWT helper from T001. Reject a missing or expired token before the handler runs.
### Signature
export function requireAuth(req: Request): Claims | AuthError
### Implementation Steps
1. Read the bearer token from the Authorization header
2. Verify it with verifyToken from src/auth/jwt.ts
3. Return the claims, or an AuthError naming the reason
### Tests
- requireAuth returns the claims for a valid token
- requireAuth rejects a missing token
- requireAuth rejects an expired token
### Scope
**In bounds:** src/auth/guard.ts
**Out of bounds:** src/auth/jwt.ts — do not change the helper
### Escalation
- Stop and ask if verifyToken's signature differs from this brief
### Evidence
- npm test -- src/auth passes
### Constraints
- No new dependency
```

- Note for T-010: ids are `TNNN` on disk `[TC:143]`; the hero card's `T2` is the TUI's own short display form (capture 1 shows `T1`), so both are true.

### B — The ladder (C2)

- Eyebrow: `AFTER EVERY TASK` — derived `[FE:109]` "After every implementer task".
- Rail claim: `IT NEVER CERTIFIES` / `ITS OWN WORK.` — `[MM:20]` "the implementer never certifies its own work".
- Statement: `Correctness is not the implementer's to judge. After every task splitbrief runs typecheck, lint and test in your project and stops at the first failure the task caused. A stage that was already red before the run does not count against it.` — `[MM:142]`, `[AR:277]`.
- Second line: `A failure retries with the error attached, up to three times. Then it escalates: a mid-tier model if you configured one, a hint from the planner, and last the planner writes the code itself. If that fails too, you decide.` — `[AR:281]`, `[MM:146-150]`.
- Small print: `That last tier is the one path where the tool that wrote the code also reviews it.` — `[README:15]`.
- Ladder rail: `01 typecheck → lint → test` / `02 retry · up to 3` / `03 tier 0 · mid-tier model` / `04 tier 1 · planner hint` / `05 tier 2 · planner writes it` / `06 then · you decide` — `[MM:142-150]`; recovery choices under 06: `retry · route bigger · skip · pause · abort` — `[MM:150]`.
- Config annotation: `validation: typecheck · lint · test` / `workflow: maxRetries: 3` — `[README:196-203]`.
- The transcript (row grammar from the renderer and capture 1; content derived — no durations, so no speed number appears):

```
● Spec › ● Plan › ● Briefs → ● Build → ○ Verify      PLAN Fable · BUILD DeepSeek · REVIEW GPT-5.6
* T2 Add the auth guard   src/auth/guard.ts (create) · OpenCode · DeepSeek
@ Implementer activity  2 updates  [OpenCode · DeepSeek]
  └ Read    src/auth/jwt.ts
  └ Write   src/auth/guard.ts
validate  ✓ typecheck  ✓ lint  ✗ test
error · test
  FAIL src/auth/guard.test.ts › rejects an expired token
  run npm test
retry  attempt 2/3
@ Implementer activity  1 update  [OpenCode · DeepSeek]
  └ Write   src/auth/guard.ts
validate  ✓ typecheck  ✓ lint  ✓ test
```

- Byline under the block: `Validating… 0:41 · git:none` — `live-activity.ts:47` + the byline format in capture 1. The pipeline bar and `PLAN · BUILD · REVIEW` labels are capture 1's own; the seat pairing repeats the hero's (§4, cross-surface consistency).

### C — The record (C3)

- Eyebrow: `AFTER THE RUN` — derived `[README:126]`.
- Rail claim: `REAL EVIDENCE.` / `ON DISK.` / `IN YOUR REPO.` — §4 claim; `[README:110]` "a `.splitbrief/` folder in your project".
- Statement: `Every run is a session folder in your project. The state, the log, the briefs, the evidence and the review are files you can open, diff, and resume from.` — `[MM:97-103]`, `[README:126]`.
- The tree (`[README:113-123]` verbatim, completed from `[FE:200]` and `[MM:102-103]`; annotations `[MM:98-103]`, `[TC:339]`, `[FE:144]`, `[README:123]`):

```
.splitbrief/
├── config.yaml
├── active                     // current session-id
└── sessions/
    └── 2026-04-14-add-user-auth/
        ├── state.json         // current phase, task progress — the source of truth for resume
        ├── session.jsonl      // every event and message, append-only
        ├── research.md        // optional research notes
        ├── spec.md            // optional support doc for larger work
        ├── plan.md
        ├── tasks.md           // markdown transport for Task Briefs
        ├── evidence.json      // what each task was supposed to prove, and what was observed
        ├── review.md          // the review seat's read of the whole diff
        ├── summary.json       // final cost, timing, outcomes
        └── snapshots/         // content-addressed working-tree snapshots, for undo
```

- Command strip: `$ splitbrief init` `// checks installed CLI tools and reachable providers, then you pick both sides` — `[README:106]` · `$ splitbrief start "add user authentication with JWT"` — `[README:107]` · `$ splitbrief status` `// show current workflow state` — `[README:154]` · `$ splitbrief resume` `// resume an interrupted workflow` — `[README:153]`.
- Modes annotation: `--mode quick · standard · speckit  // 1 · 4 · 6–7 planner calls · gates: none · spec · spec + plan` — `[FE:27-29]`, `[README:158]`.
- Small print (the maturity note): `Early software, pre-1.0. Cost is reported per run, never promised. Two numbers will decide whether this design earns its complexity — first-pass rate, and how much the cross-lab review catches that validation did not. Neither is measured yet.` — `[README:5,351,357-359]`.
- Footnote: `Node 22+ · a git repo with one commit · macOS and Linux` — `[README:74,387]`.

## (e) TUI captures (rendered 2026-09-08, `.test-artifacts/ui/`, gitignored)

1. `catalog-1-04160c90be94c59fc4bf/workflow-implementation/120x40/implementation/frame.png` — Build phase: pipeline bar, `* T1 … (modify) · Ollama · fixture-model-v1`, `@ Implementer activity 1 update`, `└ Read`, byline `Implementing… 0:00 · git:none`. The row grammar for C2's transcript.
2. `catalog-1-326f30197021f6fb8413/workflow-review/120x40/review/frame.png` — a review artifact panel over the tiered-approval prompt: `Approval · scope`, `a Approve once / s Approve this session / w Approve always / x Deny`, `w writes .splitbrief/approvals.json`. The closest real mid-run capture.
3. `catalog-1-a9f2da2d7ec244ae972d/workflow-planning/120x40/planning/frame.png` — Plan phase, one status line, byline `Compiling briefs from spec… 0:00`. Near idle; not proof.
4. `catalog-1-3a6c2411f57c3e092cfd/home-reviewer/120x40/ready/frame.png` — home: ASCII wordmark, `PLAN Claude Code CLI · Claude Sonnet 4 / BUILD Ollama · Qwen 2.5 Coder 7B / REVIEW OpenAI Codex CLI · GPT-5 Codex`, `standard · 2 skills · /crew to change`. Three seats as the product shows them; idle.
5. `catalog-1-3237df894bd0445873e2/workflow-brief-recovery-task-blocked/120x16/review/frame.png` — `CONTRACT BLOCKED · BRIEF r1 | CHECK r1 · BECAUSE QUALITY ISSUE T901: Task T901 is missing an acceptance condition. · SO approval and implementation are unavailable until errors are cleared · NOW retry, edit, or reject`. The contract refusing a bad brief — the reference for C1's second line.
6. `catalog-1-2dcbb93cda85763fffc2/workflow-failure/120x40/failure/frame.png` — `error · Synthetic runner failure`, `Workflow cancelled`. A failure state; not proof.
7. `catalog-1-9dbdca05628529ea8e3b/summary-success/120x40/success/frame.png` — `✓ SPLITBRIEF complete`, `Saved $0.01`, `1/1 tasks · 1 local`, phase breakdown. Cost split per run; fixture numbers, not for the page.
8. `catalog-1-1c083b7e601e2fb1156c/overlay-cost-drilldown/120x40/ready/frame.png` — `Cost · breakdown · By seat PLAN / BUILD / REVIEW · By phase · By task`. Fixture numbers, not for the page.

Proof shot: none as an image — every capture carries fixture names (`fixture-model-v1`, `Synthetic local runner`) and §0 rules out image assets. The proof is C2's transcript, typed in the grammar of capture 1, with capture 5 as the reference for the contract's refusal state.
