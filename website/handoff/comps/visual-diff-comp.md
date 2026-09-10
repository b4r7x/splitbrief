# visual-diff-comp — the comp against `reference-v2.png` (02, 03, footer), fix cycle 1

Method: the reference (1122 px wide) measured by lit-pixel runs (`scratchpad/measure_ref.py`, `measure2.py`; canvas median (8,11,13), text threshold lum 40–60, whispers 22–30). Reference x is absolute, y is section-relative from the seam row (02: y 664, 03: y 1101). Expected at 1440 = ref × 1.2834 (viewport scale; the reference content box 53 → 1090 lands at 68 → 1399 against the site`s 64 → 1376). Expected at 1920 = the reference scaled into the 1392 content box (x = 264 + (ref − 53) × 1.3423; sizes and y × 1.3423). Measured = `comps/lower-geometry.json` (box tops; a box top sits 3–5 px above the glyph top the reference gives, so y deltas carry that offset). Tolerances (ruling 8): position ±3 % of the viewport (x ±43 / ±58 px, y ±27 / ±32 px), size ±3 % of the expected, copy exact, colour by token.

**Summary:** 59 geometry rows — 49 within tolerance at both tiers; 10 outside, every one with a recorded reason below (0 unrecorded). Copy: exact except the three recorded product-true deviations (typos, evidence path, statement 2 by ruling F17) and the `▶` ink. Colour: every element by token.


## 02 — BEFORE ANY CODE

| element | reference (ref px) | expected 1440 | measured 1440 | delta | verdict | expected 1920 | measured 1920 | delta | verdict | reason (when out of tolerance) |
|---|---|---|---|---|---|---|---|---|---|---|
| eyebrow `02` x | 54 | 69 | 64 | -5 | ✓ | 265 | 264 | -1 | ✓ |  |
| eyebrow y (glyph top → box top) | 33 | 42 | 33 | -9 | ✓ | 44 | 33 | -11 | ✓ |  |
| title `BEFORE ANY CODE` y | 69 | 89 | 83 | -5 | ✓ | 93 | 83 | -9 | ✓ |  |
| title width | 169 | 217 | 223 | +6 (+2.9 %) | ✓ | 227 | 223 | -4 (-1.6 %) | ✓ | 24px at both tiers: the reference scaled into 1392 is 24.4px, so the title has no FHD step |
| serif sub y | 94 | 121 | 121 | +1 | ✓ | 126 | 121 | -5 | ✓ |  |
| serif line pitch | 24 | 31 | 30 | -1 (-1.8 %) | ✓ | 32 | 31 | -1 (-2.8 %) | ✓ |  |
| tick-list y (tick top) | 212 | 272 | 277 | +5 | ✓ | 285 | 280 | -4 | ✓ |  |
| tick-list pitch | 12.5 | 16 | 16 | -0 (-0.3 %) | ✓ | 17 | 16 | -1 (-4.6 %) | ✗ | the hero`s `--text-micro` list pitch (16px) is a hero token and does not step at 1920 |
| panel x | 293 | 376 | 398 | +22 | ✓ | 586 | 618 | +32 | ✓ |  |
| panel width | 385 | 494 | 494 | -0 (-0.0 %) | ✓ | 517 | 517 | +0 (+0.0 %) | ✓ |  |
| panel top y | 25 | 32 | 25 | -7 | ✓ | 34 | 25 | -9 | ✓ |  |
| panel height | 396 | 508 | 508 | -0 (-0.0 %) | ✓ | 532 | 546 | +14 (+2.7 %) | ✓ |  |
| bar height | 24 | 31 | 30 | -1 (-2.6 %) | ✓ | 32 | 32 | -0 (-0.7 %) | ✓ |  |
| row pitch | 10.11 | 13 | 13 | +0 (+0.2 %) | ✓ | 14 | 14 | +0 (+3.2 %) | ✗ | 1920: an integer pitch (13.57 → 14) — a fractional line-height would paint the gutter numbers on alternating half pixels |
| row advance per character | 5.43 | 7 | 7 | -0 (-5.3 %) | ✗ | 7 | 7 | -0 (-1.2 %) | ✓ | 11px (6.6) and 12px (7.2) bracket the reference`s 6.97; 11px keeps the reference`s 13px pitch at a 1.18 leading |
| notes x | 707 | 907 | 916 | +9 | ✓ | 1142 | 1159 | +17 | ✓ |  |
| notes measure (41 ch) | 249 | 320 | 320 | +0 (+0.1 %) | ✓ | 334 | 344 | +10 (+3.0 %) | ✗ | 1920: `--text-note` is the nearest whole pixel (14) to the content-scaled 13.6px; the 41ch measure follows it (+3.05 %) |
| notes line pitch | 16.25 | 21 | 21 | -0 (-0.3 %) | ✓ | 22 | 22 | +1 (+2.7 %) | ✓ |  |
| statement 1 y | 42 | 54 | 33 | -21 | ✓ | 56 | 33 | -23 | ✓ |  |
| caps 1 y | 148 | 190 | 178 | -12 | ✓ | 199 | 186 | -13 | ✓ |  |
| statement 2 y | 222 | 285 | 281 | -4 | ✓ | 298 | 289 | -9 | ✓ |  |
| caps 2 y | 319 | 409 | 409 | -0 | ✓ | 428 | 425 | -3 | ✓ |  |
| marg-list `SPEC…` x | 1011 | 1298 | 1304 | +6 | ✓ | 1550 | 1584 | +34 | ✓ |  |
| marg-list tick y | 144 | 185 | 178 | -7 | ✓ | 193 | 186 | -7 | ✓ |  |
| marg-list first line y | 159 | 204 | 194 | -10 | ✓ | 213 | 202 | -11 | ✓ |  |
| `// contracts over context` right edge | 1087 | 1395 | 1376 | -19 | ✓ | 1652 | 1656 | +4 | ✓ |  |
| `// contracts over context` y | 113 | 145 | 121 | -24 | ✓ | 152 | 129 | -23 | ✓ |  |
| `less context / more progress.` right edge | 1050 | 1348 | 1352 | +4 | ✓ | 1602 | 1632 | +30 | ✓ |  |
| `less context / more progress.` left edge | 978 | 1255 | 1260 | +4 | ✓ | 1506 | 1540 | +34 | ✓ |  |
| `less context / more progress.` y | 348 | 447 | 447 | +0 | ✓ | 467 | 463 | -4 | ✓ |  |
| section 02 height | 437 | 561 | 557 | -4 (-0.7 %) | ✓ | 587 | 595 | +8 (+1.4 %) | ✓ |  |

## 03 — AFTER EVERY TASK

| element | reference (ref px) | expected 1440 | measured 1440 | delta | verdict | expected 1920 | measured 1920 | delta | verdict | reason (when out of tolerance) |
|---|---|---|---|---|---|---|---|---|---|---|
| eyebrow y | 17 | 22 | 33 | +11 | ✓ | 23 | 33 | +10 | ✓ |  |
| title y | 53 | 68 | 83 | +15 | ✓ | 71 | 83 | +12 | ✓ |  |
| serif y | 80 | 103 | 121 | +19 | ✓ | 107 | 121 | +14 | ✓ |  |
| serif line pitch (4 lines) | 23.5 | 30 | 30 | +0 (+0.3 %) | ✓ | 32 | 31 | -0 (-0.7 %) | ✓ |  |
| panel x | 293 | 376 | 398 | +22 | ✓ | 586 | 618 | +32 | ✓ |  |
| panel width | 385 | 494 | 494 | -0 (-0.0 %) | ✓ | 517 | 517 | +0 (+0.0 %) | ✓ |  |
| panel top y | 18 | 23 | 25 | +2 | ✓ | 24 | 25 | +1 | ✓ |  |
| panel height | 247 | 317 | 313 | -4 (-1.3 %) | ✓ | 332 | 336 | +4 (+1.3 %) | ✓ |  |
| row pitch | 10.25 | 13 | 13 | -0 (-1.2 %) | ✓ | 14 | 14 | +0 (+1.8 %) | ✓ | as 02: one integer pitch for both panels |
| statement 1 y | 24 | 31 | 33 | +2 | ✓ | 32 | 33 | +1 | ✓ |  |
| statement 2 y | 82 | 105 | 124 | +19 | ✓ | 110 | 131 | +21 | ✓ |  |
| steps `01 HIGHER QUALITY` y | 170 | 218 | 257 | +39 | ✗ | 228 | 273 | +45 | ✗ | the reference sets statement 2 in five lines of 44 characters because its 03 column is 7 % smaller type than 02`s (5.66 vs 6.07 ref px per character in the same 249 px measure); one note size sets it in six lines, one line (21 px) lower |
| steps x | 707 | 907 | 916 | +9 | ✓ | 1142 | 1159 | +17 | ✓ |  |
| steps rule x (from the text start) | 20 | 26 | 32 | +6 (+24.7 %) | ✗ | 27 | 32 | +5 (+19.2 %) | ✗ | the hero`s steps grammar: a 32px number cell (§4); the reference`s is 26px |
| marg-list `VALIDATE…` x | 1010 | 1296 | 1304 | +8 | ✓ | 1549 | 1584 | +35 | ✓ |  |
| marg-list tick y | 87 | 112 | 124 | +12 | ✓ | 117 | 131 | +14 | ✓ |  |
| marg-list first line y | 103 | 132 | 140 | +8 | ✓ | 138 | 147 | +9 | ✓ |  |
| `// not its own judge` right edge | 1090 | 1399 | 1376 | -23 | ✓ | 1656 | 1656 | +0 | ✓ |  |
| `// not its own judge` y | 56 | 72 | 98 | +26 | ✓ | 75 | 103 | +28 | ✓ |  |
| `A SMALLER LOOP…` right edge | 1034 | 1327 | 1352 | +25 | ✓ | 1581 | 1632 | +51 | ✓ |  |
| `A SMALLER LOOP…` left edge | 960 | 1232 | 1247 | +15 | ✓ | 1481 | 1527 | +46 | ✓ |  |
| `A SMALLER LOOP…` y | 210 | 270 | 293 | +23 | ✓ | 282 | 309 | +27 | ✓ |  |

## Footer

| element | reference (ref px) | expected 1440 | measured 1440 | delta | verdict | expected 1920 | measured 1920 | delta | verdict | reason (when out of tolerance) |
|---|---|---|---|---|---|---|---|---|---|---|
| wordmark x | 52 | 67 | 64 | -3 | ✓ | 263 | 264 | +1 | ✓ |  |
| wordmark width | 66 | 85 | 140 | +55 (+65.2 %) | ✗ | 89 | 140 | +51 (+57.9 %) | ✗ | the nav`s wordmark verbatim (22px, §3/§10); the reference footer sets it at 14px, a thumbnail-scale hint |
| claim x | 136 | 175 | 236 | +61 | ✗ | 375 | 436 | +60 | ✗ | the claim follows the nav`s 140px wordmark at `--s-8`; the reference`s 14px wordmark ends 89px earlier |
| claim font (advance per character) | 4.3 | 6 | 7 | +2 (+30.5 %) | ✗ | 6 | 7 | +1 (+24.7 %) | ✗ | `--text-label` (12px) is the page`s floor; the reference`s 6.9px footer type is unreadable at 1440 |
| `[ docs ]` x | 815 | 1046 | 961 | -85 | ✗ | 1287 | 1241 | -46 | ✓ | 12px type is wider than the reference`s 6.9px; the links keep their distance from the seats |
| seats right edge | 1070 | 1373 | 1376 | +3 | ✓ | 1629 | 1656 | +27 | ✓ |  |

## Copy — reference → comp, string by string

| surface | reference | comp | verdict |
|---|---|---|---|
| 02 head, tick-list, panel bar, marg-list, `// contracts over context`, `less context / more progress.`, caps 1, caps 2, statement 1 | verbatim | verbatim | ✓ |
| 02 editor row 14 | `typeercipt` | `typescript` | typo corrected (recorded, §16.1) |
| 02 editor row 30 | `Out of bounds::` | `Out of bounds:` | typo corrected (recorded, §16.1) |
| 02 statement 2 | `…validates every task upfront — typecheck, lint, test — and stops at the first domain or contract error.` | `…validates every brief upfront — scope, file, dependencies, signature — and stops at the first domain or contract error.` | product-true rewrite by ruling (F17): a brief cannot be typechecked before code exists; the code is validated after every task in 03 |
| 03 head, panel bar, rows 01–20, statements, steps, marg-list, `// not its own judge` | verbatim | verbatim | ✓ (row 02`s number was `01` in the reference — a numbering slip, corrected) |
| 03 row 21 | `.splitbrief/runs/2025-03-08/T002/` | `.splitbrief/sessions/2026-03-08-auth-guard/` | product-true: the session directory `HOW-IT-WORKS.md` documents (recorded, §16.2) |
| 03 `A SMALLER LOOP / A HIGHER BAR / REAL PROGRESS` | caps | caps | ✓ (was lowercase in the round-1 comp; restored) |
| 03 `▶` markers | warm orange (245,110,72) | `--ink-3` | recorded decision (§16.2): the failure triplet is the panel`s one hot spot |
| footer | `splitbrief°` · `BUILDS BETTER SOFTWARE.` · `[ docs ]` · `[ github ]` · `PLANS / EXECUTES / REVIEWS` | verbatim | ✓ |

## Colour — by token

| element | reference (peak lum) | token | verdict |
|---|---|---|---|
| titles | 255 | `--ink` | ✓ |
| serif triplets | 137–143 | `--ink-3` | ✓ |
| eyebrows, marg-lists, tick-list | 111–134 | `--ink-3` | ✓ |
| statements | ~205, bold words 255 | `--ink-2`, `<b>` `--ink` | ✓ |
| `//` notes and whispers | 52–58 | `--ink-4` (73) | ✓ in spirit — the reference sets them dimmer; decorative, `aria-hidden` (F13) |
| panel fill / border / line numbers | (12,17,20) / (21,26,30) / 74–79 | `--panel` / `--hair` / `--ink-4` | ✓ |
| editor headings | (110,158,201) | `--blue` | ✓ |
| terminal `●` `✓` `PASS` | (89,233,158) | `--green` | ✓ |
| `✗` `error` `FAIL` | (228,80,67) / (173,77,61) / (216,77,84) | `--red` | ✓ |
| footer wordmark / claim / links / seats | 255 / 176 / 179 / 95 | `--ink` / `--ink-2` / `--ink-2` / `--ink-3` | ✓ |

