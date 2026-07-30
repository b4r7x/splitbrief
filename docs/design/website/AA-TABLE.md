# Website WCAG AA contrast evidence

This is the P2 measurement record for the shipped tokens in
`website/src/styles/index.css`. The colocated `tokens.test.ts` reads those CSS rules directly;
the hexadecimal values below are evidence, not a second input to the test.

## Method

The test uses the WCAG sRGB transfer function, relative-luminance coefficients
`0.2126 / 0.7152 / 0.0722`, and `(lighter + 0.05) / (darker + 0.05)`. It requires
4.5:1 for normal text and 3:1 for non-text UI components and meaningful graphics. Comparisons
run at full precision; this record rounds only the displayed ratios to three decimals.

Every semantic color is measured on all three surfaces:

| Theme | `--ground` | `--surface-1` | `--surface-2` |
| --- | --- | --- | --- |
| Dark | `#0B0B0D` | `#141416` | `#1E1E21` |
| Docs light | `#E8E6E1` | `#DDDBD6` | `#D2D0CB` |

The dark tier's lightest surface and the docs-light tier's darkest surface are both
`--surface-2`, so that final column is the worst case in each theme. `--fg` supplies each
custom Shiki theme's editor foreground, and `--dim` supplies its comment foreground; the test
enforces both de-drift boundaries.

| Theme | Token | Role | Value | Ground | Surface 1 | Surface 2 | Minimum | Result |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Dark | `--fg` | Normal text | `#E8E6E1` | 15.766 | 14.751 | 13.332 | ≥ 4.5:1 | Pass |
| Dark | `--dim` | Normal text / comments | `#A8A6A1` | 8.085 | 7.565 | 6.837 | ≥ 4.5:1 | Pass |
| Dark | `--planner` | Non-text only | `#E0409A` | 5.028 | 4.704 | 4.252 | ≥ 3.0:1 | Pass |
| Dark | `--planner-text` | Normal text | `#E85FA8` | 6.212 | 5.812 | 5.253 | ≥ 4.5:1 | Pass |
| Dark | `--implementer` | Normal text | `#3FD2E0` | 10.775 | 10.081 | 9.111 | ≥ 4.5:1 | Pass |
| Dark | `--pin` | Non-text selection | `#C9A26B` | 8.300 | 7.766 | 7.019 | ≥ 3.0:1 | Pass |
| Dark | `--focus` | Non-text focus | `#E8E6E1` | 15.766 | 14.751 | 13.332 | ≥ 3.0:1 | Pass |
| Dark | `--grid-functional` | Non-text boundary | `#6E6E76` | 3.891 | 3.640 | 3.290 | ≥ 3.0:1 | Pass |
| Dark | `--grid-decorative` | Decorative grid | `#2A2A2E` | 1.376 | 1.287 | 1.163 | Exempt | No semantic use |
| Docs light | `--fg` | Normal text | `#1A1A1C` | 13.933 | 12.560 | 11.275 | ≥ 4.5:1 | Pass |
| Docs light | `--dim` | Normal text / comments | `#55554F` | 6.016 | 5.424 | 4.869 | ≥ 4.5:1 | Pass |
| Docs light | `--planner` | Non-text only | `#B01D72` | 5.157 | 4.649 | 4.173 | ≥ 3.0:1 | Pass |
| Docs light | `--planner-text` | Normal text | `#A01A67` | 5.932 | 5.348 | 4.800 | ≥ 4.5:1 | Pass |
| Docs light | `--implementer` | Normal text | `#0B5E66` | 5.998 | 5.407 | 4.854 | ≥ 4.5:1 | Pass |
| Docs light | `--pin` | Non-text selection | `#7A5F33` | 4.794 | 4.322 | 3.879 | ≥ 3.0:1 | Pass |
| Docs light | `--focus` | Non-text focus | `#1A1A1C` | 13.933 | 12.560 | 11.275 | ≥ 3.0:1 | Pass |
| Docs light | `--grid-functional` | Non-text boundary | `#6E6E68` | 4.113 | 3.708 | 3.329 | ≥ 3.0:1 | Pass |
| Docs light | `--grid-decorative` | Decorative grid | `#D2D0CB` | 1.236 | 1.114 | 1.000 | Exempt | No semantic use |

`--planner` remains non-text-only: its 4.252:1 dark and 4.173:1 docs-light worst
cases do not meet the 4.5:1 normal-text floor. Magenta text uses `--planner-text`.
`--grid-decorative` is deliberately exempt because it is only a background hairline texture;
no label, boundary, selection, focus state, or operating instruction may depend on it.

## Inset-wash rule

The planner and implementer crosshair washes are fixed at 8% alpha. They are supplementary
fills, not independent meaning channels: the full-color row and column rules, headers, and
active-cell outline carry the state. A wash must be painted inside the cell or label and must
not cover or replace any `--grid-functional` pixel. The functional-grid measurements above
therefore compare the grid directly with each base surface. If a wash overlays the boundary,
this evidence no longer proves that implementation.

## Theme boundary

The dark token rule explicitly includes `.landing-shell`, and the landing route declares
`data-theme="dark"`. The light token rule matches only a `.docs-shell` carrying or descending
from `data-theme="light"`. A stored docs preference therefore cannot retone the landing.

Focused evidence command:

```bash
cd website
npm test -- src/styles/tokens.test.ts
```
