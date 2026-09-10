# Design critique 1 — stage 1r, fresh critic (critic-design)

Inputs judged: `comps/lower-1920.png`, `-1920-s02/-s03/-s04/-foot.png`, `lower-1440.png`, `lower-1440-s02.png`, `lower-390.png` (sliced into five 900-px strips to read it), `comps/lower-page.html`, `comps/lower-geometry.json`, `reference-v2.png`, `reference-v1-hero.png`, `current-1440.png`, `prompt.md`, `website/DESIGN.md` §0–§4, §7, §10–§14, §16. `design-notes.md` not read (withheld by design). `critic: rendered` for the stills; motion is judged from the spec (`static`), no live page exists yet. Note: `lower-1920-foot.png` and `lower-1920-s04.png` are the same file (md5 `27e4ee17…`) — the 04 fold is clamped at max scroll, so the two proofs coincide; that is fine, but there is only one capture, not two.

Measurement method for §1: reference boxes were extracted from `reference-v2.png` (1122 wide) by luminance threshold per band; the reference's 02/03 content box runs x 52 → ~1090, which scales to 1440 by k = 1.283 (52 → 67 ≈ the site's 64 gutter). Comp values are from `lower-geometry.json` and the same detector on `lower-1440.png`. Tolerance operationalized as: x ±3 % of the viewport width (43 px at 1440), y ±3 % of the viewport height (27 px at 900), size ±3 % of the reference dimension, copy exact. y is section-relative (from the seam). At 1920 the comp is a capped 1392 container (§11 decision), so x does not scale from the reference at all; the 1920 column below reports the comp's value and the delta against the reference scaled into the 1392 box (k' = 1.341 on content-relative x; sizes step up one token notch, ≈ +6 %).

## 1. Reference fidelity — 02, 03, footer

| element | reference (ref px → 1440) | comp 1440 | delta | verdict | comp 1920 (delta vs ref in the 1392 box) |
|---|---|---|---|---|---|
| **02** seam → eyebrow `02` y | 34 → 44 | 44 | 0 | ✓ | 41 (0) |
| eyebrow x | 54 → 69 | 65 | −4 | ✓ | 264 (0) |
| title `BEFORE ANY CODE` y · cap · width | 70 → 90 · 14 → 18 · 169 → 217 | 96 · 18 · 219 | +6 · 0 · +1 % | ✓ | 91 · 35 line (+6 % token step) |
| serif sub y · line pitch | 96 → 123 · 23.5 → 30.2 | 133 · 30.5 | +10 · +1 % | ✓ (by pitch; Bodoni hairlines defeat width measurement) | 134 · 33.5 |
| tick-list y · pitch · tick h | 213 → 273 · 12.3 → 15.8 · 10 → 13 | 285 · 16 · 12 | +12 · +1 % · −1 | ✓ | 300 (**§16.1 says 310 — wrong number**) |
| panel x | 294 → 377 | 398 | +21 | ✓ | 618 (+30) |
| **panel width** | 382 → 490 | 533 | **+8.8 %** | ✗ | 566 (**+10.5 %**) |
| panel top y | 26 → 33 | 33 | 0 | ✓ | 33 |
| **panel height** | 411 → 528 | 632 | **+19.7 %** | ✗ | 672 (**+22 %**) |
| bar height | 28 → 36 | 30 | −17 % | ✗ (minor) | 34 |
| **row pitch** | 10.8 → 13.9 (1.27 at the ref's ≈ 11 px) | 16 (1.33 at 12 px) | **+15 %** | ✗ | 17 |
| row font (advance/char) | 5.37 → 6.9 (≈ 11.5 px) | 7.2 (12 px) | +4 % | ✗ (marginal) | 7.8 (13 px) |
| **notes x** | 707 → 907 | 955 | **+48** | ✗ (3.3 %) | 1208 (+66) |
| **notes measure** | 249 → 320 = **41 ch** | 304 = **39 ch** | −5 % → statement 1 sets 6 lines, the reference 5 | ✗ (**§1 says 41 ch; §16 says 39 ch "the reference's rag" — the sheet contradicts itself**) | 328 |
| notes line pitch | 16.25 → 20.9 | 20.8 | 0 | ✓ | 22.4 |
| statement 1 y | 43 → 55 | 45 | −10 | ✓ | 41 |
| caps 1 y | 149 → 191 | 210 | +19 | ✓ | 216 |
| statement 2 y | 223 → 286 | 314 | +28 | ✗ (marginal; the 39 ch extra line) | 319 |
| caps 2 y | 320 → 411 | 441 | +30 | ✗ (marginal, same cause) | 455 |
| marg-list `SPEC…` x · y · pitch | 1011 → 1297 · 160 → 205 · 12.3 → 15.8 | 1305 · 227 · 16 | +8 · +22 · +1 % | ✓ | 1584 |
| `// contracts over context` right edge · y | 1086 → **1394** · 115 → 148 | **1280** · 174 | **−114** · +26 | ✗ (the rail moved every whisper left of the list; the reference lets them cross the list's column) | 1560 |
| `less context / more progress.` right edge · y | 1050 → 1348 · 349 → 448 | 1280 · 468 | **−68** · +20 | ✗ | 1560 |
| whisper ink | peak lum 56 (dimmer than `--ink-4`) | `--ink-4` (73) | brighter | ✓ (faithful in spirit; see floor) | |
| **section 02 height** | 438 → 562 (the reference's panel sits ON the seam, no bottom padding) | 697 | **+24 %** | ✗ | 737 |
| **03** seam → eyebrow y | 15 → 19 | 44 | +25 | ✓ (the reference's own 02/03 tops disagree by 19 px; one grammar is the right call) | 41 |
| title y | 51 → 65 | 96 | +31 | ✗ (marginal, same cause) | 91 |
| serif y · 4 lines · `KEEP THE EVIDENCE.` one line | 78 → 100 · pitch 23.7 → 30.4 | 133 · 30.5 · one line | +33 | ✗ (marginal) | 134 · one line ✓ |
| panel x · width | as 02 | 398 · 533 | +21 · +8.8 % | ✗ (width) | 618 · 566 |
| panel top y | 16 → 21 | 33 | +12 | ✓ | 33 |
| **panel height** | 246 → 316 | 392 | **+24 %** | ✗ | 417 |
| row pitch | 11.25 → 14.4 | 16 | +11 % | ✗ | 17 |
| `▶` markers | warm orange | `--ink-3` | colour | recorded decision (§16.2) — not a token, so "colour by token" cannot pass; owner to confirm | |
| statement 1 y | 22 → 28 | 45 | +17 | ✓ | 41 |
| **statement 2 y** | 80 → 103 (gap under st1 = 12 → 15) | 160 (gap 32) | **+57** | ✗ (an invented 32 px gap "to hold `// not its own judge`"; the reference sets that whisper beside st1's third line, not in a gap) | 163 |
| **steps y** | 168 → 216 | 317 | **+101** | ✗ (gap + 39 ch extra line) | 329 |
| steps label x | 740 → 950 | 1001 | +51 | ✗ (the notes-x shift) | |
| marg-list `VALIDATE…` x · y | 1011 → 1297 · 101 → 130 | 1305 · 172 | +8 · +42 | ✗ (y) | 1584 |
| `// not its own judge` right · y | 1088 → 1396 · 55 → 71 | 1280 · 132 | **−116 · +61** | ✗ | 1560 |
| `a smaller loop …` right · y · case | 1079 → 1385 · 208 → 267 · CAPS | 1280 · 349 · lowercase | **−105 · +82** · copy differs | ✗ (position; copy: ruling 8 says exact — the lowercase is a deviation the owner has not ruled on) | 1560 |
| **footer** wordmark x · width | 52 → 67 · 117 → 150 | 66 · ≈ 140 | −1 · −7 % | ✓ (the nav's wordmark verbatim, §10) | 264 |
| claim x · font | 170 → 218 · ≈ 6 px (66 ref px for 23 chars) | 207 · 12 px | −11 · **+100 %** | ✗ size, **justified**: the reference's footer type is a thumbnail-scale hint, unreadable at 1440; `--text-label` is the floor | 436 |
| links x | 815 → 1046 | 949 | −97 | ✗, same justification (12 px type is wider) | 1241 |
| seats right edge · ink | 1070 → 1373 · lum 95 (`--ink-3`) | 1373 · `--ink-3` | 0 | ✓ | 1656 |
| footer rule | none visible (the reference is cropped 6 px under the panel) | full-bleed `--hair` + 32/32 padding | n/a | §10 decision, fine | |

**Copy differences, reference → comp, and whether each is justified:**
- `typeercipt` → `typescript`, `bounds::` → `bounds:` — corrections, justified.
- Row 21 `.splitbrief/runs/2025-03-08/T002/` → `.splitbrief/sessions/2026-03-08-auth-guard/` — product-true, justified (and it makes 03's last line 04's first object).
- 03 marg-b `A SMALLER LOOP / A HIGHER BAR / REAL PROGRESS` → lowercase — a taste change on an authoritative surface; ruling 8 says copy exact. Defect until the owner rules.
- `▶` orange → `--ink-3` — recorded, defensible (one hot spot per panel), needs the owner's yes.
- Everything else on 02, 03 and the footer is verbatim (checked string by string against the render).

**Verdict on fidelity:** the head columns, the marg-lists and the footer's right edge match; the panels, the notes column and every whisper do not. Root causes, all in the sheet: (1) panel type at 12 px / 16 px pitch where the reference sets ≈ 11 px / 14 px — the panels are 20–24 % taller and 9 % wider, and 02 is 135 px taller than the reference scaled; (2) the notes measure at 39 ch where the reference (and §1) say 41 ch — one extra line per statement, cascading 20–30 px down each column; (3) the rail at content-edge − 80 pushes every whisper 68–116 px left of the reference's; (4) 03's invented 32 px statement gap. The comp is the better-breathing page; it is not the reference within ±3 %. The sheet must say which it is (F3).

## 2. Section 04 and the footer — no reference

**Three worst things first.**
1. **One concept, three homes.** `TOOLS / MODELS / RULES` appear three times in one section: the serif sub (`YOUR TOOLS. / YOUR MODELS. / YOUR RULES.`), the three callout heads, and the marg-list (`TOOLS / MODELS / RULES / LIMITS / EVIDENCE`). The hero never repeats a noun; 04 repeats its three nouns in three type styles within 700 px. It reads as a template that filled its slots from one list.
2. **No middle register.** The breath is 48/56 px; everything else in 04 is 11–14 px (the 28 px title excepted). The user's controls — the section's actual content — are set in `--text-micro` `--ink-3`, the hero's *seat-list* size, so they read as footnotes to a quote. The hero survives the same drop because the ghosts fill the middle; 04 has no object in the middle.
3. **The lower-left is void with debris.** Under the creed (1440: 420 × 190 px; 1920: 590 × 190) there is the ground dot field and three ink-4 strings. The crop test loses the field, as the sheet promises, but the field points at nothing — the tree it should floor sits to the right and above. The hero's equivalent corner holds the works-with block.

**Does 04 earn the feel adjectives and the hero's art direction?** Partly. It is a composition, not a template: asymmetric (head 3 cols / breath 7, starting on the diagram's column), the breath's stanza device inverts the hero's (`ARE GOOD.` muted → here the verbs recede), marginalia on the rail, the tree as the seam object (03's row 21 → 04's root line is the best move on the lower page). It is not a "bordered box + claim + list" — there is no box in 04. But its skeleton is "big quote + three columns + a code block", which is a known shape, and only the tiny-type/tick grammar hides it. It is less art-directed than the hero because the hero's signature is an *object* (the ghosts) and 04's is type only; the only artefact, the tree, is the smallest thing on screen at 1920 (566 × 153). **Precise:** the eye path holds (`THE GOAL.` → `THE REST.` → `FOR THE WHOLE RUN` → ticks → tree) with one hesitation between the lead (left) and the callouts (right), which sit at the same y at the same size. **Quiet:** yes. **Haunted:** no — nothing in 04 is alive or strange; the closest is the whisper in the stanza gap. **Believable:** yes — the kv keys are the config's own (`max_retries`, `pause_at`, `snapshots`), the tree is the real session directory.

**Footer:** faithful to the reference's structure, correct type floor, the `°` sits at the nav's `top: -.6em` (consistent with the hero's wordmark). Two notes: at 390 the claim wraps (`BUILDS BETTER / SOFTWARE.`) because `.brand` stays a row; and the page ends with no built action — the hero's install CTA never returns. Not in the reference, so an owner's call (F20).

## 3. Ruling 3 — the background and the scroll

**Stills (density, intentionality, one system, keep-clear).** Intentional and one system: yes — one ink, one glyph set (`.` `:`), one rail, the pools are the product's own vocabulary, nothing loud, nothing random. Keep-clear: holds at 1440/1920 (no fragment or field touches type; the 03 skyline straddles the seam as promised); **fails at 390** in all three sections (dots behind `CLEAR INPUTS. / SAFER OUTPUTS.`, behind the 03 steps' dash row, behind the tree's `review.md` / `snapshots/` rows — see the 390 strips). Density: **not enough.** Counted from the source: 02 = 7 fragments + 2 fields, 03 = 4 + 2, 04 = 9 + 2 at 1440 (two extra gutter strings per section at 1920). That is 20 strings and six faint fields across 1 970 px, against the hero's 19 strings + rain + ≈ 140 scatter glyphs + three ghosts in 900 px. The lower page is quieter than the hero, which is the exact failure the prompt named ("the lower sections often become generic, empty"). The rail — the concept's spine — is a 1 px `--ink-4` 4/4 dash; in the 1920 stills it is the least visible line on the page.

**Choreography as specified (§16.5/16.6).** One concept ("the run comes down the page"), reveals on arrival (the editor loading top-to-bottom in 0.67 s, the TUI printing a row at a time with a beat after `FAIL`, the folder filling), IntersectionObserver one-shot, reduced motion = final frame, no scroll-jacking, no layout thrash — all good and within budget. **But the spark's timeline does not do what the sheet says.** `animation-timeline: view()` on `.spark` makes the spark's own 5 px box (at the rail's top, pre-transform — a view timeline ignores the subject's transforms) the subject, so the ride runs from that box entering the viewport's bottom to leaving its top: ≈ 1 085 px of scroll. On the real page (rail top at y 1 144 at 1920) the whole ride happens between scroll 69 and 1 149 — while the hero is still on screen and the rail is at the bottom edge. By the time 02's seam reaches the top of the viewport the spark is already parked at the footer. The reader never sees the run come down the page. The comp's own captures agree with this reading (mid-page in the full-page shot, parked in the fold). Fix in F1.

**Is it enough for "fuller, more animated, not a plain scrollable page, sections reveal and load creatively"?** The reveals: yes. The background: no. What to add, all inside the constraints (one concept, no glow, no scroll-jacking, reduced-motion final frame, own JS ≤ 16 KB):
1. Fix the spark (F1) and give it the hero packet's wake — a 20 px `--ink-3` → transparent trail behind it — at opacity .85, so the run is visible at FHD.
2. **Rail stops.** Each `marg-list` tick already sits on the rail: on `.is-in` flare it `--white-spark` for 400 ms (CSS only) — the brief arrives at the stop, then the section paints. Add a 6 × 1 `--ink-3` tick on the rail at each artefact's top with a `--text-micro` `--ink-4` coordinate to its right (`§02`, `T002`, `retry 2/3`, `evidence.json`) — the prompt's "quiet coordinates", static, strings into §16.10.
3. **Fragment targets ×1.6:** 02 ≥ 10, 03 ≥ 7, 04 ≥ 12 at 1440×900 (the pools already hold 14 / 13 / 19 strings); let the 64 px gutters at 1440 take single glyphs (`∴ ° × →`) — the hero keeps its gutters silent, the lower page need not.
4. **Horizontal traces** as pool strings: `· · · · · · · ·` (96–160 px of `--ink-4` dots ending in a coordinate, `· · · · x 0398`), three per section, placed by the same placer — zero JS, and it is the prompt's "light horizontal data traces".
5. **Panel paint:** the `figure.panel` box (border + fill) paints at `--enter: 1` before its rows, and the gutter rule draws down (`scale-y` 0 → 1 over the rows' total delay, `transform-origin: top`) — a trace, one keyframe.
6. The fields' shimmer at 2 % / 2 fps is imperceptible (≈ 2 cells per half-second); make it 5 % at 4 fps, or skip the shimmer and add a second `skyline` under each panel's bottom edge (the panel's shadow made of cells).

## 4. FHD and mobile — ruling 5

- **1920 folds:** 02 = 737 (ends at 857, 223 px of 03 visible: the seam and its head — good); 03 = 482 with 04's head and the whole breath in the same fold; 04 + footer = 955 ≤ 1080 (the fold shows 124 px of 03's tail above — the seam working). No row wraps (rows 15 and 33 on one line), `KEEP THE EVIDENCE.` and `SPLITBRIEF HOLDS` on one line. Passes. The 264 px gutters carry two strings per section — a lot of silent canvas, but consistent with the hero's gutters at 1920.
- **1440:** 02 = 697 and 04 = 815 fit 900; the footer does not join 04's fold (903), which ruling 5 does not require.
- **390 is a layout,** not a shrink: single column in source order, panels wrap their rows, the tick-list becomes a `·` row, marginalia hidden, tree notes drop under their files, no horizontal overflow visible, no orphans under any title, the breath at 34 px holds `SPLITBRIEF HOLDS` on one line. **Defects:** (i) dot fields behind text in every section (§3 above); (ii) the tree gets a blank row after every annotated file — `.note { display: block }` inside a `pre` leaves the source newline after the block, so `state.json / note / blank / session.jsonl …` — visible in the fifth strip; (iii) the footer claim wraps mid-phrase; (iv) wrapped editor rows have no hanging indent (acceptable for an editor's soft wrap; optional F19); (v) the `.s04` top padding at 390 holds the 03 skyline straddle before `04` — fine, no text there.

## 5. Anti-default gate rows 1–6 and the floor

| row | verdict | evidence |
|---|---|---|
| 1 Type | pass | Bodoni Moda display, JetBrains Mono everywhere else — in every render |
| 2 Palette | pass | near-black, off-white, blue + green; red only as status on `✗ error FAIL` (semantic, not an accent — the sheet should stop calling it "the third accent") |
| 3 Layout | pass | 3/5/4 columns, head-left/breath-right in 04, marginalia on a rail; 02 and 03 share one skeleton by the owner's ruling |
| 4 Signature | pass on paper, **fail in the render** | "the run comes down the page" is nameable; in the stills it is a 1 px ink-4 dash and a 5 px square nobody will find at 1920 — and as specified it does not ride (§3) |
| 5 Cliché scan | pass | no glass, no emoji, no placeholder copy; microcopy is the product's own |
| 6 Motion | pass as specified | one concept, reduced motion = final frame, no-JS complete; the spark bug is an implementation-spec error, not a second concept |

**Floor:** contrast — `.marg` whispers are `--ink-4` on the canvas at 2.2:1 at 11 px and are listed as copy in §16.10 and asserted as text by §16.9; as content they fail AA, as decoration they must be `aria-hidden`. The reference sets them dimmer still, so the intent is decorative — declare it (F13). `.lines .n` at 2.2:1 is an editor's gutter, acceptable. Focus: the only interactive elements below the hero are the footer links, ringed. Responsive: real layout at 390 (with the three defects above). Semantic HTML: `figure`/`figcaption`/`ol`/`pre` are right; the `h2` of every section is the string `02` / `03` / `04` — a heading whose name is a number, the title is a `p` (F12). Performance: no assets, six small canvases, budget stated.

## 6. Sheet completeness for a brief-only implementer (§16.1–16.10)

Walked as the cheap model would see it: only §16, no §1–§15. Every place a number, token, hook, tier rule or order is missing, ambiguous, contradictory or pointed-at instead of stated:

1. **`--highlight` is undefined.** §16's panel uses `box-shadow: var(--highlight)`; §1's v2 token table has no such row (the comp defines it inline). The panel silently loses its edge. Add `--highlight: inset 0 1px 0 rgb(255 255 255 / .05)` to §1.
2. **39 ch vs 41 ch.** §1 v2 (`--text-note`): "the reference's measure is 41 characters in 323 px"; §16 shared grammar: "`max-width: 39ch` (304 px at 1440 — the reference's rag, measured)". Both cannot be the reference. Pick 41 (it is what the reference sets; see §1's table) and re-derive the rags and every pinned marginalia `top`.
3. **§16.4 is a pointer.** "§10 (v2) has the whole footer" — the implementer will not see §10. Inline the footer spec in §16.4 (or the brief must quote §10), including the < 768 stack and the `.brand` wrap rule (item 12).
4. **§16.6 spark timeline is wrong** (see §3): subject must be the rail — `.rail { view-timeline: --rail block }`, `.spark { animation-timeline: --rail; animation-range: contain 0% contain 100% }` (with `contain`, at a 1920×1080 viewport the ride runs from the rail's top at the viewport top — scroll ≈ 1 144 — to the rail's bottom at the viewport bottom — scroll ≈ max − 88 — and `fill: both` parks it for the last 88 px). State the expected spark y at 25 / 50 / 100 % scroll so §16.9's two spark captures are checkable; keep `container-type: size` for `100cqh`.
5. **`pre.tree` has no row hooks** but §16.6 reveals "tree rows `--row: 1…9`". Specify `span.row` per line (`display: block`, `--row: n` inline) — and say `--row` is set inline (`style="--row: 7"`) on every panel `li` too; `index.html` is already exempt from the line cap.
6. **`--beat`:** rows 13–21 get `--beat: 1`; state the default `--beat: 0` on the `ol` so rows 1–12 compute.
7. **The tick keyframe is unnamed.** Callouts and marginalia "tick `scale-y` 0 → 1 over 240 ms, `transform-origin: top`" — define it: `@keyframes tick { from { scale: 1 0 } }` on the `::before`, and say the block itself uses `enter`.
8. **Does the panel box paint?** §16.6 lists "panel bar 2" and the rows; the `figure`'s border and fill are not in the order table. State: the `figure.panel` carries `--enter: 1` (border + fill), the bar 2, then the rows.
9. **Fragment seeds:** "seed 8088 + the section's index" — index 2/3/4 or 0/1/2? Write the three numbers. Also state which hash channel draws each fragment's opacity in `.16–.28`.
10. **Phone tier of the fields** contradicts keep-clear: §16.5 "the skyline/ground fields stay at every width" + §16.7 "< 768: skyline/ground fields only" guarantees dots under text at 390 (rendered). Rule: `canvas.dots { display: none }` below 768, and fix both rows.
11. **390 tree rule produces blank rows** (`.note { display: block; margin-left: 6ch }`). Replace with `.tree .note::before { content: "\A      " }` (newline + six spaces, inline) or wrap rows in `span.row` (item 5) and set the note as a block inside the row.
12. **390 footer:** `.brand` stays a row and the claim wraps. Add `.foot .brand { flex-wrap: wrap; row-gap: var(--s-2) }` (or column below 768) to the footer spec.
13. **Wrong numbers:** §16.1 1920 tick-list y is 300 (sub 134 + 117 + 48), not 310; §16.3 the tree's `//` column is character 23, not 19 (`├── state.json` + 8 spaces = 22) — harmless because the block is verbatim, but a checker will fail it.
14. **§16.2 steps** say "the hero's steps grammar verbatim (§4)"; the implementer cannot read §4. The inline description is almost complete — add the mechanism: the rule is `border-left: 1px solid var(--hair)` on the label cell with `padding-left: var(--s-3)`, number cell `width: var(--s-8)`.
15. **§16.2 `.tail`** "hidden below 768, §15's rule kept" — §15 is superseded; say `.tail { display: none }` under 768 outright.
16. **§16.9 lacks ruling 8's tolerances and format.** It says "± 1 is the tolerance" for the comp's own numbers and never states position ±3 %, size ±3 %, copy exact, colour by token, nor the `visual-diff-<phase>.md` row format (expected · measured · delta · verdict), nor which image is the target per section (reference-v2.png scaled for 02/03/footer; the approved comp for 04 and the aura). Add a "Visual diff" block.
17. **§16.9 item 8 will fail as written:** a reduced-motion full page cannot equal a default full page "outside the `.spark` box" — the fragments hover and the fields shimmer under default motion. Compare at animation time 0 (seek + clock 0) or restrict the diff to the `.grid` boxes.
18. **§16.9 item 1 counts on whispers as text** while §1 calls `--ink-4` "decorative only" — resolve with F13 (aria-hidden decorative, or `--ink-3`).
19. `.dots--rail` (positioning hook in the comp) vs `.dots--desk` (the only class §16.5 names) — name both or fold the `right:` calc into `.dots--desk`.
20. §16.6 says the spark without `@supports` is `display: none`; the comp shows it at the rail's top. The sheet wins; say so in one clause so the implementer does not copy the comp.
21. **§16.10 verbatim check:** every string of 02, 03, 04, the footer and the nav steps is present (the panel rows and the tree are "as §16.1/§16.3", inside the same section — acceptable). The rail-stop coordinates from §3 item 2, if adopted, must be added.

Contradictions with §1/§2/§13: item 1 (`--highlight`), item 2 (39/41 ch), and §16.5's field tier row vs §16.7's; §2's skeleton omits `span.row` (item 5). §13's v2 delta is consistent with §16 otherwise.

## 7. nuke-design tell-walk — lower page

- tell #1 broken craft — 390, every section — dot fields behind `CLEAR INPUTS.`, the 03 steps' dash, the tree's last rows; the tree's blank rows after each note; the footer claim wrapping mid-phrase — F2, F4, F5.
- tell #2 void space — 04 lower-left at 1440/1920 — a 190 px-tall band under the creed holding only a ground field and three ink-4 strings; the crop loses nothing a reader would miss — F11.
- tell #3 compliance render — no hit — the eye path holds on 02/03 (title → panel → notes) and on 04 with one hesitation.
- tell #4 signature that isn't — the rail at 1920 — 1 px `--ink-4` dash at x 1576 and a 5 px spark; cold, it is a margin rule — F1, F7.
- tell #5 proof of nothing — no hit — the terminal is mid-run (fail → retry → pass → evidence), the editor is a real brief, the tree is the real session dir.
- tell #6 timid accents — no hit — squint: the blue heading column (02), the red hinge against green (03), nothing in 04; exactly two hot clusters.
- tell #7 text where a component belongs — footer — bracketed links are the site's grammar; no CTA returns below the hero (owner's call, F20) — soft hit only.
- tell #8 uniform density — 02/03 — one skeleton twice (owner's ruling) and the head grammar three times; the thumbnail reads dense · dense · breath · whisper, not stripes — pass with the repeat noted.
- tell #9 self-contradiction — 02 statement 2 vs 03 statement 1 — "validates every task upfront — typecheck, lint, test" vs "after every task runs typecheck, lint and test"; a brief cannot be typechecked before code exists (inherited from the reference); terminal row 01 `Build → Verify` beside the marg-list `EXECUTE / REVIEW` — two vocabularies for one pipeline — F17.
- tell #10 hidden money shot — no hit — no-JS complete, pre-reveal scoped to `html.js`, the harness scrolls through.
- tell #11 distribution-center styling — no hit.

Three distinct tells (#1, #2/#4, #9) → capped at 6. Desktop 1440/1920 stills alone sit at 7 (shippable with tweaks); 390 craft and the fidelity table pull it down; the choreography as specced does not play.

**Per feel adjective:** precise — **missed** (half the ruling-8 rows out of tolerance, three 390 craft defects, the sheet's own numbers wrong in four places) · quiet — **earned** · slightly haunted — **missed** (the aura is sparser than the hero's; the rail is invisible; nothing below the fold is alive in a still) · believable — **earned** (the panels and the tree are real documents mid-run; the config keys are the product's).

craft pass (critic's list, not fixes): 390 tree rows · 390 footer wrap · 390 dot/text collisions · §16.1 1920 tick-list y · §16.3 `//` column number · `--highlight` token.

## Fix list — worst first

- **F1 `blocking`** — §16.6 spark timeline · the subject of `view()` is the spark's own 5 px box, so the ride completes in ≈ 1 085 px of scroll while the hero is still on screen · make the rail the subject: `.rail { view-timeline: --rail block }`, `.spark { animation-timeline: --rail; animation-range: contain 0% contain 100%; animation-fill-mode: both }`; add the hero packet's 20 px wake behind the spark and opacity .85; state the expected spark y at 25 / 50 / 100 % scroll at 1440×900 and 1920×1080 in §16.9.
- **F2 `blocking`** — §16.5 + §16.7 phone tier · dot fields sit behind text in 02, 03 and 04 at 390 (rendered) · `canvas.dots { display: none }` below 768; change "stay at every width" and the < 768 row to "no aura below 768".
- **F3 `blocking`** — §16.1/16.2 fidelity vs `reference-v2.png` · panels +20/24 % tall, +8.8 % wide, row pitch +15/11 %, notes x +48, measure 39 ch vs 41, whispers −68…−116 px, 03 statement 2 +57, steps +101 · the owner rules (a) the comp becomes the target for 02/03 (then §16.9 names the comp as the visual-diff reference and records the accepted deltas in one table) or (b) the sheet pulls back: `max-width: 41ch` (restores 5-line rags, re-derive marginalia tops), 03 `p + p` back to `--s-6` with `// not its own judge` beside st1's third line as the reference sets it, `--text-art` at `--text-micro` (11 px) with `--line-art` 14 px (the reference's 1.27), whispers right-aligned to the content edge (crossing the rail's column as the reference's cross the list's). Either way delete "the reference's rag, measured" from the 39 ch clause — it is not.
- **F4 `blocking`** — §16.3 390 tree · `.note { display: block }` inside `pre` yields a blank row after every annotated file · `.tree .note::before { content: "\A      " }` inline (or `span.row` wrappers, F14) — render to confirm eight consecutive rows.
- **F5 `blocking`** — §16.4 / §10 390 footer · the claim wraps `BUILDS BETTER / SOFTWARE.` · `.foot .brand { flex-wrap: wrap; row-gap: var(--s-2) }` below 768 (the wordmark alone, then the claim); and inline the footer spec in §16.4 — the implementer never sees §10.
- **F6 `blocking`** — §1 v2 tokens · `--highlight` used by §16's panel is not in the token table · add `--highlight: inset 0 1px 0 rgb(255 255 255 / .05)`.
- **F7 `blocking`** — §16.5/16.6 ruling 3 · the lower page is quieter than the hero (20 strings, six faint fields, a 1 px rail across 1 970 px) · fragment targets 02 ≥ 10 · 03 ≥ 7 · 04 ≥ 12 at 1440×900; rail stops (marg-list tick flare `--white-spark` 400 ms on `.is-in`; a 6 × 1 `--ink-3` tick + `--text-micro` `--ink-4` coordinate at each artefact's top: `§02` `T002` `retry 2/3` `evidence.json`, strings into §16.10); horizontal-trace strings (`· · · · · · · ·` ending in `x 0398`) three per section in the pools; the panel box paints at `--enter: 1` and its gutter rule draws down (`scale-y`, `transform-origin: top`, one keyframe); shimmer 5 % at 4 fps or a second skyline under each panel. Own JS stays ≤ 16 KB (everything but the count is CSS/strings).
- **F8 `carry`** — §16.9 · add the ruling-8 block: tolerances (position ±3 %, size ±3 %, copy exact, colour by token), the `visual-diff-<phase>.md` row format, the target image per section, the spark's expected positions; fix item 8 (compare at animation time 0 or diff only the `.grid` boxes).
- **F9 `carry`** — §16.3 04 copy · `TOOLS / MODELS / RULES` appear three times (serif sub, callout heads, marg-list) · replace the serif sub with `NOTHING RUNS / OUTSIDE THEM.` (promoted from the whisper; the whisper becomes `// your tools, your models, your rules`) or cut the marg-list to `LIMITS / EVIDENCE / SNAPSHOTS / RETRIES / REVIEW` — owner's copy call; the sheet must pick one.
- **F10 `carry`** — §16.3 callouts · no middle register between 56 px and 11 px · values at `--text-note` `--ink-2`, keys `--text-micro` `--ink-3`, heads unchanged; re-measure the three heights (still unequal).
- **F11 `carry`** — §16.3 04 lower-left · void with debris under the creed · bottom-align the creed to the tree's last row (row 3 left cell `align-self: end`) so the ground field sits between the lead and the creed, or move the ground field under the tree (its floor, `left` = the tree's x).
- **F12 `carry`** — §2 / §16 shared grammar · `h2` text is `02` · make `p.title` the `h2` (eyebrow becomes `p.eyebrow`), or `<h2><span class="eyebrow" aria-hidden>02</span> Before any code</h2>` with the title styled inside; update the hooks.
- **F13 `carry`** — §16 shared grammar · `.marg` whispers at 2.2:1 are listed as copy · add `aria-hidden="true"` and call them decorative in §16 (the reference sets them dimmer), or set `--ink-3`; keep §16.9's presence checks.
- **F14 `carry`** — §16.6 hooks · `span.row` per tree line with inline `--row`; inline `--row` on every panel `li`; `--beat: 0` default; `@keyframes tick`; the `figure.panel` box's own `--enter` (F7 makes it 1).
- **F15 `carry`** — §16.5 · state the three fragment seeds (8090 / 8091 / 8092 or the intended values) and the opacity hash channel; name `.dots--rail` or fold its `right:` into `.dots--desk`.
- **F16 `carry`** — §16.1 1920 tick-list y 310 → 300; §16.3 `//` column 19 → 23; §16.2 inline the steps' rule mechanism and `.tail { display: none }` < 768; §16.6 one clause that the spark is hidden without `@supports` (the comp shows it).
- **F17 `carry`** — copy inherited from the reference, owner's call · 02 statement 2 "upfront — typecheck, lint, test" contradicts 03 (suggest `validates every brief upfront — scope, file, dependencies, signature — and stops at the first domain or contract error.`); `Build → Verify` vs `EXECUTE / REVIEW` on adjacent surfaces; 03 marg-b lowercase where the reference is caps; `▶` ink-3 where the reference is orange.
- **F18 `carry`** — comp placement (the site's placer will refuse it, but the comp is the 04/aura target) · `append-only`, `[ 3 / 7 ]`, `seed 8088` sit inside the 04 ground field's box; the rail-side dot columns start 27 px under each marg-list at the same x and read as the list dissolving · move the columns 48 px down or 16 px right; re-place the three strings.
- **F19 `carry`** — §16.1 390 editor · wrapped rows have no hanging indent · optional `text-indent: -2ch; padding-left: calc(var(--s-2) + 2ch)` on `.t` below 768.
- **F20 `carry`** — §16.4 · no built action below the hero · consider the install CTA (the hero's component) in the footer's left group; not in the reference, owner's call.

VERDICT: 6/10 — REVISE — blocking: 7
