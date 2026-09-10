# Residuals — accepted, not fixed

Findings that survived a review cycle and were deliberately left standing, with the reason and the owner of any later fix. Nothing here is a blocker for the phase it was raised in.

## P1a (run `.splitbrief/runs/2026-09-09-153506-web-v2-p1a`, review cycle 2, verdict `pass`)

| # | Residual | Evidence | Disposition |
|---|---|---|---|
| R-1 | G-lint prints `Found 1 warning.` — `lint/style/noDescendingSpecificity` on `.notes` following `.grid > .notes` in `src/styles/lower.css` | recorded G-lint `exit=0` on T008 attempt 3; Biome's own warning block in `validation.md` | Accepted. The selector order that triggers it is the order T-108a prescribes. The gate exits 0. Reordering would break the contract; suppressing it would need a comment, and lower.css carries none by ruling. |
| R-2 | T004 Accept `cmp p0-1440.png t104-1440.png` is not silent (`differ: char 94969, line 322`) | `T004/accept-1.txt`; masked re-run via `masked-cmp.py` shows identical bboxes | Waived by ruling for P1a. Full-page PNGs are not byte-deterministic inside the three `.stage canvas` boxes. T-104 is judged by HERO-JSON identity, which recorded an empty diff. Permanent fix is brief T-100h (T001) in the P1b lane; still open there as of 17:5x, attempt 2 pending. P1b closes this row. |
| R-3 | `src/styles/tokens.css` lost `--font-wide` although T-105 said "Nothing removed" | reviewer note, cycle 2 | Not P1a, and not an accident. The Space Mono retirement is a team-lead ruling recorded in `RUN/exec.md`; it lands in a P1a-owned file via P1b brief T010, which is done with accept `ABSENT --font-wide → 0`. Closed. |
| R-4 | `tests/e2e/shots.e2e.ts` `settle()` also freezes `document.hidden`, `requestAnimationFrame` and canvas `clearRect`/`drawImage`, beyond the T-103 contract | reviewer note, cycle 2, `shots.e2e.ts` lines 47-52 | Not P1a, and not a landed contract either. Per phase-p1b (17:5x), those six lines are unfinished scratch work from P1b brief T001 (T-100h) attempt 1, which its 20-minute alarm killed mid-experiment; line 4 deletes the `document.hidden` override line 1 installs, and the last two no-op `CanvasRenderingContext2D.prototype.clearRect` and `.drawImage` for the whole page. P1b rejected that attempt rather than gating it. Attempt 2 drops the prototype patches and keeps a real freeze, so this closes as the contract correctly implemented, not as an accepted overreach. The P1a scroll-through, timeline guard, six new tests and hero-boxes writer all match T-103. P1b closes this row. |
| R-5 | REQ-001's "five v1 stylesheets gone" is unmet — `main.css` still imports `routes.css`, `brief-sheet.css`, `manifesto.css`, `ladder.css`, `record.css` | reviewer note, cycle 2 | By design for P1a. T-111 says "Nothing removed"; it only inserts the four new `layer(sections)` imports. Removal is P1b brief T008 (T-116), the last brief of that run, with a corrected Accept of 15 lines and 15 remaining files. Open there. P1b closes this row. |
| R-6 | `scroll-behavior: smooth` lives in `src/styles/base.css`, not in any P1a sheet | reviewer note, cycle 2 | Not P1a. REQ-002's smooth-scroll clause is P1b brief T002 (T-117), which is done with gates green and accept `STRING scroll-behavior: smooth 1 → 1`. Closed. |

R-2, R-4 and R-5 are open in the P1b lane; phase-p1b records their closing evidence once its T001 and T008 land. R-1 is the only residual P1a owns and accepts standing.

## From the sections run (P2 + P3 + P4, `.splitbrief/runs/2026-09-09-174656-web-v2-sections`, review `pass_with_notes`, 34 criteria PASS, 0 FAIL, 0 Critical)

1. **`tests/e2e/s02.e2e.ts` phone heights are tighter than the contract.** T-203 specifies `.s02 .panel` h 713 ±3 % and `.s02` h 1513 ±3 % (that is ±21 px and ±45 px); the landed test asserts a ±3 **pixel** bound instead. It passes today, and stricter is never a correctness risk, but it is brittle: a later phase that moves the phone panel by 5 px stays inside the contracted tolerance and still reddens this test. `s03.e2e.ts` and `s04.e2e.ts` use true ±3 %. Worth normalising to ±3 % when P5 or P6 next touches the phone tier — no fix brief was filed because the reviewer raised it as a Warning, not a Critical, and the run's own rule is that a tolerance is never loosened by the orchestrator.
2. **Phase-end gates were not run by this run.** G-build, G-shots, G-cap, G-tree, HERO-JSON and HERO-CROP belong to the phase exit, and Correction 2 skipped this run's critic and visual-diff tasks by owner ruling. The review says so explicitly and asserts nothing about them. They are still owed for phases 2, 3 and 4 at whatever point the owner runs the single Fable pass at the end.
3. **Not this run's, already handed to phase-p1b and being fixed there:** the hero step anchor measuring 23.99999237060547 against the 24 px REQ-002 floor, intermittently (p1b measured 2 of 15 anchors over five loads, always the first one).

## P1b (run `.splitbrief/runs/2026-09-09-171455-web-v2-p1b`)

| # | Residual | Evidence | Disposition |
|---|---|---|---|
| R-P1b-1 | REQ-015's "two capture sets byte-identical" cannot be met in Phase 1: `span.spark` rides a `ViewTimeline` and `settle()` skips view timelines, so a 6 px strip (x 1293–1299 at 1440, x 1573–1579 at 1920) can differ between two sets of one build | `T001/accept-2.txt` and the per-tag bboxes in `validation.md`; the probe recording `{"name":"ride","target":"span.spark","timeline":"ViewTimeline"}` | **Deferred to the P5 exit by ruling (2026-09-09).** Not a defect in T-100h: the spark did not exist when that brief was written (P1a's `aura.css` Accept asserted `ABSENT spark`) and it belongs to §16.6, briefs T-510 / T-513. T-100h's own contract — the three ghost canvases — is met: every fold, every section fold and the 390 / 1024 / 768 full pages are byte-identical, and both hero JSONs match. phase-p5b inherits the criterion: its `shots.e2e.ts` freeze must extend to the spark by pausing the animation (e.g. `animation-play-state: paused` on `.spark` before capture) and NEVER by setting `currentTime` on a view timeline, which throws in Chrome. |
| R-P1b-2 | The spark difference is **intermittent**, so a single green capture pair does not demonstrate determinism | pair 1 differed in the spark strip; pair 2, same code, matched on all ten PNGs | Recorded so the P5 exit does not close REQ-015 on one lucky pair. Repeat the comparison, or freeze the spark and prove it. |
| R-P1b-3 | The step anchors' `getBoundingClientRect().height` reads `23.99999237060547` on roughly 1 load in 30 | 30-sample measurement in `validation.md`; `offsetHeight` reads 24 on all 30 | Closed by T013 (`min-height: 24px` on the anchor) + T014 (assert `offsetHeight >= 24` AND rect `>= 23.99`). REQ-017's floor is met on every sample; the shortfall was a float32 artefact of subtracting two independently rounded edge coordinates. |
| R-P1b-4 | At 1920 the hero JSON differs from `p0` — content box x 304 → 264, w 1312 → 1392 across all 34 entries | `t115` / `t012` / `t013` hero-1920 JSON vs `p0` | Not a regression. `--content-max: 1392px` under the `min-width: 1600` tier (REQ-011's FHD change, P1a's T-105), which `p0` predates. HERO-JSON is defined at 1440 only, where every diff is empty. |
| R-P1b-5 | `t505-hero-1920.json` (phase-p5a) is a STALE 1920 target: it records `.works` bottom `1094.5` | captured before P1b's T012 | The correct post-T012 value is `1070.5`. A P5 or P6 exit that diffs 1920 hero JSON against `t505` would report T012's ruled fix as a regression. |

## R-P5b-6 — `scroll.e2e.ts › reduced motion equals the settled page` HANGS the whole e2e suite (2026-09-09 22:0x)

**Symptom.** The test never returns. Two Playwright workers spin at 100 % CPU indefinitely; Playwright's 30 s
timeout cannot preempt them because the loop is synchronous inside the worker process. A `sample` of the worker
shows it inside V8 microtasks doing `Builtins_StringEqual`. Reproduced standalone: `npx playwright test
tests/e2e/scroll.e2e.ts` ran 3 of 4 tests then sat in the fourth until a 420 s alarm killed it. Consequence: no
G-test can complete, so no phase-exit gate, no `p5` capture set, no REQ-015 pair run and no review packet.

**Immediate mechanism.** The assertion is `expect(await page.screenshot({fullPage:true, mask})).toEqual(reduced)`
on two ~1.1 MB Buffers. When they differ, `expect`'s differ tries to render a diff of two million-element
structures. `expect(a.equals(b)).toBe(true)` is the byte comparison the test actually wants and it fails in
milliseconds. **This part is a defect regardless of the ruling below and must be fixed either way** — a test that
hangs instead of failing costs a whole phase.

**Why the buffers differ — measured, three findings.**

1. *The fragments' hover animation carries a negative per-fragment delay.* `src/features/fragments/mount.ts`
   builds it with `delay: -phase * duration * 1000` and `iterations: Infinity`. `settle()` seeks infinite
   animations with `pause(); currentTime = 0`, which lands each fragment at ITS OWN phase, not at its base
   position — while the reduced-motion page never runs the animation at all and sits at the base. Measured at
   1440x900: identical fragment count (57), identical texts, identical x, and y differing per fragment by 13 to
   62 px. §16.9 item 8 names `currentTime = 0` explicitly, so the DESIGN text carries the same flaw.
2. *Cancelling instead of seeking closes most of the gap but not all of it.* Replacing the seek with
   `animation.cancel()` for the infinite ones drops the difference from **120 544** differing pixels to
   **40 558**. So the phase is the largest cause but not the only one.
3. *The residual 40 558 px is a uniform faint ghost of every text glyph across all three sections* — an
   anti-aliasing difference, not a layout shift. Layout is provably identical: the three `.grid` boxes are the
   same to the pixel in both modes (`[64,1165,1312,508] [64,1722,1312,339] [64,2213,1312,595]`), as are page
   height (2992), fragment count and `.reveal` count. The cause is compositing: an element that has been animated
   renders text through a GPU layer with different anti-aliasing than one that never animated. Byte-identical
   full-page equality between a reduced-motion page and a page whose reveal animations have run is therefore not
   achievable by any change to the test's seeking.

**DESIGN's own cheaper form does not rescue it.** §16.9 item 8 offers "a cheaper form diffs only the `.grid`
boxes". Measured on those exact crops, reduced vs cancel-to-base: 14 353 / 632 / 1 726 differing pixels. It fails
too, for the same anti-aliasing reason.

**Options put to the team lead (none taken unilaterally — this is a tolerance question).**
A. Keep a pixel comparison but give it a tolerance, and fix the hang. Needs a ruling on the number.
B. Replace the pixel equality with a layout equality: assert the `.grid` boxes, the page height, the `.reveal`
   count and every text-node rect are identical between the two modes. All already measured identical, so it is
   deterministic, AA-immune, and still tests what item 8 is for.
C. Drop the assertion.
Tools: `RUN/tools/diag-settle.ts` (reproduces the test's two captures), `diag-settle2.ts` (layout probe),
`diag-settle3.ts` (compares seek-to-0 against cancel-to-base and dumps both PNGs).

## R-P5b-7 — `aura.e2e.ts › fragments keep clear` still fails after F001: three placer/test disagreements

F001 fixed the violation class it was written for (panel rows, tree rows). Six violations remain across 38
fragments, and every one traces to `src/features/fragments/place.ts` disagreeing with the test about the same
geometry. `place.ts` is P5a's file and is NOT in this run's changed set, so the fix is a scope question.

1. **Text rects are grown horizontally only.** `placeFragments` builds `taken` as
   `left - (TEXT_GAP - MARGIN), right + (TEXT_GAP - MARGIN), top: rect.top, bottom: rect.bottom` — no vertical
   growth at all. Vertical clearance comes only from the 64 px travel band, which extends UP. A fragment sitting
   just BELOW a text line is therefore accepted by the placer and rejected by the test, which grows text by 24 px
   in all four directions. This is the `R1 text-24 "validate(task)" @196,1961 vs span.line @64,1902` class.
2. **`GLYPH.height = 11` against a rendered height of 16.0.** Measured on every fragment in all three sections.
   The 5 px shortfall shrinks both the travel band's lower margin and `onLine`'s vertical test, so the placer
   misses same-line cases the test catches. This is the `R5 same-line(96)` class.
   (`GLYPH.width = 6.6` is EXACT — estimate and measurement agree to the decimal on every sample. Not a defect.)
3. **Two different sources for the rail's x.** The placer computes `railX = grid.right - var(--rail)` = 1296; the
   test reads `.rail`'s own `getBoundingClientRect().left` = 1295. With a ±8 px strip, that 1 px puts a boundary
   fragment on opposite sides: `R3 rail "fewer blind spots" @1169` clears the placer's strip by 0.8 px and
   violates the test's by 0.2 px.

Also noted while reading the file, not currently a failure: the `layer.gutterGlyphs` loop pushes its four
placements after checking ONLY the 60 px spread against other placements — it never consults `taken`, the text
rects or the rail strip. A gutter glyph can legally land on top of anything.

Diagnostic: `RUN/tools/diag-keepclear2.ts`, which mirrors the post-F003 test rule for rule and labels each
violation R1–R5.

### R-P5b-7 amendment (2026-09-09 22:3x) — measured before compiling anything

Three refinements found by measuring rather than reasoning. They change the SHAPE of the fix, so nothing was
compiled against the original description.

**`GLYPH.height = 11` is right for the hero and wrong only for the sections.** Measured across the whole page:
19 fragments at exactly 11.00 px (the hero's `.fragments`) and 38 at exactly 16.00 px (the three lower sections,
which `aura.css` styles differently). Changing the constant to 16 would break the hero. The fix that matches the
existing design is a per-layer `glyphHeight` on the `Layer` type, which already carries `lineGap`, `opacity`,
`seed` and `gutterGlyphs` — a type change plus four call sites, not a constant edit.

**A fourth disagreement: the placer and the keep-clear map use different coordinate origins.**
`sectionKeepClear` returns section-relative rects; `placeFragments` is called with `.aura`'s
`clientWidth`/`clientHeight` and positions elements inside `.aura`. Measured: `.aura` sits 1.0 px below its
section in 02 and 03 and 0 px in 04, with `clientH` 556 against a section height of 557. Every keep-clear rect is
therefore off by 1 px vertically in two of the three sections — small, systematic, and in exactly the direction
that produces the boundary failures.

**The rail disagreement is a definition difference, not a bug on either side.** `.rail` is 1 px wide at left
1295, spanning 1295–1296. The placer's `railX = grid.right - var(--rail)` = 1296 is the rail's RIGHT edge; the
test reads `.rail`'s LEFT edge, 1295. The two ±8 strips are 1288–1304 and 1287–1303. Both should read the same
source; the `.rail` element's own rect is the one the test already uses.

So the fix is four items across two files: `place.ts` (vertical growth of text rects, per-layer glyph height) and
`keep-clear.ts` (rail source, aura-vs-section origin). `place.ts` is P5a's file; `keep-clear.ts` became this
run's when F001 landed in it. Diagnostic: `RUN/tools/diag-geom.ts`.

## R-P5b-8 — REQ-015 five-pair determinism FAILS on 8 sub-perceptual pixels, and NOT on the spark (2026-09-09 22:3x)

`pairs.sh 5` ran five CONSECUTIVE capture pairs, each half a full `npm run build && npm run preview && npm run
shots`, 12 files per half (10 PNG + 2 hero JSON). Result:

```
## pair 1   files compared: 12 · differing: 0
## pair 2   files compared: 12 · differing: 0
## pair 3   files compared: 12 · differing: 0
## pair 4   DIFFERS  fold.png        files compared: 12 · differing: 1
## pair 5   files compared: 12 · differing: 0
  total differing entries across all pairs: 1
```

So four of five pairs are byte-identical across all twelve files, and REQ-015 as written ("five consecutive pairs,
each byte-identical across all ten PNGs and both hero JSONs") is NOT met.

**What the one difference actually is.** `req015-4a-fold.png` vs `req015-4b-fold.png`, 1440x900:
**8 differing pixels out of 1 296 000, each off by exactly 1 in exactly one channel.** That is the smallest
possible non-zero difference. Bounding box (589,78)-(1371,819), but the pixels are isolated, not a region:

```
  ( 598,  78) delta (1,0,0) a(14,15,18) b(13,15,18)   OUTSIDE every canvas
  (1305, 141) delta (1,0,0) a(13,15,18) b(14,15,18)   OUTSIDE every canvas
  (1273, 307) delta (0,0,1) a(14,15,18) b(14,15,19)   OUTSIDE every canvas
  ( 651, 464) delta (0,1,0) a(49,66,98) b(49,65,98)   inside .stage canvas 0
  (1089, 643) delta (0,0,1) a(15,17,20) b(15,17,21)   inside .stage canvas 2
  (1370, 706) delta (0,1,0) a(13,14,17) b(13,15,17)   OUTSIDE every canvas
  ( 589, 738) delta (0,0,1) a(14,16,20) b(14,16,19)   OUTSIDE every canvas
  (1010, 818) delta (1,0,0) a(14,16,20) b(15,16,20)   OUTSIDE every canvas
```

**Three conclusions that matter.**
1. **T008's spark freeze worked.** p1b's failure signature was a 6 px STRIP at x 1293 / 1573. Nothing here
   resembles that. The spark is no longer a source of nondeterminism.
2. **The ghost-canvas mask would not fix it either.** Six of the eight pixels are outside every `.stage canvas`
   box, so `masked-cmp.py`'s masking does not make this pair identical.
3. **The cause is rasterizer rounding on the dark vignette gradient.** Six of the eight sit on background values
   in the 13-21 range — the vignette, not content — and every delta is a single least-significant bit. This is
   GPU gradient dithering, sub-perceptual and invisible at any viewing condition.

**Rate, measured, not assumed:** 1 pair in 5, 1 file in 12, 8 pixels in 1 296 000.

**Options for the team lead — a tolerance question, so nothing decided here.**
A. Keep five consecutive pairs but define "identical" as max channel delta <= 1 (equivalently: zero pixels
   differing by more than 1). That admits exactly this class and still catches every real regression, including
   the spark strip that motivated REQ-015. My recommendation.
B. Keep byte-identity and remove the source — the vignette gradient's dithering. A visual design change to chase
   an invisible difference.
C. Keep byte-identity and accept a longer run to find five clean pairs by luck. Not a fix; the rate makes a clean
   run of five roughly a coin flip.
Evidence: `RD/req015-pairs.md` and the 120 capture files `RUN/shots/req015-*`.

## R-P5b-9 — with a CORRECT placer the fragment-count targets are unreachable (2026-09-09 23:0x)

F005 and F006 landed all four ruled geometry fixes. The result is measured, and it is a genuine conflict between
two things the spec asks for at once.

**What got fixed.** The corrected diagnostic (`RUN/tools/diag-keepclear2.ts`, which mirrors the e2e test rule for
rule) now reports **zero** R1 text-clearance, R2 mark, R3 rail and R4 fragment-overlap violations, against six
before. Only two same-line (R5) violations remain, and their cause is precise and is the fifth defect of the same
family: **`onLine` tests the same-line band at the fragment's REST position, while the e2e test samples it at
animated positions.** The fragments travel 64 px upward with a negative per-fragment delay, so at the test's two
samples they sit at arbitrary points in that travel. The placer must enforce the rule across the whole travel
band, exactly as it already does for rectangle overlap.

**What it costs, measured offline against the real DOM keep-clear** (`RUN/tools/dump-keepclear.ts` +
`seed-offline.ts`, 200 seeds per section, 1440x900, `.s02` 123 text rects / `.s03` 116 / `.s04` 64):

```
                                         briefs(t 10)  validation(t 7)  control(t 12)
correct placer, same-line over travel        best 3        best 2         best 13  (24/200 reach 12)
  vertical growth 18px                       best 3        best 2         best 15
  vertical growth 12px                       best 4        best 5         best 14
  vertical growth 6px                        best 4        best 5         best 14
  vertical growth 0px                        best 4        best 5         best 14
same-line at rest only (today's code)        best 4        best 3         best 15
24px growth + the two 64px edge strips freed best 7        best 5         best 16
```

Hero, measured on the rendered page: **15 fragments against `motion.e2e.ts`'s `>= 18`**, down from 19. The
vertical growth is the only F005 change that can reach the hero (`HERO.glyphHeight` is unchanged at 11 and
`HERO.gutterGlyphs` is empty).

**The conclusion.** `briefs >= 10` and `validation >= 7` are not reachable by ANY combination of the levers above.
The best case across all of them is briefs 7 and validation 5, and that requires freeing the edge strips, which is
a §16.5 visual change. The comp those counts came from was hand-placed against a much weaker clearance. The
clearance is the requirement — the team lead's standing ruling — so the counts are what must move.

**Note on the edge strips:** they are only 64 px wide on each side (0–64 and 1376–1440); the grid already spans
64–1376. The earlier P5b diagnosis that "`sectionKeepClear` blocks everything outside the content box below
1600 px" overstated it, and freeing them buys less than that wording implies.

**Options put to the team lead. Nothing decided here, and no target lowered, loosened or waived.**
A. Lower the four targets to the measured best under the correct placer: `briefs` 3, `validation` 2, `control` 12
   (needs a seed change — the current 8092 places 10), hero 18 → 15. Consistent with the standing ruling that a
   target is lowered to the measured best as a recorded spec correction.
B. Free the two 64 px edge strips below 1600 px (a §16.5 change) and set `briefs` 7, `validation` 5,
   `control` 16, then re-measure the hero.
C. Reduce the same-line clearance (96 px, traces 192 px) for the lower sections — the single biggest lever, and
   the one that most changes how the aura reads.
The fifth defect (`onLine` over the travel band) is compiled as brief F009 and is NOT spawned pending this ruling,
since it changes every number above.

### R-P5b-9 RESOLVED (2026-09-09 23:2x)

The team lead refused option A — owner ruling 3 requires the lower page to read FULLER than the old one, and
briefs 3 / validation 2 would have made 02 and 03 emptier than what the owner rejected. The clearance stayed the
requirement; the answer was to free legal area rather than shrink the aura to fit. Three briefs, all attempt 1:

- **F009** — `onLine` spans the whole 64 px travel, the fifth defect of the family.
- **F010** — the two tiers treat the margins the same way (Correction J). Below 1600 the aura was denied both
  margins outright; now the 24 px pad outside the grid applies in both tiers and the 96 px viewport-edge guard
  stays only where there is room for it.
- **F011** — the text growth is per-layer (Correction K), `textGap: { x, y }` beside `glyphHeight`. Hero
  `{ x: 18, y: 0 }`, the three lower sections `{ x: 24, y: 24 }`.

**Outcome: three reds became one.** Keep-clear reports ZERO violations of every class across all three sections,
from six. The hero is restored to **19** against its `>= 18` floor and no floor was lowered. Gate: 1 failed,
46 passed, 11 skipped; vitest 55/55; typecheck 0; lint 0. The single red is the count target, which the team lead
reserved and which F002 closes once the four numbers are set.

**The measured best, twice and in agreement** (offline against the dumped keep-clear, and live through the browser
against the real placer): briefs 7 at seed 8152, validation 5 at seed 9400, control 16 at seed 8997, against
current seeds placing 6 / 2 / 12. Only 3, 2 and 2 seeds of 200 reach those maxima, so a target set at the exact
best is brittle; the full distribution is in `exec.md` under fix batch 3.

## R-P5b-10 — REQ-015's delta-1 tolerance is very close but not quite sufficient (2026-09-09 23:3x)

Five consecutive pairs re-run on the FINAL tree (after the six geometry briefs and the seed change). Raw
byte-identity: pair 1 differs on `fold.png`, pairs 2–4 are clean, pair 5 differs on `1024.png` and `768.png`.

Under Correction G's ruled definition (max channel delta ≤ 1), **4 of 5 pairs pass and pair 5 fails**:

```
  pair 1  fold.png   8 px differ, max delta 1, 0 over tolerance   → OK
  pair 5  1024.png   690 029 px differ, max delta 2, 544 over tolerance → FAIL
  pair 5   768.png   640 354 px differ, max delta 4, 379 over tolerance → FAIL
```

**What the difference actually is, measured on `768.png` (4 335 360 pixels):**

```
  delta 1: 639 975 px  (14.762 %)
  delta 2:     377 px  ( 0.009 %)
  delta 4:       2 px  ( 0.000 %)
```

So 99.94 % of the differing pixels are at exactly one least-significant bit, and the entire tail above the
tolerance is **379 pixels, 0.0087 %**. On `1024.png` it is 544 pixels, 0.0120 %, with a maximum of 2. Every
over-tolerance pixel sampled sits on a near-black background value in the 13–30 range — the vignette gradient.

**It is NOT the ghost canvases.** The three `.stage canvas` boxes were measured at every capture width and masked
before re-comparing, which is this run's established convention for that nondeterminism. Masked, the counts are
essentially unchanged: 379 over-tolerance pixels at 768 and 544 at 1024. The cause is gradient dithering spread
across the whole page, and it shows up on the narrow viewports where more of the gradient lands near a dither
boundary. The 1440 and 1920 captures were clean in every pair.

**Rate across both runs of five pairs (10 pairs, 120 files):** two pairs carried a difference at all; one was a
single 8-pixel LSB wobble, the other reached delta 2 on 0.009 % of pixels and delta 4 on two pixels.

**Options for the team lead — a tolerance question, nothing decided here.**
A. Raise the tolerance from ≤ 1 to ≤ 4. Simple, and a real regression (a shifted glyph, a moved box) produces
   thousands of pixels at high amplitude rather than 379 at delta 2, so it would still be caught.
B. A two-part rule: no pixel differs by more than 4, AND at most 0.05 % of pixels differ by more than 1. Measured
   worst case is max 4 and 0.012 %, so this passes with roughly a 4x margin while still failing anything
   structural. The orchestrator's recommendation — it bounds both the amplitude and the extent, where a single
   number bounds only one.
C. Keep ≤ 1 and mask the vignette. Not viable: the vignette covers the whole page, so masking it masks everything.
Evidence: `RD/req015-pairs.md`, `RD/req015-eval-final.md`, and the 120 capture files `RUN/shots/req015-*`.

---

# P6 (run `.splitbrief/runs/2026-09-10-000035-web-v2-p6`, orchestrator phase-p6) — and the owner's follow-up list

## The owner's own list, from stage 1 (F25) — still open, all three by ruling

| id | item | status |
|---|---|---|
| R-F25-1 | `▶` renders in `--ink-3` rather than an accent. Recorded as a product-true copy deviation (D-23), never as a defect. | Open, owner's call. Nothing in the build depends on it. |
| R-F25-2 | Two phase vocabularies coexist: the hero's `Build → Verify` and the lower page's `EXECUTE / REVIEW`. Both were kept deliberately (D-23). | Open, owner's call. Changing either is a copy change to §16.10, not a build fix. |
| R-F25-3 | The page has no closing call to action; it ends on `PLANS / EXECUTES / REVIEWS`, which is text, not a link (§3's v2 note, ruling on the fourth step row). | Open, owner's call. |

## R-P6-1 — the traces are placed, except in `.s02` and `.s03` at 1440, which cannot hold one

**Superseded by the team-lead ruling of 2026-09-10 and re-measured.** The earlier finding — zero traces at every
width — was correct about the page as it then stood and wrong about the cause being unfixable. The wall was
placement ORDER, not legality. Two changes, neither weakening a clearance, fixed it: each layer's traces are now
placed BEFORE its other strings, and `place.ts`'s same-line check skips text lines inside a panel, matching §16.5's
"outside a panel" and what `aura.e2e.ts` had implemented correctly all along.

Rendered, live browser, matching the offline sweep on all nine numbers:

| | 1440 | 1600 | 1920 |
|---|---|---|---|
| `.s02` | 6 fragments · **0 traces** | 7 · 1 | 10 · 1 (`· · · ln 36`) |
| `.s03` | 4 · **0** | 4 · 1 | 6 · 1 (`· · · 14:28:16`) |
| `.s04` | 14 · 1 (`· · · 85 %`) | 13 · 1 | 16 · 2 |

**What remains open, and it is a floor of 0, not a defect.** At 1440 `.s02` and `.s03` place no trace and cannot:
0 of 200 seeds under the corrected placer, and an exhaustive origin scan gives `.s03` ZERO legal origins for any of
its three traces against an EMPTY placement set, while `.s02`'s two placeable ones fall to zero once the 64 px
travel band is counted. 387 px of section height against 116 text rects leaves no free band wide enough for a
125–211 px dotted run. `aura.e2e.ts` therefore asserts `.s04` ≥ 1 trace at 1440 and all three ≥ 1 at 1920, and
asserts nothing about `.s02` / `.s03` at 1440 — a test that asserted 0 would pin a limitation rather than guard a
requirement.

Forcing a trace into those two at 1440 would need a §16.5 rework (more legal area, or a narrower trace string), and
the team lead ruled that a morning decision for the owner rather than a 1 am one. The comp's 1 / 1 / 3 at 1440 were
hand-placed against a much weaker clearance.

**Correction P is corrected in `RUN/exec.md`**: its claim that "the ≥ 1600 gutters can still show them" was false as
built — the page placed none at 1920 either — and its conclusion that the clause was unachievable held a placement
order fixed without saying so. An impossibility proof is only as good as the mechanism it holds constant.

## R-P6-2 — RESOLVED: the placer no longer applies the same-line rule to panel lines

Closed by the same ruling. `place.ts` had applied the 96 / 192 px same-line rule to every text rect under `.grid`,
panel rows included, while §16.5 scopes a trace's 192 px to lines "outside a panel" and `aura.e2e.ts:127` already
skipped them. The placer was stricter than both the sheet and its own shipping test. It now matches, and that is
what lets `.s02` and `.s03` carry a trace at 1600 and 1920.

## R-P6-12 — the placer's arithmetic against the rendered page: one rule was short, two are not

**The one that was short, and is fixed.** §16.5 specifies a 60 px spread between fragment origins and
`aura.e2e.ts` asserts it on the RENDERED boxes. The placer's guard was `< 60` on its own float coordinates, so a
pair accepted at 60.30 px rendered 59.54 px apart — sub-pixel rounding of a gutter glyph's box — and the assertion
went red as soon as this run's change moved a pair onto that boundary. `SPREAD` is now **62** in the placer:
`.s04`'s minimum at 1440 goes 60.30 → 70.75, and no count, trace count or floor changes at any width. The design
number stays 60; 62 is the implementation margin that makes 60 true in the page.

**The audit the team lead asked for, on the other two rules of the same class.** Measured on the built page at all
three desktop widths, animations cancelled to base, comparing the RENDERED geometry against what each rule
requires:

```
                24 px box clearance                     96 / 192 px same-line rule
           min gap   margin   tightest case         min margin   tightest case
1440 .s02   27.391    +3.391  "°"                        +9.578  T1 ✓ vs a 96px line
     .s03   27.000    +3.000  "×"                      +464.813  412ms
     .s04   30.601    +6.601  "snapshot: pre_task"       +8.531  state.json
1600 .s02   25.125    +1.125  "∴"                        +2.625  T1 ✓
     .s03   30.342    +6.342  "412ms"                  +443.344  · · · 3/3 vs a 192px line
     .s04   33.593    +9.593  "session.jsonl"            +2.297  worktree
1920 .s02   28.109    +4.109  "( 39%, 46% )"             +5.297  stop and ask
     .s03   31.832    +7.832  "validate(task)"           +6.094  412ms
     .s04   33.394    +9.394  "· · · 5.00 usd"           +3.484  seed 8088
```

**Neither is short. No constant was raised**, because raising one would reject placements and risk a count floor
for no measured benefit — the standing rule that a number moves only against a measurement cuts both ways.

**Why these two are far less exposed than the spread was, which is the part worth carrying.** The placer measures
keep-clear from the live DOM: the text rects it grows by 24 px, and the line rects it applies the 96 / 192 px gap
to, are the SAME `getClientRects()` values the test reads. Its inputs are already rendered geometry, so there is no
model-versus-render gap on that side. The spread was different in kind: it compared the placer's own float origins
against rendered boxes, with nothing rendered on either side of the comparison until the browser laid it out.

**The residual exposure, named.** What the placer still models rather than measures is the fragment's OWN box —
`text.length * GLYPH.width` wide and `GLYPH.height` tall. That is where the tightest margin above comes from
(1.125 px at 1600). `GLYPH.width = 6.6` was measured exact against the rendered monospace advance by phase-p5b;
`GLYPH.height = 11` against a measured 16.0 was flagged by that same run as a real defect and never fixed. If a
future change tightens any of these three rules, or if the type scale moves, **measure rendered-versus-accepted
again before trusting the placer's arithmetic** — `RUN/tools/diag-margins.ts` does exactly that and takes a minute.

**CORRECTION, stage 3.5 nuke-review (2026-09-10): the "residual exposure" named in the paragraph above is
CLOSED, and was already closed when that paragraph was written.** The claim that `GLYPH.height = 11` stands
"against a measured 16.0" compares two DIFFERENT layers. Measured today on the built page
(`RUN/tools/diag-nr9.ts`), animations cancelled to base, every fragment on the page at three widths:

```
             modelled            rendered height          rendered advance per char
             glyphHeight    1440      1600      1920      min     max      (model 6.6)
hero              11        11.000    11.000    11.000    6.600   6.609
.s02              16        16.000    16.000    16.000    6.602   6.609
.s03              16        16.000    16.000    16.000    6.600   6.609
.s04              16        16.000    16.000    16.000    6.600   6.609
```

The hero's `.fragment` has `line-height: 11px`; the three section layers sit under `.aura`, which sets
`line-height: 16px`. `HERO.glyphHeight` is 11 and `BRIEFS` / `VALIDATION` / `CONTROL` are all 16 — **the model is
exact on height for all four layers at all three widths, to 0.000 px.** `GLYPH.height = 11` survives in
`place.ts` only as the default value of `travelBand`'s fourth parameter, used by the hero-shaped calls in
`place.test.ts`; every production call passes `layer.glyphHeight` explicitly. The per-layer `glyphHeight` that
P5b added (recorded 130 lines above this entry, in the same file) is what closed it. Width is modelled at 6.6
against a rendered 6.600–6.609 — a worst-case 0.009 px per character, or 0.26 px across the longest pool string.

**So the 1.125 px worst-case margin at 1600 does NOT come from a modelling gap; there is no gap.** It is genuine
slack between an accepted placement and the 24 px-grown text rects the placer reads live from the DOM, measured
after growing the fragment box by 6 px as the test does. An accepted candidate may legally sit just outside 24 px.

**Should the modelled box be replaced by a measured one? No, on three counts.** There is nothing to gain — the
error is 0.000 px on height and under 0.01 px per character on width. It would cost correctness: the placer runs
BEFORE its fragments exist, so measuring needs a probe element re-measured on every resize and font load, trading
an exact constant for a race against `document.fonts.ready`. And it would cost the unit test: `place.test.ts`
runs in Vitest under `environment: 'node'` with no DOM, so a DOM-measured box makes the placer un-unit-testable.
Keep the constants; the thing that made them right was making them per-layer.


## R-P6-3 — `scroll.e2e.ts`'s reduced-motion frame test was comparing the hero, not the lower page

Found by P6's first batch gate and fixed in this run (Correction R, brief F001), recorded here because it says
something about the suite rather than about one test. `reduced motion is the final frame` took two FULL-PAGE
screenshots 4 s apart and demanded byte equality. Over ten fresh-browser runs, four differed, and every difference
was inside the nav + hero: once by 10 701 pixels at a maximum channel delta of 21, three times by 5 pixels at
delta 4 on the two tool labels. The three `.stage canvas` ghost boxes are the nondeterminism already recorded as
R-2. Clipped to `.lower`, twelve of twelve runs are byte-identical.

This was the **third** naive full-page byte comparison in the suite. Correction H replaced one with a layout
equality and Correction N gave another a two-part tolerance; P5b spotted this one and left it because it happened
to be passing. It was not a flake waiting to happen — it was a wrong region waiting to be noticed.

## R-P6-4 — `s02.e2e.ts`'s phone bounds are still ±3 px where the contract says ±3 %

Carried unchanged from the sections run. T-203 specifies `.s02 .panel` h 713 ±3 % (±21 px) and `.s02` h 1513 ±3 %
(±45 px); the landed test asserts ±3 **pixels**. It passes today and stricter is never a correctness risk, but a
later change that moves the phone panel 5 px stays inside the contracted tolerance and still reddens the test.
`s03.e2e.ts` and `s04.e2e.ts` use true ±3 %. P6 did not normalise it: the run's standing rule is that the
orchestrator never loosens a tolerance, and a brief whose whole content is "make this assertion weaker" needs the
owner's word even when the contract is on its side.

## R-P6-5 — `frames.e2e.ts` has no view-timeline guard on its transcript seek

Carried from P5b (R-P5b-11). Harmless today: the only view-timeline animation, the spark's `ride`, lives on `.rail`
outside `.s03`, so the seek never meets one, and the capture passes. One line if a view-timeline animation ever
moves into a section.

## R-P6-6 — `DESIGN.md` §16.8's page height at 1920 is 25 px high

3 064 measured, 3 089 written. Carried from p1b and now recorded in the sheet itself as a dated build note rather
than silently corrected, because the four §16.6 spark positions are derived from the wrong figure and still pass:
recomputed from a 1 984 px max scroll they are roughly `[648, 152, 476, 1012]` against the sheet's
`[642, 139, 502, 987]`, deltas of 6 / 13 / 26 / 25 px, all inside §16.9's ±3 % of the viewport height (±32.4 px at
1080). The numbers were not edited to match the page. An owner who wants the sheet exact should re-derive the four
positions and the table row together.

## R-P6-7 — the mid-width captures are not byte-identical between runs, and Correction N admits it

`1024.png` and `768.png` differ between two capture sets of one build: 14.8 % of pixels at exactly one
least-significant bit and 0.009 % above it, maximum channel delta 4. It is vignette-gradient dithering, not the
ghost canvases — the canvas boxes were measured at every capture width and masked, and the over-tolerance counts
were unchanged. REQ-015 passes under Correction N's two-part rule (no pixel over delta 4, at most 0.05 % of pixels
over delta 1) with roughly a four-fold margin. Nothing to fix; recorded so a future run does not read it as a
regression and does not "fix" it by masking, which cannot work when the gradient covers the whole page.

## R-P6-8 — Lighthouse MOBILE performance is 94, one point under REQ-016's floor

Desktop is 100 and both accessibility scores are 96, so three of the four required numbers clear ≥ 95. Mobile
performance does not: four runs gave 94 · 94 · 97 · 94.

The whole deficit is First Contentful Paint (2.5 s, audit score 0.69) and the whole of FCP is one render-blocking
third-party request — the Google Fonts stylesheet for Bodoni Moda and JetBrains Mono, 2 134 B, **792 ms** of
blocking under Lighthouse's mobile throttle, against 152 ms for the site's own 6 767 B stylesheet. Total Blocking
Time is 0 ms and CLS is 0 on every run, so the site's own JavaScript costs nothing measurable. The run that scored
97 is the run where that request returned fast.

**The trade-off, so the owner can overrule it.** Every remaining fix trades one point of a synthetic score for a
real risk on a page whose typography IS the design: loading the stylesheet asynchronously with a media swap, or
inlining the faces, both reintroduce a visible flash of fallback text on first paint — the thing `display=swap`
plus `preconnect` is currently tuned to minimise. Self-hosting the two families removes the third-party round trip
but adds font binaries to a build whose asset policy is "no image assets" and whose stack sources them from Google
(§13). The team lead's ruling on 2026-09-10 was to accept 94 and record it. An owner who wants the point should
expect to pay for it in first-paint appearance, not in code.

The cheap mitigations are already applied: `index.html` carries `preconnect` to both font origins and the
stylesheet uses `display=swap`. Getting past 95 reliably means self-hosting the two families, which changes the
build's asset policy (§13 sources them from Google) and is an owner decision. §12's own recorded figure —
performance 99 on 2026-09-08 — was **desktop**, so this is the first time the mobile profile has been measured
against the floor, not a regression. Evidence: `RUN/a11y-p6.md`.

## R-P6-9 — the section h2 accessible names are uppercase, and the sheet contradicts itself

§16.9 item 1 asks for the accessible names `Before any code` / `After every task` / `For the whole run`. The CDP
tree carries `BEFORE ANY CODE` / `AFTER EVERY TASK` / `FOR THE WHOLE RUN`, because the accessible name comes from
the DOM text and §16.10 specifies that copy verbatim in capitals, which REQ-013 requires be exact. The two clauses
of the sheet disagree and the build followed the copy.

Not fixed here: reconciling them means either breaking REQ-013's verbatim copy or adding an `aria-label` the copy
spec does not have, and either is the owner's call. The structural half of the requirement is met — three level-2
headings, one per section, the eyebrow spans excluded from the name.

## Phase gates for P2, P3 and P4 were never run by their own run

Correction 2 skipped the per-phase critic and visual-diff tasks by owner ruling, and the sections run's review says
explicitly that it asserts nothing about G-build, G-shots, G-cap, G-tree, HERO-JSON or HERO-CROP. They are covered
at the P6 exit, which runs all of them on the final tree — that is the whole point of running them last — but no
phase-2, phase-3 or phase-4 capture set exists to compare against. If a per-phase record is ever wanted, it has to
be reconstructed from the tags on disk.

## R-P6-10 — a capture harness with no assertions shipped wrong frames for two phases

`tests/e2e/frames.e2e.ts` writes PNGs and asserts nothing, so its two tests pass whatever they capture. Its
`transcript frames` test was scrolling to `.s03`'s `offsetTop` — 557, measured from the positioned `.lower`, not
the document's 1697 — and doing it with a smooth scroll under a paused clock, which left `scrollY` at 80. The three
`*-s03-*.png` frames therefore showed the hero, in P5's capture set and in P6's, and eleven passing capture tests
said nothing about it. Fixed in P6 (Correction T, brief F002) after the frame was opened and looked at.

Left as a residual because the shape of the problem outlives the fix: **every capture test in this suite is
assertion-free by design** — `shots.e2e.ts` and `frames.e2e.ts` both exist to write files — so the only thing that
can catch a wrong capture is a person opening it. The build's own look-and-logic rule says exactly that. Whoever
owns a phase should open every PNG that phase produces at least once; nothing in the gates will do it for them.

## R-P6-11 — RESOLVED: `claude-code` keeps its hyphen unbroken

The TOOLS callout's `claude-code` broke across a line at its hyphen at 1200, 1024 and 768, reading as `claude-`
over `code`. Fixed by team-lead ruling with a NON-BREAKING HYPHEN U+2011 in the string — the same device the ladder
paragraph already uses for `mid‑tier` — in `index.html` and in the one test that asserts the literal. The glyph is
the same width in JetBrains Mono, so nothing moved at any tier. `white-space: nowrap` was explicitly rejected: at
768 the callout is 157 px and the label takes most of it, so the value would have overflowed instead.

**Still open, and acceptable by the same ruling:** at 1024 `any lab in any seat` and `pre_task · post_task` wrap
onto two lines. They wrap for LENGTH, not at a hyphen — neither contains one — and a two-line value in a callout is
acceptable where a word split at a hyphen is not. Measured at all six widths; no other value breaks at its own
hyphen, including `gpt-5.6 · qwen3` and `swap one mid-run`, which keep their ASCII hyphens.

## The reasoned out-of-tolerance rows, inherited (D-22)

The build wrote no `visual-diff-p<N>.md` files — every per-phase visual-diff and critic task was skipped by owner
ruling, one fable pass at the end of the build instead — so the only geometry table with reasoned rows is the
design comp's own, `comps/visual-diff-comp.md`: 59 rows, 49 within ±3 % at both tiers, **10 outside with a recorded
reason and 0 unrecorded**. D-22 inherits them: a site row matching the comp's measured value within ±3 % is ✓ by
the comp's reason. Listed here by row label so the list is checkable, grouped by the reason they share:

**The hero's tokens do not step at 1920** (three rows) — `02 title width` (24 px at both tiers: the reference
scaled into 1392 is 24.4 px, so the title has no FHD step); `02 tick-list pitch` (16 px is a hero `--text-micro`
token); `03 steps rule x` (the hero's 32 px number cell from §4, against the reference's 26 px).

**Whole-pixel type and pitch at 1920** (four rows) — `02 row pitch` and `03 row pitch` (an integer pitch, 13.57 →
14; a fractional line-height would paint the gutter numbers off their rows); `02 row advance per character`
(11 px at 6.6 and 12 px at 7.2 bracket the reference's 6.97, and 11 px keeps the reference's 13 px pitch);
`02 notes measure (41 ch)` (`--text-note` at the nearest whole pixel, 14, to the content-scaled 13.6).

**03's statement 2 sets in six lines, not five** (one row) — `03 steps 01 HIGHER QUALITY y`: the reference's 03
column is about 7 % narrower, so it fits 44-character lines the site's column does not.

**The footer's type floor and the nav's wordmark** (four rows) — `footer wordmark width` (the nav's wordmark
verbatim at 22 px per §3/§10; the reference's 14 px is a thumbnail artefact); `footer claim x` and
`footer [ docs ] x` (both follow from the 140 px wordmark and the 12 px type); `footer claim font`
(`--text-label` 12 px is the page's floor — the reference's 6.9 px footer type is unreadable at 1440).

Nothing in the built page contradicts these rows; they were carried unchanged from the comp through every phase.

## Handoff for stage 4

Run **nuke-verify** with `intent: RUN/spec.md` in a fresh session.

## R-NR-1 — a `canvas.dots` box overlaps a text-line box in `.s04` between 1360 and ~1500 px

**Raised** stage 3.5 `nuke-review`, seat (d), confirmed and quantified by the skeptic. **Status: open, deliberately not fixed.**

§16.9 item 7's last geometry clause is "every `canvas.dots` intersects no text box". It has **no test**, and
writing it as stated would go red today. Measured on the built page (`RUN/tools/diag-nr1.ts`, `diag-nr2.ts`):

```
1360  .dots--desk [1228,2499,1298,2587]  vs  "pre_task · post_task" [1094,2579,1250,2596]  overlap 22 x 7 px
1440  .dots--desk [1304,2516,1374,2604]  vs  "pre_task · post_task" [1152,2597,1308,2614]  overlap  4 x 7 px
1500  .dots--desk [1334,2519,1404,2607]  vs  "pre_task · post_task" [1182,2599,1338,2616]  overlap  4 x 7 px
1600 / 1920                                                                                 no overlap anywhere
```

The overlap is a BOX overlap only. The alpha sum of every canvas pixel inside the overlapped region is **0** at
all three widths, so no dot is behind any glyph and the tell-walk's actual requirement ("no dot behind any text")
holds. Nothing a user sees is wrong. The cause: the tick-list line `pre_task · post_task` runs about 13 px past
the rail into the marginalia gutter, where the desk field begins at rail x + 9.

**The owner's choice, one of two, before any test is written.** Tighten the desk field's geometry so its box
clears the text at every width between 1360 and 1600 — which moves a capture baseline for zero visible gain — or
amend §16.9 item 7's clause to the lit-pixel form it actually means. **Do not add the box test until one is
chosen**; it would be a red on its first run.

## R-NR-2 — eight comment lines in the e2e tests

**Raised** stage 3.5 `nuke-review`, seat (b), rated Major by the seat and Minor by the skeptic. **Status: open.**

`tests/e2e/motion.e2e.ts:5-7` and `tests/e2e/shots.e2e.ts:10-12,31-32`. They are the only comments left in `src/`
or `tests/` (verified: `src/**/*.ts` has none, `index.html` has no `<!-- -->`, no stylesheet has a `/* */`), and
the spec's Conventions say flatly "no comments".

They were left in place because they are not decorative — each records a measured fake-clock race that has
already cost this build time, and no other file in `website/` carries that knowledge. The clean resolution is to
move the three explanations into `DESIGN.md` §16.9 and then delete the eight lines. One edit, owner's call.

## R-NR-3 — `.visually-hidden` in `base.css` matches nothing

**Raised** stage 3.5 `nuke-review`, seat (c). Severity Info. **Status: open.**

The rule existed for the v1 routes table's `<caption>`, which v2 deleted. `grep -rn 'visually-hidden' index.html
src tests` returns only its own definition. §13's file map still inventories it as a `base.css` hook, which is why
it survived — deleting the rule means amending §13 in the same change.

## R-NR-4 — the stop tick's own geometry is asserted nowhere

**Raised** stage 3.5 `nuke-review`, seat (d). Severity Minor. **Status: open.**

§16.9 item 6's last clause is two facts: `.stop` left = rail x + 8, AND its tick box spans rail x − 3 … + 3 at the
artefact's top edge. `s02.e2e.ts:114`, `s03.e2e.ts:124` and `s04.e2e.ts:107` assert the label's x and y; none
queries the `::before` tick. Delete `.stop::before` and all three marginalia tests still pass while the rail
loses its three marks at each artefact.

## R-NR-5 — `s02.e2e.ts`'s fold test omits the `scrollBehavior = 'auto'` line its siblings carry

**Raised** stage 3.5 `nuke-review`, seat (d), as part of a claim the skeptic otherwise **rejected**. Severity
Minor. **Status: open, and NOT urgent — see the measurement.**

`s03.e2e.ts:148` and `s04.e2e.ts:132` set `document.documentElement.style.scrollBehavior = 'auto'` before
scrolling; `s02.e2e.ts`'s `the 02 fold at 1920` does not. The seat filed this as a Major, arguing the tests
measure a scroll that never lands under a paused `page.clock` — the mechanism that really did break
`frames.e2e.ts` in P6.

**Measured and refuted** (`RUN/tools/diag-nr1.ts`, reproducing the spark test's own conditions exactly:
`clock.install`, `pauseAt(+60 s)`, `goto`, `fonts.ready`, `scrollTo(0, p * max)`, `waitForTimeout(100)`):

```
1440x900  max 2092   target  523.0 -> scrollY  523    1046.0 -> 1046    1569.0 -> 1569    2092.0 -> 2092
1920x1080 max 1984   target  496.0 -> scrollY  496     992.0 ->  992    1488.0 -> 1488    1984.0 -> 1984
```

`scrollY` is exact at every sample at both widths. The P6 failure was `offsetTop` returning a wrong TARGET, not
the scroll failing to land. The `s02` omission is a consistency nit: if the scroll did not land, that test would
FAIL, not silently pass.

## R-NR-6 — `place.test.ts` pins output against a five-rect synthetic fixture

**Raised** stage 3.5 `nuke-review`, seat (d). Severity Info. **Status: open, and already known as D-7.**

The 20-origin `toEqual(PIN)` answers "did seed 8088 emit these origins", not "does this placer still satisfy
§16.5 on the real page". `HERO.lineGap` is 0, so the pin cannot fail a same-line regression, and the file's
same-line test can `continue` past every placement with no non-empty guard that anything actually sat on the
tested band. Listed so the next reader does not mistake it for coverage of item 7 on the lower page. The real-page
gate is `aura.e2e.ts`, which this stage extended to three widths (F-003).

## R-NR-7 — `frames.e2e.ts` captures are not reproducible run to run, and nothing can notice

**Raised** stage 3.5 `nuke-review`, by the orchestrator while diffing the `p6` and `p7` capture sets.
Severity Minor — capture evidence only, no user impact. **Status: open; the remedy is one line.**

Comparing `p6` against `p7`, the ten `npm run shots` PNGs are **nine identical and one differing in a single
89 × 14 px box** — `390.png` at (99, 6200)–(188, 6214), which is exactly the `[ github ]` link moving to the
24 px gap this stage restored (F-005). That is the whole visible delta of the stage, and it is the intended one.

All eleven `frames.e2e.ts` PNGs differ. **Measured: they differ between two consecutive captures of the SAME
build**, in the same places and the same shapes, so this is run-to-run nondeterminism and not a change from this
stage:

```
  s03-1200.png   DIFFERS bbox (64, 433, 1414, 894)   16 760 differing px of 622 350, max channel delta 36
  s03-2400.png   DIFFERS bbox (64, 432, 1415, 893)
  s03-500.png    DIFFERS bbox (64, 433, 1414, 893)
  spark-*        DIFFERS, most of them over the whole viewport
```

**Cause, read off an amplified difference map.** The differing region of the `s03-*` frames is not section 03 at
all — 03's terminal, notes, marginalia and stop are pixel-identical. Everything that moves is section **04**
below it: `FOR THE WHOLE RUN`, `NOTHING RUNS OUTSIDE WHAT YOU SET.`, `YOU DESCRIBE THE GOAL.` and 04's fragments.
`frames.e2e.ts:51` pauses only `document.querySelector('.s03').getAnimations({ subtree: true })`, so section 04,
visible in the same viewport, is caught mid one-shot reveal entrance at a different point every run.
`page.clock` does not help: it mocks JS time, not the compositor timeline a CSS animation runs on.
The `spark frames` test is worse — it installs no clock at all, so the ghosts, the dot shimmer and every
fragment animate in real time under it.

`shots.e2e.ts` does this correctly: its `settle()` walks the page, runs the clock, then finishes or pauses
**every** animation in the document and strips finished CSS entrances from the cascade. That is why REQ-015
passes 5 of 5 on the shots set and why these frames fail the same standard.

**Remedy** (not applied — the stage's two fix cycles were spent, and this changes no shipped pixel): seek or
finish animations **document-wide** in both `frames.e2e.ts` tests, not just under `.s03`, and install the paused
clock in the spark test too. One line each.

**Why nobody caught it before:** R-P6-10. `frames.e2e.ts` asserts nothing — it writes files — so no gate can see
a wrong or an unstable capture. It took a set-to-set diff to surface, and the frames it produces are still valid
evidence for the thing they document; they are simply not reproducible.

## Stage 4 — the final render critique (2026-09-10, `.splitbrief/runs/2026-09-10-web-v2-final`)

The final critique returned **7/10 — REVISE, 2 blocking**, with eight numbered fix rows. The team lead ruled on
each: F-1, the blocking half of F-2, and two of the polish rows were built; the rest are visual-design decisions
for the owner rather than defects, and are recorded here with the critic's own reasoning. Nothing below was
declined for cost; each is a choice only the owner should make.

### R-F-1 — 03's left column has no tail element, and the critic wants a tick-list there

**Raised** by the final critic as the first half of its F-2. **Ruled out of scope** by the team lead: this is new
visual design and the owner is asleep. The seam half of F-2 was built (Correction W).

The critic's text, verbatim in substance:

> 02's left column carries a tick-list (`BRIEFS / CONTRACTS / CONTEXT / CLARITY`) under its serif statement. 03's
> identical left column carries nothing. Two sections built on one grammar, and the second one is missing the
> element that fills the grammar's third slot. […] Give 03's left column the element its twin has and 03 lacks —
> a mono tick-list under the serif statement, in a *different shape* from 02's four stacked words so the two
> sections stop mirroring: a numbered or `·`-separated single block, from 03's own vocabulary
> (`TYPECHECK · LINT · TEST`, or the run's four verbs). Four short rows at `--text-label`, top-aligned 48 px under
> the statement's `—`.

**Measured, so the owner can decide against numbers.** At 1440 `.s03`'s head box runs y 1722 → 2061; its last text
(`KEEP THE EVIDENCE.`) ends at y 1945 and the skyline canvas starts at 2052. The free band is therefore
1969 → 2046 at x 64–374 — 77 px, four 18 px rows plus a dash, exactly what the critic asks for. It is currently
occupied by one placed fragment (`412ms` at x 322–357, y 2025–2041), which the placer would have to move; `.s03`
places 4 fragments at 1440 against a floor of 4, so a tick-list there costs a re-seed as well as new copy. It is
one brief, not a large one, and it is the single cheapest way to stop 02 and 03 mirroring in the 1920 02-fold.

### R-F-2 — the three 04 callouts do not share one internal grid

**Raised** as the critic's F-4, severity polish. **Ruled to residuals**: a visual-design decision.

> `TOOLS` and `RULES` set a label column plus a value column; `MODELS` sets a single list flush to the callout's
> own left edge, so the three content edges do not align. The spec's defence of the row ("one treatment × 3") is
> not true of the render. […] Either give `MODELS` the same two-column grid with an empty or a real label column,
> or drop the label column from `TOOLS` and `RULES` so all three set flush-left lists. One of the two, not a third
> shape. *Verify:* at 1920, the first glyph of every callout's content sits on the same x-offset from its own `|`
> tick.

Where: `src/styles/s04.css`, `.callout` and its rows; §16.3's callout table. The critic adds that at 390 the three
stack vertically and become three visually identical blocks in a column — "the closest the page comes to a
features list".

### R-F-3 — `codex°` and `GPT-5.6°` are footnote markers with no footnote

**Raised** as the critic's F-6, severity polish. **Ruled to residuals**: the owner's call between two options.

> A superscript degree sign marks two values and nothing on the page explains it. The wordmark's own `°` is a brand
> device, which makes the collision worse: the same glyph means "brand" in one place and "see note" in two others.
> […] Add the note the marker promises (one `--ink-4` line beside the callout, e.g. `° any reasoning model in any
> seat`), or drop the `°` from both values and leave it to the wordmark alone. Do not leave it unanswered.

**Verified on the built page.** `°` occurs exactly four times in `index.html`: line 19 (the nav wordmark), line 333
(the footer wordmark), line 142 (`+ GPT-5.6°`, the hero's reviewer seat label) and line 307 (`codex°`, 04's TOOLS
callout). Two brand, two unanswered. The build carries no key for them anywhere; the copy list at §16.10 types
both with the `°` and names no note.

### R-F-4 — section 04 has no hot spot across 686 px

**Raised** as the critic's F-7, severity polish, and explicitly declared intentional by §16.8. **Ruled to
residuals**: direction-level.

> Squinting at the full page finds two hot spots (02's blue headings, 03's red-against-green hinge) and none in the
> tallest lower section. §16.8 declares this intentional; as a render it means the page's final quarter has no focal
> point and the eye leaves before reaching the evidence tree. […] The cheapest honest candidate is one accent on a
> single value in the `RULES` callout — `pause_at 85 %` or `max_retries 3` in `--green` — which is also the one
> place on the page where a number is a *control the reader owns*. One value, one colour, nothing else. If the owner
> prefers the breath to stay ink, this row closes as declined, not as open.

§16.8's standing clause is "Hot spots below the hero: the eight blue headings (02), the red hinge answered by green
(03), none in 04 — the breath is ink." Acting on this row means amending that clause, which is why it is the
owner's.

### R-F-5 — the nav's 3 × 3 dot mark reads as a menu button

**Raised** as the critic's F-8, severity polish, and flagged by the critic itself as "a note, not a correction".
**Ruled to residuals.**

> `index.html:25`, `<span class="mark" aria-hidden="true">`. Inert and correctly hidden from assistive tech, but at
> 1440 and 1920 it sits where a menu control sits and looks clickable. It is in the owner's reference, so this is a
> note, not a correction. […] If it stays, drop it one step in ink so it reads as a register mark rather than a
> control; if the owner wants it as-is, close this row.

### What the critic got wrong, recorded so it is not re-filed

The critic's F-2 opens "§16.8 specifies that this seam carries no rule *because* the 03 skyline straddles the
border (its bottom 44 px into 04). In the render the skyline field ends around y 2160, short of the boundary."
**Measured at 1440 on 2026-09-10: the canvas box runs y 2051.9 → 2128.9 and `.s04` begins at y 2084.9, so exactly
44.0 px of it paint inside 04.** The straddle is built as specified and always was. What was true is the second
half of the same sentence — the field was invisible at 1×, lighting 19 of its 252 cells — and that is what
Correction W fixed. The critic's own band measurements (0.12 % over the 03 → 04 band, 0.06 % over 02's left void)
do not reproduce against a median-background threshold on the same PNG; the qualitative reading did, which is why
the fix was made on a rendered comparison rather than on those percentages.

The critic's F-3 also proposes letting the fragment placer use "the two known dead rectangles — 02's left column
below the tick-list and 03's below the statement — which have no keep-clear neighbours at all". **02's is not
free.** A fragment's keep-clear band spans its whole 64 px travel, so an origin in that band needs
`y − 70 > 1520` (the tick-list's last line grown 24 px) and `y + 22 < 1590` (the canvas grown 6 px) at 1440 —
mutually exclusive. Growing 02's canvas up into it instead was measured and costs 02 its ≥ 1600 trace
(44 × 10 → 0 traces at 1600 and 1920), so it was not done. 02's void was answered by density, not placement.

### R-F-6 — the `handoff/` mirror carries the phase-6 captures, not the current ones

**Raised** by the stage-4 orchestrator while refreshing the mirror. Severity Info. **Status: open, owner's call.**

`website/handoff/` holds eight `p6-*.png` captures from the end of phase 6. Since then the independent review
stage (`p7`) and this stage (`p8`) have both changed what the page looks like — the footer at 768, the density of
all three relief dot fields, and section 02 at 390. The three markdown files were refreshed to their run-dir
sources (F008/F009); the captures were not, because replacing eight binaries at the end of a night without a
ruling is the kind of change P6's Correction S already got wrong once, when a bulk copy silently overwrote a v1
capture that shared a name.

`HANDOFF.md` names `p8` as the capture set of record and says where it lives, so nothing in the mirror
misrepresents itself as current. The choice for the owner is whether the shipped repo should carry the `p8` set
alongside (eight more PNGs), replace the `p6` set with it, or keep pointing at the run directory.

### R-F-7 — this stage ran on opus, not on Fable

The owner reserved the final critique for Fable and its usage window had not reset; the critique ran on opus as
`final-critic-2`, and this fix stage's orchestration ran on opus too. The implementer seat is unchanged
(`cursor-grok-4.6-xhigh-fast`), as is the review seat's model. The critique's prompt and the `p7` capture set it
was written against are both unchanged on disk, so a Fable re-run of the same pass is a single dispatch if the
owner wants one.
