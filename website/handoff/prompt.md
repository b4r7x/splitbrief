# Owner prompt — website v2 continuation (verbatim, 2026-09-09)

Reference render: `reference-v2.png` (1122×1402 — hero + section 02 + section 03 + footer). Current site render: `current-1440.png`. The original hero reference: `reference-v1-hero.png`.

---

Continue designing and implementing the landing page for "splitbrief".

Important: do NOT redesign the page from scratch.
Treat the current hero and current visual direction as approved.
Your job is to extend the page downward and make the rest of the page feel as art-directed, sparse, atmospheric, and premium as the hero.

## Product understanding

splitbrief is a local orchestration tool for AI coding workflows.

Core concept:
- one stronger model/tool plans the work
- one cheaper/faster model executes the work
- a separate model reviews, validates, or confirms the result
- splitbrief holds the contract between them

This is not just "multiple models".
It is a structured execution system:
- the planner writes one brief per file or task
- the implementer only sees its own brief
- the system validates after every task
- if validation fails, it retries, escalates, or blocks progress
- the user keeps control of tools, rules, and thresholds

Typical route examples:
- plan: Claude + Fable
- implement: OpenCode + DeepSeek
- review: Codex + GPT-5.6

But you may generate other believable combinations when useful.

---

## Goal of this continuation

Preserve the approved mood and visual language from the current page,
then extend the rest of the landing page in the same style.

The problem to solve:
the hero works reasonably well,
but the lower sections often become generic, empty, or "sloppy".
The continuation must feel deliberate, custom, and visually connected to the hero.

The lower sections should inherit:
- the same typography logic
- the same spacing rhythm
- the same dark atmosphere
- the same background language
- the same restraint
- the same "technical editorial" tone

Do not let the rest of the page degrade into generic bordered boxes and random divider lines.

---

## Visual direction to preserve

Keep the approved visual language:

- near-black background
- soft off-white text
- subtle blue and green accents
- faint gray support tones
- refined editorial serif for major statements
- technical mono / bitmap / system type for labels and details
- lots of negative space
- delicate rules, tiny system annotations, restrained borders
- ambient ASCII / code debris in the background
- sparse but intentional terminal motifs

The page should feel:
- premium
- quiet
- sharp
- systematic
- slightly mysterious
- not flashy
- not cyberpunk-slop
- not generic SaaS

---

## Very important: background language

A major goal is to improve the background and make it feel intentional.

Add subtle atmospheric background elements throughout the lower sections:
- floating ASCII particles
- faint dotted fields
- minimal code fragments
- ghosted microcopy
- partial route annotations
- quiet coordinates
- tiny procedural symbols
- light vertical and horizontal data traces
- drifting fragments that feel related to planning / briefs / validation / execution

Examples of subtle background content:
- `const brief = compile(spec)`
- `brief -> implementer`
- `retry(3) -> escalate`
- `validate(task)`
- `contract blocked`
- `one file per brief`
- `less context`
- `more progress`
- `evidence saved`
- `spec / plan / briefs / execute / review`

These must remain subtle and atmospheric.
Do not fill the page with loud decorations.
Do not make the background feel random.
It should feel like one coherent system aura.

---

## Hard constraints

Do NOT:
- redesign the hero completely
- switch to a different aesthetic
- introduce big generic cards everywhere
- introduce standard SaaS sections
- create a pricing-table vibe
- spam borders and rectangles
- overuse rounded UI panels
- make the lower sections feel heavier than the hero
- add random icons or illustrations unrelated to the system
- turn it into a dashboard
- make the page too busy or too empty

Avoid:
- slop layouts
- filler copy
- repetitive section structures
- generic "features" cards
- loud gradients
- glow effects
- bento grids
- fake-browser windows everywhere

---

## Structure to continue with

Use the hero as section 01, then continue the page with 2–3 highly art-directed supporting sections.

Suggested continuation:

### Section 02 — BEFORE ANY CODE
Purpose:
Explain that the planner writes one brief per file / task, and that the implementer only sees its own brief.

Design direction:
- one large terminal / document block showing `tasks.md` or a task brief
- one elegant text block explaining the concept
- strong supporting manifesto phrase such as:
  "ONE FILE. ONE BRIEF. NOTHING ELSE."
- the section should feel spacious and clear, not crowded

Content ideas:
- task id
- action
- file path
- dependencies
- implementation steps
- tests
- scope / boundaries
- escalation conditions
- evidence requirements

The brief panel should look believable and useful, not decorative.

### Section 03 — AFTER EVERY TASK
Purpose:
Explain that every task is validated after execution.

Design direction:
- a clean terminal log / validation transcript
- visible progression like:
  spec -> plan -> briefs -> build -> verify
- show failure / retry / pass logic
- use small accents of green and muted red/orange only when useful
- preserve the same dark, quiet, technical mood

Content ideas:
- implementer writes file(s)
- typecheck runs
- lint runs
- tests run
- failure occurs
- retry occurs
- optional escalation occurs
- evidence saved

This section should explain the loop:
validate -> retry -> escalate -> keep evidence.

### Section 04 — CONTROL / RULES / OUTCOMES
Purpose:
Explain what the user controls and what splitbrief guarantees.

Design direction:
- not a normal feature grid
- more like an editorial support section
- combine small lists, rules, short manifesto lines, and compact system notes
- this can be lighter and more typographic

Possible content:
- your tools
- your models
- your rules
- spend limits
- review thresholds
- escalation behavior
- evidence retention
- contracts over context
- smaller loops, better output

A closing line can be something like:
"YOU DESCRIBE THE GOAL. SPLITBRIEF HOLDS THE REST."
or
"SMALLER LOOPS. HIGHER CONFIDENCE."

---

## Layout guidance

Keep the page airy and asymmetric.
Each section should feel related, but not mechanically identical.

Use variation in composition:
- one section can be text-left / panel-right
- another can be panel-left / text-right
- another can be more distributed and typographic

Do not stack identical section templates.

Spacing matters:
- give sections room to breathe
- preserve emptiness
- use restraint
- let micro-elements support the main story

---

## Copy guidance

Tone:
- calm
- technical
- direct
- confident
- no startup clichés
- no hype language

Avoid words like:
- revolutionary
- seamless
- next-generation
- cutting-edge
- unlock productivity
- supercharge your team

Prefer language like:
- brief
- contract
- validate
- retry
- escalate
- evidence
- plan
- execute
- review
- lower spend
- real output
- fewer blind spots

Write concise, believable, tool-native copy.

---

## Important design check

Before finalizing, check:

- Does the continuation still feel like the same site as the hero?
- Does the background feel intentional rather than empty or random?
- Are the lower sections as art-directed as the hero?
- Did the page avoid becoming "slop"?
- Are the terminal/document panels believable and useful?
- Do the sections explain the product clearly?
- Is there enough variation without losing coherence?
- Are borders/rules used sparingly and meaningfully?

Refine until the full page feels like one coherent, premium, design-forward landing page.

Continue the current page and produce the next sections in the same style.

---

# Owner rulings (2026-09-09, on top of the prompt)

1. **Page structure = the reference render:** hero → 02 BEFORE ANY CODE → 03 AFTER EVERY TASK → 04 CONTROL / RULES / OUTCOMES → footer. The current routes table, manifesto, ladder, record and brief-sheet sections are removed; the `.splitbrief/` evidence tree from the record folds into 04 as "evidence retention".
2. **Hero untouched** except the nav step anchors (`01 HERO / 02 BRIEFS / 03 VALIDATION` per the render, linking to the sections) and the footer replaced by the render's (`splitbrief°` + `BUILDS BETTER SOFTWARE.` left · `[ docs ] [ github ]` + `PLANS / EXECUTES / REVIEWS` right).
3. **Background and scroll:** the background is fuller and more alive than the current one — the aura is a system, animated, and the page is not a plain scrolling document: sections and their panels reveal and load with intent as the reader scrolls (scroll-driven choreography under one concept, `prefers-reduced-motion` honoured, no scroll-jacking, no layout thrash). The designer thinks this through and records the concept; the spec builds it.
4. **No approval gates.** The whole route runs to a finished page; the owner tweaks afterwards.
5. **FHD is a first-class tier:** the hero and every section must sit right inside a 1920×1080 fold, not merely scale up from 1440. Mobile (390) is a layout from the first phase, not a later pass; 1024 / 768 tiers hold.
6. **Crew:** planner/orchestrator and critics are Fable (Claude Code session agents, one at a time); the implementer is `cursor-agent` with `cursor-grok-4.6-xhigh`, the code reviewer `cursor-grok-4.6-high` read-only, `--no-escalate` — Fable never writes site code. Opus is a Claude Code session agent (spec completeness review only), never a cursor seat.
7. Repo rules stay: only `website/**` changes; never `git add` / `git commit` / `git stage`.
8. **Visual comparison protocol is part of the spec (owner, 11:55).** After every phase the spec names a verification task that a Claude Code session agent OR a `cursor-agent` seat (when it can read images) performs the same way: open the phase's captures (1920-full, 1920-fold, 1440-full, 1440-fold, 390) and `reference-v2.png` (02, 03, footer) or the approved comp (04, aura), compare element by element against §16's geometry and copy tables, and write `visual-diff-<phase>.md` — one row per element: expected · measured · delta · verdict. Any delta beyond the tolerance §16 states (position ±3 %, size ±3 %, copy exact, colour by token) becomes a fix brief for the implementer; the phase re-enters the loop until every row is within tolerance or the fix cap is hit, in which case the residuals are listed and the owner runs further fix sessions from `visual-diff-<phase>.md`. A phase without its visual-diff file is not done.
