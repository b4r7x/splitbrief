# Flow Atlas — data contract

`flow-atlas/` is a local, open-in-a-browser map of every flow and decision in SPLITBRIEF.
Open `flow-atlas/index.html` directly from disk (file://). No build step.

Each area of the app is one data file: `flow-atlas/data/<id>.js`. Files are plain
scripts (not JSON, not modules) so they load from file:// without fetch/CORS.
`index.html` lists them in `<script>` tags.

## File shape

```js
window.ATLAS = window.ATLAS || [];
window.ATLAS.push({
  id: 'recovery',               // kebab-case, equals the file name
  order: 6,                     // position in the sidebar / overview
  title: 'Halty, limity i fallback',
  tagline: 'One line: what this area decides.',
  summary: `Markdown-lite paragraphs (Polish). **bold**, \`code\`, - lists, blank line = new paragraph.`,
  entry: ['src/engine/orchestrator/recovery/bus.ts:42'],   // where control enters this area
  links: [                       // edges for the overview map (to another area id)
    { to: 'build', label: 'po wyborze Retry wraca do pętli briefów' }
  ],
  diagrams: [
    {
      id: 'recovery-main',       // unique in the whole atlas
      title: 'Od błędu wywołania do menu Needs you / Seat down',
      caption: 'Plain words: what to read from this diagram.',
      mermaid: `flowchart TD
  A["Wywołanie seat-a kończy się błędem"] --> RC_CAUSE{"Jaka przyczyna?"}
  RC_CAUSE -->|"limit konta"| B["..."]`
    }
  ],
  decisions: [                   // every if/switch that changes what happens next
    {
      id: 'RC_CAUSE',            // UPPER_SNAKE, prefix = area code; unique in the atlas.
                                 // A diamond in a diagram that shows this decision uses
                                 // exactly this id as its Mermaid node id, so the page
                                 // can link the diamond to this card.
      title: 'Klasyfikacja przyczyny błędu wywołania',
      question: 'Co dokładnie poszło nie tak w wywołaniu?',
      where: 'src/core/recovery/account-cause.ts:57',       // file:line in the current tree
      inputs: ['stderr narzędzia', 'exit code'],             // what the decision reads
      branches: [
        { if: 'tekst pasuje do wzorca limitu godzinowego', then: 'cause = rate-limit, reset za N min', next: 'RC_WAIT' }
      ],
      default: 'Co się dzieje, gdy żaden warunek nie pasuje.',
      notes: 'Optional: edge cases, why it is built so.'
    }
  ],
  config: [                      // config keys / env vars / flags that steer this area
    { key: 'crew.planner.fallback', values: 'seat spec', default: 'brak', effect: '...', where: 'src/...:12' }
  ],
  states: [                      // optional: named states/statuses/phases of this area
    { name: 'waiting-for-you', meaning: '...', where: 'src/...:3' }
  ],
  scenarios: [                   // concrete "what happens when ..." walk-throughs
    {
      title: 'Planner trafia na limit 5h w trakcie planowania, fallback ustawiony',
      steps: ['1. ...', '2. ...'],
      outcome: 'Run idzie dalej na Codex; seatSwitches ma 1 wpis.'
    }
  ],
  files: [ { path: 'src/core/recovery/halt.ts', role: 'haltOf: tytuł menu recovery' } ],
  gotchas: ['Non-obvious rules, code-vs-docs mismatches (code wins), limits like "once per run and seat".']
});
```

## FAQ file

`flow-atlas/data/faq.js` is not an area. It pushes question entries into a separate global,
`window.ATLAS_FAQ`: `{ id, q, a, refs, tags }`. `refs` lists the sources of the answer:
a decision id (`RC_HALT_OF`), `area:<id>` or `diagram:<id>`. Every ref must resolve; `check.mjs`
fails on a ref that does not. The first tag picks the group in the view. The first sentence of `a`
is the short answer. See README.md for the full rules.

## Rules for authors

- Read the **code**, not only the docs. Every `where` is a real `file:line` in the current tree.
  If docs and code disagree, follow the code and add a line to `gotchas`.
- Text is Polish, short sentences. Identifiers, config keys, event names, UI strings stay verbatim
  in English in backticks (`Seat down · <cause>`).
- Use template literals for `summary` and `mermaid`. Do not use a backtick inside them; escape
  `${` as `\${`.
- Mermaid (v11): `flowchart TD` or `flowchart LR`, `stateDiagram-v2` or `sequenceDiagram`.
  Quote every label: `A["text"]`, `D{"text?"}`, edge labels `-->|"text"|`. No `end`/`graph`/`class`
  as bare node ids. No HTML except `<br/>`. Keep one diagram under ~45 nodes; split a bigger flow.
  Decision diamonds use the decision `id` as the node id.
- Cover the unhappy paths: errors, limits, timeouts, user cancel, crash and resume.
- No invented behaviour. Unsure → read more code. Still unsure → say so in `notes`.
