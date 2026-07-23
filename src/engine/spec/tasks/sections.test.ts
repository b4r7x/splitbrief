import { describe, it, expect } from 'vitest';
import { parseTasks, parseTasksStrict } from './parse.js';
import { formatTasks } from '../formatter.js';

describe('typeDefs and implementationSteps parsing', () => {
  it('parses Current Code and Pattern as code context for modify tasks', () => {
    const input = `---
id: T001
title: Test task
action: modify
file: src/test.ts
depends_on: []
---

### Description
Implement something.

### Current Code
\`\`\`typescript
export function existing(): string {
  return 'old';
}
\`\`\`

### Pattern
Follow the existing parser helper shape.

### Tests
- test() should return new value

### Constraints
- Use ESM imports
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.currentCode).toBe("export function existing(): string {\n  return 'old';\n}");
    expect(tasks[0]?.pattern).toBe('Follow the existing parser helper shape.');
  });

  it('keeps ### lines inside a fenced Current Code block out of section headers', () => {
    const input = `---
id: T001
title: Test task
action: modify
file: src/test.ts
depends_on: []
---

### Description
Implement something.

### Current Code
\`\`\`markdown
### Existing heading inside fence
- bullet that must not become a section
\`\`\`

### Tests
- test() should return new value

### Constraints
- Use ESM imports
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.currentCode).toBe(
      '### Existing heading inside fence\n- bullet that must not become a section',
    );
    expect(tasks[0]?.tests).toEqual(['test() should return new value']);
    expect(tasks[0]?.constraints).toEqual(['Use ESM imports']);
  });

  it('preserves nested fenced content inside Current Code instead of truncating at the first inner fence', () => {
    const input = `---
id: T001
title: Test task
action: modify
file: src/test.ts
depends_on: []
---

### Description
Document the fenced example.

### Current Code
\`\`\`\`markdown
Render a snippet:

\`\`\`ts
const greeting = 'hello';
\`\`\`

Then explain it below.
\`\`\`\`

### Tests
- snippet preserved

### Constraints
- Use ESM imports
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.currentCode).toBe(
      "Render a snippet:\n\n```ts\nconst greeting = 'hello';\n```\n\nThen explain it below.",
    );
  });

  it('parses Type Definitions section', () => {
    const input = `---
id: T001
title: Test task
action: create
file: src/test.ts
depends_on: []
---

### Description
Implement something.

### Type Definitions
\`\`\`typescript
export interface Config {
  name: string;
}
\`\`\`

### Tests
- test() should not throw

### Constraints
- Use ESM imports
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.typeDefs).toBe('export interface Config {\n  name: string;\n}');
  });

  it('parses Implementation Steps section', () => {
    const input = `---
id: T001
title: Test task
action: create
file: src/test.ts
depends_on: []
---

### Description
Implement something.

### Implementation Steps
1. Import Config from types
2. Create function that returns void
3. Add validation logic

### Tests
- test() should not throw

### Constraints
- Use ESM imports
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.implementationSteps).toEqual([
      'Import Config from types',
      'Create function that returns void',
      'Add validation logic',
    ]);
    expect(tasks[0]?.typeDefs).toBe('');
  });

  it('accepts legacy implementer heading aliases without losing contract fields', () => {
    const input = `---
id: T001
title: Test task
action: create
file: src/test.ts
depends_on: []
---

### What To Do
Implement something.

### Function Signature
export function test(): void

### Tests (must pass after implementation)
- test() should not throw

### Constraints
- Use ESM imports
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.description).toBe('Implement something.');
    expect(tasks[0]?.signature).toBe('export function test(): void');
    expect(tasks[0]?.tests).toEqual(['test() should not throw']);
  });
});

describe('Task Brief v1 optional sections (Scope, Escalation, Evidence)', () => {
  it('omits scope, escalation, and evidence when sections are absent', () => {
    const input = `---
id: T100
title: "No brief sections"
action: create
file: src/none.ts
depends_on: []
---

### Description
Older brief without Scope/Escalation/Evidence.

### Tests
- Should still parse

### Constraints
- None
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    const task = tasks[0];
    if (!task) throw new Error('expected task');
    expect(task.scope).toBeUndefined();
    expect(task.escalation).toBeUndefined();
    expect(task.evidence).toBeUndefined();
  });

  it('parses Scope in/out bounds, Escalation, and Evidence when present', () => {
    const input = `---
id: T101
title: "Full brief"
action: modify
file: src/full.ts
depends_on: []
---

### Description
A brief with all Task Brief v1 optional sections.

### Scope
**In bounds:**
- update src/full.ts only
- keep public API stable

**Out of bounds:**
- changing unrelated modules
- adding new dependencies

### Tests
- Should compile

### Constraints
- ESM only

### Escalation
- if the public type signature would change
- if a new dependency is required

### Evidence
- npm test passes
- diff limited to src/full.ts
`;

    const tasks = parseTasks(input);
    expect(tasks.length).toBe(1);
    const task = tasks[0];
    if (!task) throw new Error('expected task');
    expect(task.scope).toEqual({
      inBounds: ['update src/full.ts only', 'keep public API stable'],
      outOfBounds: ['changing unrelated modules', 'adding new dependencies'],
    });
    expect(task.escalation).toEqual([
      'if the public type signature would change',
      'if a new dependency is required',
    ]);
    expect(task.evidence).toEqual(['npm test passes', 'diff limited to src/full.ts']);
  });

  it('parses approved out of bounds scope bucket when present', () => {
    const input = `---
id: T103
title: "Approved scope"
action: modify
file: src/approved.ts
depends_on: []
---

### Description
Task with approved exceptions.

### Scope
**In bounds:**
- src/approved.ts

**Out of bounds:**
- unrelated modules

**Approved out of bounds:**
- src/shared/config.ts

### Tests
- Should compile

### Constraints
- None
`;

    const tasks = parseTasks(input);
    const task = tasks[0];
    if (!task) throw new Error('expected task');
    expect(task.scope).toEqual({
      inBounds: ['src/approved.ts'],
      outOfBounds: ['unrelated modules'],
      approvedOutOfBounds: ['src/shared/config.ts'],
    });
  });

  it('round-trips approvedOutOfBounds through formatTasks', () => {
    const input = `---
id: T104
title: "Round trip"
action: modify
file: src/rt.ts
depends_on: []
---

### Description
Round trip approved scope.

### Scope
**Approved out of bounds:**
- src/shared.ts

### Tests
- ok

### Constraints
- none
`;
    const parsed = parseTasks(formatTasks(parseTasks(input)));
    expect(parsed[0]?.scope?.approvedOutOfBounds).toEqual(['src/shared.ts']);
  });

  it('parses Scope when the heading carries a parenthetical suffix', () => {
    const input = `---
id: T105
title: "Suffixed scope heading"
action: modify
file: src/suffix.ts
depends_on: []
---

### Description
Scope heading uses a parenthetical suffix like the sibling sections.

### Scope (Boundaries)
**In bounds:**
- src/suffix.ts

**Out of bounds:**
- everything else

### Tests
- Should compile

### Constraints
- None
`;

    const tasks = parseTasks(input);
    const task = tasks[0];
    if (!task) throw new Error('expected task');
    expect(task.scope).toEqual({
      inBounds: ['src/suffix.ts'],
      outOfBounds: ['everything else'],
    });
  });

  it('sets scope with only one bucket when only one is present', () => {
    const input = `---
id: T102
title: "Partial scope"
action: create
file: src/partial.ts
depends_on: []
---

### Description
Only in bounds listed.

### Scope
**In bounds:**
- new file src/partial.ts

### Tests
- Should compile

### Constraints
- None
`;

    const tasks = parseTasks(input);
    const task = tasks[0];
    if (!task) throw new Error('expected task');
    expect(task.scope).toEqual({ inBounds: ['new file src/partial.ts'] });
  });
});

describe('parseTasksStrict — section grammar warnings', () => {
  it('warns once per unknown ### section that the grammar will drop', () => {
    const input = `---
id: T501
title: "Has extra sections"
action: create
file: src/extra.ts
depends_on: []
---

### Description
A brief with sections outside the canonical grammar.

### Edge Cases
- empty input
- huge input

### Tests
- Should parse

### Constraints
- none

### Notes
Remember to handle retries.
`;
    const warnings: string[] = [];
    const tasks = parseTasksStrict(input, (m) => warnings.push(m));

    expect(tasks).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('T501');
    expect(warnings[0]).toContain('Edge Cases');
    expect(warnings[0]).toContain('Notes');
  });

  it('does not warn when every ### section is in the canonical grammar', () => {
    const input = `---
id: T502
title: "Only canonical sections"
action: create
file: src/canonical.ts
depends_on: []
---

### Description
All sections are recognized.

### Tests
- Should parse

### Constraints
- none
`;
    const warnings: string[] = [];
    parseTasksStrict(input, (m) => warnings.push(m));

    expect(warnings).toEqual([]);
  });

  it('does not treat a ### heading inside a fenced block as an unknown section', () => {
    const input = `---
id: T503
title: "Fenced heading"
action: modify
file: src/fenced.ts
depends_on: []
---

### Description
Body documents a fenced markdown heading.

### Current Code
\`\`\`markdown
### Not A Real Section
\`\`\`

### Tests
- Should parse

### Constraints
- none
`;
    const warnings: string[] = [];
    parseTasksStrict(input, (m) => warnings.push(m));

    expect(warnings).toEqual([]);
  });
});
