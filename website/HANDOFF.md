# SPLITBRIEF website — handoff (v2, 2026-09-10 — lower page built, final critique fixed, gates green)

The v1 page (nav, hero, diagram, motion) was built 2026-09-06…09 by a fable pipeline. **The v2 lower page —
sections 02 · 03 · 04, the footer, the aura and the scroll choreography — was built 2026-09-09…10 by splitbrief:
`cursor-grok-4.6-xhigh` and then `cursor-grok-4.6-xhigh-fast` implementers working one Task Brief at a time,
`cursor-grok-4.6-high` in plan mode reviewing each run, and fable orchestrators compiling the briefs, running the
gates and holding the evidence.** No fable seat edited `website/` source at any point; the docs in this folder and
the `DESIGN.md` amendments are the only things a fable seat wrote.

## Read in this order

1. `DESIGN.md` — the design contract. §16 is the v2 lower page; §1–§14 are the hero and the shared rules. Every
   deviation the build made is recorded in the section it belongs to as a dated `v2 build, 2026-09-…` note. The
   sheet wins over the reference image; the dated notes win over the sheet's older prose.
2. `handoff/spec.md` — the v2 build spec: executor context, the gate table, the crew and ladder, the rule that
   turns a task into a brief, 62 tasks across six phases with mechanically checkable `Accept:` lines.
3. `handoff/exec-progress.md` — the phase ledger, one row per stage.
4. `handoff/exec.md` — the evidence: every gate output verbatim, every correction with its arithmetic, every
   ruling. This is the file that explains why the build differs from the sheet anywhere.
5. `handoff/residuals.md` — what is knowingly left open, including the owner's own three items.
6. `handoff/requirements.md` (22 REQ, 9 non-goals, 26 decisions), `handoff/prompt.md`, `handoff/plan.md`,
   `handoff/design-notes.md` and the two design critiques — how the design was arrived at.
7. `handoff/a11y-p6.md` — Lighthouse, the CDP accessibility tree, contrast and focus order at the end of the build.

**The v1 build's own evidence is intact under `handoff/v1/`.** Nine of its files share a name with the v2 mirror
(`spec.md`, `exec.md`, `exec-progress.md`, `requirements.md`, `plan.md`, `prompt.md`, `exec-plan.md`,
`extension-research.md`, `reference.png`) and four are captures (`p2fix-fold.png`, `p6-390.png`, `p8e-*.png`);
all thirteen moved down one level so the v2 files could take the names the spec's read order uses. Nothing was
lost — the v1 `p6-390.png` is the v1 phase-6 phone capture and has nothing to do with this build's `p6` tag.

**There are no `visual-diff-p<N>.md` or `critique-p<N>.md` files.** The owner ruled on 2026-09-09 that no per-phase
fable critic or visual-diff task would run — one fable pass at the very end instead — so those tasks were skipped
in every phase and the files were never written. `handoff/comps/visual-diff-comp.md` (the design comp's own 59-row
geometry table) is the one file of that kind that exists.

## State at finish

| phase | what | result |
|---|---|---|
| 1 foundation | markup v2, tokens, shared grammar, footer, capture harness, e2e split | done — P1a 13/13 and P1b 14/14 briefs, exit gates green, `p1` captures kept |
| 2 · 3 · 4 sections | `s02.css`, `s03.css`, `s04.css` + `s04-tiers.css` and their three e2e files | done — one merged run, 8/8 briefs on one attempt each, every sheet diffed rule by rule against its contract with 0 deviations, review `pass_with_notes` |
| 5 aura + scroll | rail, dot fields, fragments, stops, reveals, the spark, reduced motion | done — P5a 11/11 and P5b 21/21 briefs, every P5b brief on attempt 1, review `pass_with_notes` with no critical findings |
| 6 tiers, craft, a11y, docs | `tiers.e2e.ts`, README v2, two capture-harness fixes, the traces placed first, the a11y and Lighthouse pass, these docs | done — 8/8 briefs, one ladder rung spent, exit gates green |
| 3.5 independent review | four read-only grok seats over the whole `website/` delta, split by dimension | done — 12 candidates, 6 Major fixed, 5 to residuals, 1 rejected by measurement |
| 4 final critique | one fresh critic on the rendered captures, then the fixes the owner's lane ruled in scope | done — 7/10 REVISE with 2 blocking became 6/6 briefs on one attempt each, 0 rungs, 0 reds waived; Corrections V, W, X |

Final gate output, on the tree as it stands:

```
$ npm run typecheck                exit 0
$ npm run lint …                   exit 0   (2 inherited noDescendingSpecificity warnings, lower.css:107, reveal.css:9)
$ npm test                         Test Files 12 passed · Tests 55 passed (55)
$ npm run e2e                      55 passed · 11 skipped · 0 failed (20.3 s) — 66 of 66 reported, summary printed
$ npm run build                    exit 0
    dist/index.html                23.07 kB │ gzip: 6.03 kB
    dist/assets/index-*.css        26.09 kB │ gzip: 6.44 kB
    dist/assets/index-*.js         25.98 kB │ gzip: 10.44 kB   (budget: own ≤ 16 KB gz, total ≤ 90 KB)
G-cap    PASS  no file over its approved cap · index.html markup 196 (cap 220), file 337 (cap 380)
               no index.ts · hex only in tokens.css · quoted font-family only in base.css
G-tree   PASS  nothing outside website/ changed since the P1a baseline · nothing staged
HERO-JSON(p8)  empty diff vs p0 at 1440, vs p1 at 1440 and at 1920
HERO-CROP(p1, p8)  [None, None] — byte-identical, unmasked, at both widths
Lighthouse     desktop a11y 96 / performance 100 · mobile a11y 96 / performance 94 (see residuals R-P6-8)
Rendered 1440  .s02 6 · .s03 4 · .s04 14 fragments · hero 19 · zero keep-clear violations of any class
Traces         1440: .s04 only · 1600 and 1920: all three sections
Dot fields     lit 37 / 6 / 37 / 8 / 37 / 8 = 133 cells, worst row 30.6 % against a 35 % cap,
               area 10 241 px² against a 76 205 px² budget (Correction W raised the two relief profiles)
REQ-015        PASS — 5 of 5 consecutive capture pairs, all 60 file comparisons BYTE-IDENTICAL
               (Correction N's amplitude/extent tolerance was not needed at any width)
```

## Decisions

- **D-1** FHD = a capped container — (§11 v2): `--content-max` 1392 at ≥ 1600 with the aura full-bleed across 264 px gutters; the lower type steps one notch; the hero changes only its width (diagram…
- **D-2** Reveals by IntersectionObserver one-shot + CSS, the spark alone on a scroll timeline — (§16.6): sections paint once on arrival and stay.
- **D-3** Hybrid aura — CSS for the rail, spark, stops and reveals; JS for the seeded placer, the one-time dot draw + shimmer and the observer.
- **D-4** One class, `.fragment`, for every hovering string — (the hero's existing name); §16's `.frag`, `.frag--gutter`, `.frag--glyph` are not created — the placer decides positions per tier on every resize, so CSS needs…
- **D-5** The section pools and layer specs live in `features/fragments/pool.ts` — , not `features/aura/pool.ts`: a pool is placer data, and `aura/` must not import `fragments/`.
- **D-6** `ticker.ts` is promoted to `src/lib/ticker.ts` — on its second consumer (the dot shimmer), one brief with the two import edits approved out of bounds.
- **D-7** The pure placer moves to `features/fragments/place.ts` — (`mount.ts` keeps the DOM half; `mount.test.ts` becomes `place.test.ts`) so the hero and the three sections share one placer through `main.ts`;…
- **D-8** Opacity channel — the placer's existing channel 3 (`hash(seed, k, 3, 0)`) scaled to the layer's range; §16.5's `hash(seed, i, 0, 3)` notation names the same channel.
- **D-9** Pre-reveal state is `opacity: 0` only — ; the 8 px rise comes from the `enter` keyframes' `from` (with `fill-mode: both` it shows during the delay, so the render is §16.6's).
- **D-10** The pre-reveal rule is scoped to `section:not(.is-in)` — so the animated element's base opacity is 1 once `.is-in` lands (an implicit `to` of 0 would hold the element invisible under `fill-mode: both`).
- **D-11** The capture set is ten PNGs + two JSON per tag — `-1440`, `-fold`, `-390`, `-1920`, `-1920-fold`, `-1024`, `-768`, `-1920-s02`, `-1920-s03`, `-1920-s04` (a missing section skips its fold) and `-hero-1440.json`,…
- **D-12** The hero stability check is two-fold — `diff` of the hero JSON against `p0` (P1 on), and a byte-identical crop of the hero region against `p1` (P2 on; `python3` + PIL…
- **D-13** The hero fragment count floor is ≥ 18 at 1440×900 — (`motion.e2e.ts`), the exact count recorded in `DESIGN.md` §7.5 by the orchestrator after P1.
- **D-14** `hero.css` scopes `.steps` and `.line` under `.hero`, and `motion.css` scopes its three `.steps` selectors the same way — (its `.line` rules already read `.hero h1 .line`): 03's `ol.steps` and 04's breath lines reuse the class names with their own rules (`s03.css`, `s04.css`).
- **D-15** `.rule--bleed` lives in `footer.css` — (it is the footer's seam) and `footer.css` lands in P1 with the shell, not P4: ruling 2 replaces the footer with the hero's anchors, and P1's skeleton must not…
- **D-16** The footer reuses `nav.css`'s unscoped `.wordmark` and `.links` rules — (§16.4: "the nav's wordmark verbatim", "the nav links' markup and states"); `footer.css` declares only what differs (`text-transform: none` on the wordmark and…
- **D-17** `canvas.dots` are markup with `data-seed/cols/rows/profile` — and CSS positions (`sNN.css`), drawn by `dots.ts`; before P5 they are transparent boxes.
- **D-18** Section keep-clear uses element boxes, not line boxes — the same-line rule against a paragraph's box is stricter than against its lines, so `aura.e2e.ts`'s line-box assertion holds a fortiori. **Superseded in the build:** `sectionKeepClear` walks every TEXT NODE under `.grid` and measures per line with `Range.getClientRects()`; element boxes are not stricter, they are differently shaped. See `DESIGN.md` §16.9's build note.
- **D-19** e2e is split by concept into seven files — (`lower`, `s02`, `s03`, `s04`, `aura`, `scroll`, `tiers`, plus `frames` for captures) rather than §13's one `lower.e2e.ts`: §16.9's ten items exceed 200 lines,…
- **D-20** Brief runs are capped at 12 — (splitbrief standard): P1 and P5 run as two sequential splitbrief runs each (P1a markup+styles, P1b markup+tests; P5a modules, P5b wiring); P2–P4 and P6 are one…
- **D-21** The steps anchors get a 24 px hit box — (`padding-block: calc((24px - 1lh) / 2); margin-block: calc((1lh - 24px) / 2)`), not 44: the 18 px pitch is §4 geometry ruling 2 protects; 24 px is the WCAG…
- **D-22** The 10 reasoned out-of-tolerance rows of `visual-diff-comp.md` are inherited — a site row that matches the comp's measured value within ±3 % is ✓ by that reason (tick-list pitch 16 at 1920; whole-pixel row pitch 14; 11 px row advance;…
- **D-23** Product-true copy deviations from the reference stay — (§16.1–16.2): `typescript`, `Out of bounds:`, statement 2 by ruling F17, the session path on row 21, `▶` in `--ink-3` (F25, owner residual), `Build → Verify` and…
- **D-24** The dot-field density cap is measured on lit cells — (count × 77 px² over the six specs < 3 % of the lower page's 1440 × 1764), not on canvas boxes (3.2 % — boxes are mostly empty).
- **D-25** The transcript's `.s03 .aura { overflow: visible }` and the steps grammar live in `s03.css` — (their only consumer), `.aura`'s base in `aura.css`.
- **D-26** Docs are written by Fable — (`HANDOFF.md`, `handoff/`, `DESIGN.md` amendments), `README.md` by the implementer from a brief: HANDOFF's "state at finish" needs the run's evidence, which only…

## Residuals

`handoff/residuals.md` is the list. The ones a maintainer meets first:

- **Traces are placed everywhere except `.s02` and `.s03` at 1440** (R-P6-1), where an exhaustive origin scan shows
  there is no legal position for one. Placing each layer's traces before its strings, and exempting panel lines from
  the same-line rule, is what made them reachable; no clearance was weakened to get them.
- **Mobile Lighthouse performance is 94**, one point under the floor, entirely from the render-blocking Google
  Fonts stylesheet under a throttled profile (R-P6-8). Desktop is 100.
- **The three owner items from stage 1** are still open by ruling: `▶` in `--ink-3`, the two phase vocabularies
  (`Build → Verify` beside `EXECUTE / REVIEW`), and no closing call to action.
- **`DESIGN.md` §16.8's page height at 1920 is 25 px high** (3 064 measured, 3 089 written) and the four spark
  positions derived from it still pass on tolerance (R-P6-6).
- **Two capture nondeterminisms are admitted deliberately**: the hero's three ghost canvases, and vignette
  dithering on the mid-width captures, which is why "byte-identical" carries a two-part tolerance (R-P6-7).
- **Five rows of the final critique are visual-design decisions, not defects**, and are held for the owner with
  the critic's own reasoning in `handoff/residuals.md` (R-F-1 … R-F-5): section 03's left column has no tail
  element where 02 has its tick-list, and the critic proposes a differently-shaped one; the three section-04
  callouts do not share one internal grid, so their content edges do not align; `codex°` and `GPT-5.6°` set
  footnote markers that no note on the page answers, while the same glyph is the wordmark's brand device;
  section 04 has no hot spot across its 686 px, which §16.8 declares deliberate; and the nav's 3 × 3 dot mark
  sits where a menu control sits. Each needs a decision only the owner should make, so none was built.
- **The critique's stated cause for its second blocking row is wrong and is recorded as wrong.** It reads the 03
  skyline as stopping short of the 03 → 04 border. Measured at 1440, exactly 44.0 px of that canvas paint inside
  section 04, which is what §16.8 specifies. What was short was the field's density, and that is what
  Correction W raised.

## How to run

```sh
cd website
npm install
npm run dev                 # vite on :5173
npm run build && npm run preview        # dist/ on :4173 — everything below expects this
npm run typecheck && npm run lint && npm test && npm run e2e     # the gate, in that order
SHOT_DIR=<dir> SHOT_TAG=<tag> npm run shots                      # 10 PNG + 2 hero JSON
SHOT_DIR=<dir> SHOT_TAG=<tag> npx playwright test tests/e2e/frames.e2e.ts   # spark + transcript frames
npm run render-static       # the frame-0 ghost art for the <pre class="ghost-fallback"> blocks
```

Only one process can hold :4173 — `playwright.config.ts` sets `reuseExistingServer: false`, so a second runner
aborts rather than sharing. Kill a stray `vite preview` before gating.

## Where things are

| sheet section | files |
|---|---|
| §1 tokens · §2 skeleton | `src/styles/tokens.css`, `src/styles/base.css`, `index.html` |
| §3 nav · §4 hero · §5 card · §6 ghosts · §7 motion | `src/styles/{nav,hero,cta,diagram,brief,diagram-compact,motion}.css`, `src/features/diagram/*`, `src/lib/ticker.ts` |
| §16.1 section 02 | `src/styles/s02.css`, `tests/e2e/s02.e2e.ts` |
| §16.2 section 03 | `src/styles/s03.css`, `tests/e2e/s03.e2e.ts` |
| §16.3 section 04 | `src/styles/s04.css` + `s04-tiers.css`, `tests/e2e/s04.e2e.ts` |
| §16.4 footer | `src/styles/footer.css` (`.rule--bleed` included) |
| §16 shared grammar · tiers | `src/styles/lower.css` + `lower-tiers.css`, `src/styles/panel.css`, `tests/e2e/lower.e2e.ts`, `tests/e2e/tiers.e2e.ts` |
| §16.5 aura | `src/styles/aura.css`, `src/features/fragments/{place,pool,mount}.ts`, `src/features/aura/{dots,keep-clear}.ts`, `tests/e2e/aura.e2e.ts` |
| §16.6 scroll | `src/styles/reveal.css`, `src/features/aura/reveal.ts`, `tests/e2e/scroll.e2e.ts` |
| §14 captures | `tests/e2e/shots.e2e.ts`, `tests/e2e/frames.e2e.ts` |
| composition | `src/main.ts`, `src/styles/main.css` (19 imports, layer order fixed) |

## Next

Run **nuke-verify** with `intent: handoff/spec.md` in a fresh session — that file is a copy of the run dir's
`RUN/spec.md`, which is what `handoff/residuals.md` names; either path reaches the same spec. Then work the
owner's follow-ups from `handoff/residuals.md`. Do not `git add` or `git commit` on this branch from an agent seat; the owner reviews and
commits by hand.
