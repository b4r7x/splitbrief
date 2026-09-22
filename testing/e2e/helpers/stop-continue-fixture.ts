import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { SPLITBRIEF_IDENTITY } from '../../../src/core/identity.js';
import { ISOLATION_TREES_DIR, SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import type { Config } from '../../../src/core/schemas/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

/** The brief's anchor: written by the orchestrator from the implementer's reply. */
export const GREET_FILE = 'src/greet.ts';

/**
 * The brief's second declared file, written by the implementer process itself
 * before it holds the call open. It is the partial output a cut attempt leaves
 * behind, and the progress marker the test waits on before it signals the run.
 */
export const MARKER_FILE = 'src/marker.ts';

export const MARKER_SOURCE = "export const RUN_MARKER = 'implementer-started';\n";

/** The implementer writes this verbatim, so it is byte-for-byte what lands on disk. */
export const GREET_SOURCE = `export function greet(name: string): string {
  return name === '' ? 'hello' : \`hello \${name}\`;
}`;

/** How long the implementer stays in the call after writing the marker. */
const IMPLEMENTER_HOLD_MS = 4000;

const TASK_BRIEF = `---
id: T001
title: Add a greeting helper
action: create
file: ${GREET_FILE}
files:
  - ${GREET_FILE}
  - ${MARKER_FILE}
depends_on: []
---

### Description

Add a standalone greeting helper plus the run marker constant beside it.

### Signature

\`\`\`
export function greet(name: string): string
\`\`\`

### Type Definitions

\`\`\`
// greet: (name: string) => string
\`\`\`

### Pattern

A plain exported function with no imports, like the rest of this project.

### Implementation Steps

1. Create \`${MARKER_FILE}\` exporting \`RUN_MARKER\`.
2. Create \`${GREET_FILE}\` exporting \`greet\`.

### Tests

- greet('a') === 'hello a'
- greet('') === 'hello'

### Scope

**In bounds:**
- ${GREET_FILE}
- ${MARKER_FILE}

**Out of bounds:**
- everything else

### Escalation

- Stop and ask if the greeting wording is ambiguous.

### Evidence

- Both declared files exist and export the named symbols.

### Constraints

- No imports; the module stands alone.
`;

const REVIEW_REPLY = `### Verdict

pass

### Criteria Results

- **[PASS]** greet returns a greeting -- the helper is present.

### Findings

- **Note**: Fixture run.

### Summary

The fixture implementation matches its brief.
`;

/**
 * Both planner calls of a quick run reach this one script: the brief compile and
 * the final review. Only `buildFinalReviewPrompt` titles its prompt "Final
 * Implementation Review", so the title is what the script branches on.
 */
const PLANNER_SCRIPT = `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf-8');

const TASKS = ${JSON.stringify(TASK_BRIEF)};
const REVIEW = ${JSON.stringify(REVIEW_REPLY)};

process.stdout.write(prompt.includes('Final Implementation Review') ? REVIEW : TASKS);
`;

/**
 * Writes its two declared files in two steps with the hold between them, so a cut lands with the
 * marker on disk and the anchor still missing. A direct writer is what the brief needs: an
 * extracting runner can only carry one file back, and this brief declares two.
 */
const IMPLEMENTER_SCRIPT = `import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

for await (const chunk of process.stdin) void chunk;

mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
await delay(${IMPLEMENTER_HOLD_MS});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`;

export type StopContinueFixture = Readonly<{
  tmpDir: string;
  projectDir: string;
  stateHome: string;
  /**
   * Where the run's isolation worktrees land under this fixture's state home. The implementer
   * writes there, and nothing reaches `projectDir` until the brief's changes are promoted, so
   * this is the only place a mid-brief write is visible.
   */
  isolationTreesDir: string;
  markerPath: string;
  greetPath: string;
}>;

/**
 * A throwaway repository whose planner and implementer are local node scripts,
 * so the whole stop → continue → finish path runs without a model call.
 */
export function createStopContinueFixture(): StopContinueFixture {
  const tmpDir = mkdtempSync(join(tmpdir(), 'splitbrief-stop-continue-'));
  const projectDir = join(tmpDir, 'project');
  mkdirSync(projectDir, { recursive: true });

  createTestGitRepo(projectDir, {
    '.gitignore': 'node_modules\n',
    'tools/planner.mjs': PLANNER_SCRIPT,
    'tools/implementer.mjs': IMPLEMENTER_SCRIPT,
  });

  mkdirSync(join(projectDir, SPLITBRIEF_DIR), { recursive: true });
  writeFileSync(
    join(projectDir, SPLITBRIEF_DIR, 'config.yaml'),
    YAML.stringify(fixtureConfig()),
    'utf-8',
  );

  const stateHome = join(tmpDir, 'state');
  mkdirSync(stateHome, { recursive: true });

  return {
    tmpDir,
    projectDir,
    stateHome,
    isolationTreesDir: join(stateHome, SPLITBRIEF_IDENTITY.slug, ISOLATION_TREES_DIR),
    markerPath: join(projectDir, MARKER_FILE),
    greetPath: join(projectDir, GREET_FILE),
  };
}

function fixtureConfig(): Config {
  return makeConfig({
    planner: {
      kind: 'shell',
      command: 'node',
      args: ['./tools/planner.mjs'],
      outputFormat: 'text',
      capabilities: {
        supportsConversationalPlanning: false,
        supportsHintEscalation: false,
        supportsSessionResume: false,
      },
    },
    implementer: {
      kind: 'agent',
      command: 'node',
      args: ['./tools/implementer.mjs'],
      outputFormat: 'text',
      model: 'fixture',
      // A fixture model has no catalog window, and routing refuses a profile it cannot prove
      // the brief fits: without this the run halts on context-overflow before the script runs.
      contextLength: 200_000,
    },
    validation: { typecheck: false, lint: false, test: false },
    workflow: { mode: 'quick', approve: 'none', maxRetries: 1 },
  });
}
