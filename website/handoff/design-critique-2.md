# Design critique 2 — stage 1r, fix cycle 1 re-critique (critic-design)

Inputs judged: `comps/lower-1920.png`, `-1920-s02/-s03/-s04.png`, `lower-1440.png`, `lower-1440-s02.png`, `lower-390.png` (sliced into five strips), fourteen zoomed crops of the 1440 render (whisper/rail crossings, stops, spark, fragments beside text), `comps/lower-page.html`, `comps/lower-geometry.json`, `comps/visual-diff-comp.md`, `reference-v2.png`, `website/DESIGN.md` §1 v2, §2, §10, §16.1–16.10. `design-notes.md` still not read. `critic: rendered` for the stills; motion judged from the spec (`static`). Every §16 coordinate I spot-checked (≈ 90 boxes across the three tiers) matches `lower-geometry.json` to the pixel; the sheet's spark arithmetic (§16.6) reproduces the JSON's `spark-at-s03` / `spark-at-max` values.

## F1–F20 — verified one by one

| item | status | evidence |
|---|---|---|
| F1 spark timeline | **resolved** | §16.6 + comp: `.rail { view-timeline: --rail block }`, `.spark { animation-timeline: --rail; animation-range: contain 0% contain 100% }`, `display: none` outside `@supports`, wake `::before`, opacity .85. Re-derived: at 1920×1080, scroll 595 → progress (595−120)/(1857−1080) = .611 → viewport y 657 = the JSON's 656.8; at max scroll the spark's bottom sits on the footer rule (1920-s04 crop, x 1576 y 989); at scroll 0 it sits on the seam with its wake above (zoom K). The real-page numbers in §16.6 (617 / 94 / 444 / 807 at 1440; 642 / 139 / 502 / 987 at 1920) check out. |
| F2 phone dot fields | **resolved** | `canvas.dots { display: none }` < 768 in the comp and §16.5/§16.7; the five 390 strips show no dot anywhere; JSON `s0x-dots` = 0 at 390. |
| F3 fidelity | **resolved** (ruled: pulled back) | panel `--panel-w` 494 / 517 (= the reference's 385 ref px scaled, 0.0 %), `--text-art` 11 px at `--line-art` 13 (the reference's pitch, +0.2 %), notes `41ch + 1px` (rags reproduced: statement 1 five lines, 2 five lines), `.marg { right: 0 }` / `.marg-b { right: var(--s-6) }`, 03 gap `--s-2`; section 02 557 vs the reference's 561 (−0.7 %). The "reference's rag, measured" claim is gone. `visual-diff-comp.md` holds 59 rows; see §1 below. |
| F4 390 tree | **resolved** | `span.row` inline-block per line with the newline after it; strip 5 shows `state.json / // resume from here / session.jsonl / …` with no blank row — 14 lines, 224 px as §16.3 says. |
| F5 390 footer | **resolved** | `.brand { flex-wrap: wrap; row-gap }`; strip 5: `splitbrief°` then `BUILDS BETTER SOFTWARE.` whole on its own line, links, seats; §16.4 now carries the whole footer spec inline. |
| F6 `--highlight` | **resolved** | §1 v2 token table row 1. |
| F7 ruling 3 density | **resolved** | Targets 10 / 7 / 12 (comp 12 / 7 / 16 at 1440, 14 / 9 / 18 at 1920); nine trace strings in the pools; three rail stops (`§02`, `T002`, `auth-guard`) with 6 × 1 ticks crossing the rail (zooms B, J); flare keyframe; panel box paints first and the gutter rule draws (`draw` keyframe); spark wake; shimmer 5 % at 4 fps; gutter glyphs at 1440, gutter strings at 1920. See §3. |
| F8 §16.9 | **resolved** | Visual-diff block with tolerances, format, per-section target, spark rows; item 8 seeks to time 0; e2e counts updated (`.marg` 6, `.stop` 3, traces ≥ 2, `canvas.dots` 5 / 6 / 0). |
| F9 04 repetition | **resolved** | `TOOLS / MODELS / RULES` built once (callout heads); serif sub `NOTHING RUNS / OUTSIDE / WHAT YOU SET.`; rail list `LIMITS / BUDGET / RETRIES / REVIEW / EVIDENCE`; the triple survives only as the `--ink-4` whisper. Renders confirm. |
| F10 04 middle register | **resolved** | `.callout` at `--text-note` `--ink-2`, keys `--text-micro` `--ink-3`, `kv` at `10ch 1fr`; at 1920 `claude-code / opencode / codex°` and the RULES values read as the controls (s04 crop). Heights 109 / 127 / 145 unequal as required. |
| F11 04 lower-left | **resolved** | `.creed { align-self: end }` — its dash is level with the tree's last row; the ground field (60 × 6) sits between the lead's dash and the creed (zoom N). The crop test now loses a relief the creed stands on, not debris. |
| F12 h2 = title | **resolved** | `h2.title > span.eyebrow[aria-hidden] + span.line`; accessible names `Before any code` etc.; §2 and §16.9 item 1 updated. |
| F13 whispers decorative | **resolved** | every `.marg` `aria-hidden="true"`, declared decorative in §16 shared grammar; e2e asserts by DOM. |
| F14 reveal hooks | **resolved** | inline `--row` on every `li` and `span.row`; `--beat: 0` on the `ol`; `@keyframes tick`, `draw`, `flare` named; `figure.panel` `--enter: 1`. One timing nit remains (F23). |
| F15 seeds / opacity / classes | **resolved** | 8090 / 8091 / 8092; opacity `.16 + .12 × hash(seed, i, 0, 3)`; `.dots--skyline` / `.dots--desk` / `.dots--gutter` with their `left` calcs. |
| F16 wrong numbers | **resolved** | tick-list 1920 y 280 (JSON 280.3); `//` column 23; steps mechanism inlined; `.tail` rule; spark hidden without `@supports`. |
| F17 copy | **resolved as ruled** | statement 2 = the suggested product-true text; `A SMALLER LOOP…` caps restored; `Build → Verify` / `EXECUTE / REVIEW` both kept as the reference's strings (recorded); `▶` `--ink-3` recorded — still needs the owner's yes (residual, not blocking). |
| F18 comp placement | **partly resolved** | the round-1 collisions are gone (ground-field strings moved, rail columns 48 px under their lists). New comp-only collisions appeared: two strings inside the tree's box, one trace on the rail, four strings reading as tails — F21/F22. |
| F19 hanging indent | **resolved** | `.lines .t { text-indent: -2ch; padding-left: calc(var(--s-1) + 2ch) }` < 768; strips 1–3 show continuation lines hanging under the third character. |
| F20 closing CTA | **open by ruling** | owner's-call residual; not counted. |

## 1. Reference fidelity — the 10 out-of-tolerance rows

I re-measured the reference panel boxes with the seam row excluded (my round-1 "411 ref px" panel height had included the section's own bottom rule; the panel's bottom border is at ref y 1084, so 396 is right). With that correction the table's 49 in-tolerance rows hold. The ten out-of-tolerance rows and my judgement of each reason:

| row | delta | reason given | verdict |
|---|---|---|---|
| tick-list pitch at 1920 | 16 vs 17 (−4.6 %) | the hero's `--text-micro` list pitch is a hero token and does not step | **accepted** — cross-surface consistency with the hero's seat lists beats a 1 px step on a four-line list |
| row pitch at 1920 | 14 vs 13.57 (+3.2 %) | whole-pixel pitch; a fractional one paints the gutter numbers on half pixels | **accepted** — correct craft reason |
| row advance at 1440 | 6.6 vs 6.97 (−5.3 %) | 11 and 12 px bracket the reference; 11 keeps its 13 px pitch at a sane leading | **accepted** — 12 px at 13 px pitch would be 1.08 leading; 11 is the only honest choice |
| notes measure at 1920 | +3.05 % | `--text-note` 14 is the nearest whole pixel to 13.6 | **accepted** — marginal by 0.05 points |
| 03 steps y | +39 / +45 | the reference sets its 03 column 7 % smaller than its 02 column; one note size sets statement 2 in six lines | **accepted** — the reference is inconsistent with itself; one `--text-note` is the right call, and the row is recorded as the only 03 residual |
| 03 steps rule x | 32 vs 26 (+24 %) | the hero's steps grammar (32 px number cell) | **accepted** — the hero's `01 │ HERO` column and this list must read as one grammar |
| footer wordmark width | +65 % | the nav's wordmark verbatim; the reference's 14 px footer wordmark is a thumbnail hint | **accepted** — one wordmark on the page |
| footer claim x | +61 | follows the 140 px wordmark | **accepted** — consequence of the row above |
| footer claim font | +30 % | `--text-label` is the floor; the reference's 6.9 px footer type is unreadable | **accepted** — legibility floor |
| `[ docs ]` x at 1440 | −85 | 12 px type is wider; the links keep their distance from the seats | **accepted** — the seats' right edge lands on the content edge to the pixel |

No row hides a defect; no row lacks a reason. Copy: exact except the four recorded deviations (two typos, the evidence path, the ruled statement 2) and the `▶` ink (recorded, owner to confirm). Colour: by token throughout. The fidelity requirement is met as far as the comp can meet it.

## 2. Section 04 and the footer

**Three worst things, in order:** (1) `· · · · · · · · · · 3 seats` sits 33 px right of `SPLITBRIEF HOLDS` on its baseline row and reads as a leader from the headline to a coordinate (zoom G); (2) `state.json` and `· · · · · · · · 5.00 usd` sit inside the tree's box, level with its root and `plan.md` rows, and read as a tenth entry and a leader (zoom H); (3) the whisper `// your tools, your models, your rules` is cut by the rail through the `s` of `models` (zoom L). All three are placement, none is composition.

**Composition now.** The colophon holds: head left, the breath on the diagram's column, the lead and the callouts on one row, the creed bottom-aligned to the tree with the ground relief between paragraph and creed — the lower-left is furnished, not void. The callouts at 13/14 px read as the user's controls rather than footnotes; their heads are the only place `TOOLS / MODELS / RULES` are built. The serif sub `NOTHING RUNS / OUTSIDE / WHAT YOU SET.` states an outcome instead of repeating the callouts. Eye path: `THE GOAL.` → `THE REST.` → `FOR THE WHOLE RUN` → the three heads → the tree, no hesitation now that the callouts are a size up. As art-directed as the hero: closer — the rail with its `auth-guard` stop and the tree as the seam object give 04 an object grammar; it still has no *thing* the way the hero has ghosts, which is the direction's choice, not a defect. **Footer:** faithful to the reference's structure, the type floor recorded, `°` at the nav's position, 390 stack clean. No CTA (owner's residual).

## 3. Ruling 3 — the background and the scroll, on paper and in the stills

**Stills.** At 1440 the lower page now carries 35 strings (12 / 7 / 16), six traces with coordinates, five dot fields, three rail stops, and a spark with a wake parked on the seam; at 1920, 41 strings and six fields. The 02 head column under the tick-list holds `· · · ln 36`, `one file per brief`, `depends_on: [T001]`, `∴` and the skyline; the 04 middle band holds `0x2f …`, `· · · 85 %`, `[ 3 / 7 ]`, `append-only`. The rail reads as a timeline because the stops name it (`§02`, `T002`, `auth-guard`) and their ticks cross it. One system: one ink, one glyph set, the product's own vocabulary, the hero's dash and tick. Keep-clear holds at every tier except the comp-only collisions in F21. **Fuller than round 1 by a clear margin; still quieter than the hero's glyph field in absolute marks, which is right for "subtle, atmospheric".**

**Choreography on paper.** The spark now rides the rail's own timeline from the seam at the viewport top to the footer rule at the viewport bottom, waits on the seam before and parks on the rule after; each section's stop flares as the section paints; the editor loads with its gutter rule drawing down, the transcript prints row by row with a beat after `FAIL`, the folder fills; the fields shimmer perceptibly. Reduced motion is the final frame; no-JS is complete; no scroll-jacking; no layout property animates. As alive as the hero on paper: **yes for the page's behaviour** (the hero has one loop, the lower page has a ride, three arrivals, three paints and a shimmer); the hero keeps the denser *field*, which the owner's "subtle" asks for. One spec nit in the choreography (F23): the marg-list tick is told to flare at 0 ms while its parent reveals at 480 ms with opacity 0 and the tick itself scales in at 480 ms — the flare on that tick is invisible; the stop's tick (static) carries the flare fine.

## 4. FHD and mobile — ruling 5

- **1920 folds:** 02 = 595 (ends at 715, the seam and 03's head in the same fold); 03 = 404 with 04's head, the whole breath and the callout heads in the fold; 04 + footer = 946 ≤ 1080. No `.t` wraps (JSON `wrapped: []`); `KEEP THE EVIDENCE.` at 29 px (321 px in the 330 column) and `SPLITBRIEF HOLDS` on one line. 03's gutter dot column lives at ≥ 1600 beside the `VALIDATE…` list (s02 crop bottom right). Pass.
- **1440:** 02 = 557, 04 = 819 inside 900; 04 + footer 907 (7 over, not required). Pass.
- **390:** layout, not shrink — strips 1–5: single column, `BRIEFS · CONTRACTS · CONTEXT · CLARITY` as one row with its tick, panels wrapping eight / two rows with the hanging indent, tails hidden, `markdown` and `14:28:16` hidden, no dot anywhere, notes full width with the 03 gaps back to `--s-6` / `--s-8`, the breath at 34 px holding `SPLITBRIEF HOLDS`, creed before the callouts, `kv` at `10ch`, the tree's notes under their files with no blank row, the footer stacked with the claim whole. No orphan under any title. Page 4 362 (lower) — consistent with §16.8's ≈ 6 274 with the hero. Pass, clean.

## 5. Anti-default gate rows 1–6 and the floor

| row | verdict | evidence |
|---|---|---|
| 1 Type | pass | Bodoni Moda / JetBrains Mono in every render |
| 2 Palette | pass | two accents; red now correctly called a status colour in §1 |
| 3 Layout | pass | the reference's three-column row (310 · 494 · rest) for 02/03; 04's head/breath split on the twelve columns; the rail |
| 4 Signature | **pass in the render now** | the rail carries named stops with ticks crossing it, a bright spark with a wake on the seam; cold, it reads as a timeline down the margin |
| 5 Cliché scan | pass | unchanged |
| 6 Motion | pass | one concept, correct timeline, reduced motion = final frame |

**Floor:** whispers `aria-hidden` and declared decorative (the reference sets them dimmer); `h2` names are the titles; the only interactive elements below the hero are the footer links, ringed; 390 is a layout; no assets, five or six small canvases, own JS ≤ 16 KB stated. Contrast of every content string is `--ink-2`/`--ink-3` or better on `--bg`/`--panel` (4.9:1 for `--ink-3` on `--panel`). Pass.

## 6. Sheet completeness for a brief-only implementer — re-walk

Round-1 items 1–21: all closed (`--highlight` ✓, 41 ch ✓, §16.4 inline ✓, spark subject ✓, `span.row` ✓, `--beat: 0` ✓, `tick`/`draw`/`flare` named ✓, panel box `--enter` ✓, seeds ✓, phone fields ✓, tree rule ✓, footer wrap ✓, numbers ✓, steps mechanism ✓, `.tail` ✓, §16.9 tolerances/format ✓, item 8 ✓, whispers ✓, dot classes ✓, spark fallback ✓, §16.10 ✓). Every number I checked in §16.1–16.4 and §16.8 matches the JSON (02/03/04 heights 557/388/819 and 595/404/858, every marginalia `top`, every 390 y, the footer x's). New or remaining gaps, none of which changes a layout:

1. **§16.6 flare timing** — `.marg-list::before` cannot flare at `--enter: 0`: its parent is at opacity 0 until 480 ms and the tick itself scales in at 480 ms. State: the flare runs on `.stop::before` at 0 ms; the marg-list tick flares after its own `tick` (delay 720 ms) or not at all.
2. **§16.5 same-line clearance** — the keep-clear says 24 px from any text line and a list block's own width beside lists; the comp shows that 24 px on the same line reads as a tail (`//` after `scope,`, `attempt 2/3` after `HIGHER QUALITY`, `· · · 3 seats` after `SPLITBRIEF HOLDS`, `in bounds · out of bounds` beside `ONE BRIEF.`). Add one sentence: a fragment whose line band (y ± 8) overlaps a text line's band must start ≥ 96 px (`--s-24`) right of that line's end or end ≥ 96 px left of its start, and a trace never shares a band with a text line or a display line.
3. **§16.5 gutter glyphs** — `.frag--glyph` has `left: 24px` / `right: 24px` and a cap of two per gutter per section, but no y rule for the placer; state: y seeded within the section, ≥ 24 px from the seams, ≥ 60 px apart.
4. **§16 shared grammar, rail crossings** — "the text wins where they meet" is not quite what renders: the rail's dashes pass through the `s` of `less`, the `p` of `progress` and the `s` of `models` (zooms C, L) because both are `--ink-4`. A `--bg` patch was rightly rejected (the vignette); a glyph-hugging knock-out is not a patch: `.marg { text-shadow: 1px 0 var(--bg), -1px 0 var(--bg), 0 1px var(--bg), 0 -1px var(--bg) }` blanks the dashes under the letters only. State it or accept the crossing explicitly.
5. **§16.9 aura target** — the comp is the visual-diff target for the aura "by count, zone and clearance", so the comp must pass §16.9 item 7 itself; today it does not (F21). The rule is fine; the comp needs the fix.

Contradictions with §1/§2/§13: none found. §16.10 holds every string on the page, traces, stops and gutter glyphs included, and the "removed in fix cycle 1" list is complete.

## 7. nuke-design tell-walk — lower page, cycle 2

- tell #1 broken craft — 1440/1920, the whispers — the rail's dashes cut through glyphs in `less context / more progress.`, `// your tools, your models, your rules` (and land in the word gap of `// contracts over context`, which passes); comp-only: `· · · col 1` sits on the rail (the trace's label straddles x 1295) — F22, F21.
- tell #2 void space — no hit — 04's lower-left is a paragraph, a relief, a creed; the 02 head column and the 04 middle band are furnished.
- tell #3 compliance render — no hit — the eye path holds on every section; the finger does not hesitate on 04 now.
- tell #4 signature that isn't — no hit — the rail reads as a timeline with named stops and a lit spark in the stills.
- tell #5 proof of nothing — no hit.
- tell #6 timid accents — no hit — blue heading column, red hinge against green, nothing in 04; the spark is the one white point.
- tell #7 text where a component belongs — soft — no CTA below the hero (owner's residual).
- tell #8 uniform density — no hit — the 02/03 skeleton is the reference's; the thumbnail reads dense · dense · breath · whisper.
- tell #9 self-contradiction — no hit — statement 2 fixed; `Build → Verify` / `EXECUTE / REVIEW` kept by ruling and explained in §16.2.
- tell #10 hidden money shot — no hit.
- tell #11 distribution-center styling — no hit.
- fragment tails (a #1/#8 hybrid, comp placement) — 1440 — `attempt 2/3` right of `HIGHER QUALITY` and `· · · 47s` leading to `REAL PROGRESS` (zoom F), `· · · 3 seats` after `SPLITBRIEF HOLDS` (G), `//` after `scope,` (E), `state.json` / `5.00 usd` inside the tree (H), `T2 ▸` 28 px under the `§02` stop at the same x reading as a second coordinate (B) — F21, F22.

One distinct tell (#1, minor, two mechanisms). No cap applies. Three worst things named in §2. **Score 8/10** — shippable, tweaks not redos: the desktop stills read designed and faithful, 390 is clean, the sheet is complete and its numbers are its render's, and the choreography is correct on paper; what remains is fragment placement and a hairline through three whispers.

**Per feel adjective:** precise — **earned** (49/59 fidelity rows within tolerance and the ten residuals reasoned; every sheet number matches the JSON; 390 clean) · quiet — **earned** · slightly haunted — **earned, narrowly** (the stops, the spark waiting on the seam with its wake, the traces ending in coordinates, the whisper in the stanza gap — the aura is a system now; its marks stay at the edge of visibility, which is the brief) · believable — **earned**.

craft pass (critic's list): rail through three whispers · six comp fragment placements · `T2 ▸` under the stop · flare timing on the marg-list tick.

## Fix list — cycle 2

- **F21 `carry`** — comp `lower-page.html` (the aura's visual-diff target) · six fragments break the comp's own §16.5/§16.9 rules: `state.json` (C+996, 596) and `· · · · · · · · 5.00 usd` (C+976, 636) inside `pre.tree`'s box at both tiers; `· · · · · · · · · · · · col 1` (E−256, 520) straddles the rail x; `attempt 2/3` (E−226, 266) and `· · · · · · · · 47s` (E−266, 322) sit beside the steps inside the block's own width; `· · · · · · · · · · 3 seats` (C+1066, 300) sits 33 px after `SPLITBRIEF HOLDS` · move each to a free band (the 04 middle band, the 03 head column under the trace row, 02's lower notes gap) and re-run the counts; re-shoot 1440 and 1920.
- **F22 `carry`** — §16.5 keep-clear · add the same-line clearance sentence (item 2 above) and the gutter-glyph y rule (item 3) so the site's placer cannot reproduce the tails; move `T2 ▸` off the stop's column (it reads as a second coordinate).
- **F23 `carry`** — §16.6 · the marg-list tick's flare at 0 ms is invisible (parent opacity 0 until 480 ms, tick scale 0 until 480 ms) · flare `.stop::before` at 0 ms only, or give the marg-list tick its flare after its own `tick` (delay 720 ms).
- **F24 `carry`** — §16 shared grammar / `.marg` · the rail's dashes cut through glyphs where a whisper crosses it · add the glyph-hugging knock-out `text-shadow: 1px 0 var(--bg), -1px 0 var(--bg), 0 1px var(--bg), 0 -1px var(--bg)` on `.marg` (four 1 px offsets, no blur, invisible against the vignette), or state that the crossing is accepted as drawn.
- **F25 `carry`** — owner residuals, unchanged: `▶` markers `--ink-3` vs the reference's orange (recorded, needs a yes); `Build → Verify` / `EXECUTE / REVIEW` (both the reference's, kept); no closing CTA (F20).

VERDICT: 8/10 — SHIP — blocking: 0
