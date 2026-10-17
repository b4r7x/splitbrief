import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { groupEventsIntoSections } from '../../../src/core/sections/event-sections.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { rowText } from '../../../src/features/workflow/conversation-rows/row-format/rows.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { buildConversationRows } from '#testing/helpers/event-rows.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import {
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const alpha = makeTaskSpec({
  id: 'T001',
  title: 'Add the alpha value',
  intent: 'Return the alpha value.',
  criteria: ['C1'],
  suggestedFiles: ['src/alpha.mjs', 'src/alpha.test.mjs'],
  checks: [{ id: 'T001-K1', kind: 'test', value: 'src/alpha.test.mjs', required: true }],
});
const plan = makePlanProposal({
  summary: 'Add one tested value.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'Alpha is the string alpha.', checkIds: ['T001-K1'] }],
  tasks: [alpha],
});
const ALPHA_FILES = {
  'src/alpha.mjs': "export const alpha = 'alpha';\n",
  'src/alpha.test.mjs':
    "import { strict as assert } from 'node:assert';\nimport { alpha } from './alpha.mjs';\nassert.equal(alpha, 'alpha');\n",
};
// The first attempt reports `kept`, which PLAN confirms in other words. The retry reports
// `escaped`, whose text holds a JSON escape that PLAN returns as the character it encodes.
const kept = { what: 'Kept alpha in one module', why: 'The test imports it from there.' };
const keptReworded = { what: 'Kept the alpha value in one module', why: kept.why };
const escaped = { what: 'Matched the range \\u0300-\\u036f', why: 'The brief names it.' };
const escapedDecoded = { what: 'Matched the range ̀-ͯ', why: escaped.why };
const rejectReason = 'The wording changed; report the decision again.';
const confirmReason = 'The range is the one the brief names.';

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

beforeEach(() => resetAllStores());

afterEach(() => {
  resetAllStores();
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

function transcriptRows(events: EngineEvent[]): string[] {
  return buildConversationRows({
    sections: groupEventsIntoSections(events),
    expandedDiffs: new Set(),
    expandedActivityBatches: new Set(),
    cols: 160,
    viewportHeight: 50,
    streaming: { taskId: null, lines: [], active: false },
  }).rows.map((row) => rowText(row).trimEnd());
}

async function runDecisionConfirms() {
  fixture = createStopContinueFixture(() => '', { isolation: 'none' });
  const target = fixture;
  restorePath = activateSafeCliShimPath(target.tmpDir);
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
  const confirmsPath = join(target.tmpDir, 'confirms');
  const attemptsPath = join(target.tmpDir, 'attempts');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const passing = passingVerdict({ kind: 'final', taskIds: [alpha.id], criterionIds: ['C1'] });
  const confirms = [
    { answer: { diagnosis: rejectReason, action: 'confirm', decisions: [keptReworded] } },
    { answer: { diagnosis: confirmReason, action: 'confirm', decisions: [escapedDecoded] } },
  ];
  writeFileSync(
    plannerPath,
    `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let answer;
if (prompt.includes('# Task Implementation Review') || prompt.includes('# Final Implementation Review')) {
  answer = ${JSON.stringify(passing)};
} else if (prompt.includes('Confirm reported decisions')) {
  const asked = existsSync(${JSON.stringify(confirmsPath)})
    ? readFileSync(${JSON.stringify(confirmsPath)}, 'utf8').length
    : 0;
  appendFileSync(${JSON.stringify(confirmsPath)}, 'x');
  answer = ${JSON.stringify(confirms)}[asked];
} else if (prompt.includes('# Plan the change')) {
  answer = ${JSON.stringify({ result: plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
process.stdout.write(JSON.stringify(answer));
`,
  );
  writeFileSync(
    implementerPath,
    `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
for await (const _chunk of process.stdin);
const attempt = existsSync(${JSON.stringify(attemptsPath)})
  ? readFileSync(${JSON.stringify(attemptsPath)}, 'utf8').length
  : 0;
appendFileSync(${JSON.stringify(attemptsPath)}, 'x');
for (const [file, source] of Object.entries(${JSON.stringify(ALPHA_FILES)})) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
}
// The retry keeps the first attempt's files, so each attempt marks its own change.
appendFileSync('src/alpha.mjs', '// attempt ' + attempt + '\\n');
console.log('Implemented T001');
console.log(JSON.stringify({
  status: 'done',
  filesChanged: ${JSON.stringify(Object.keys(ALPHA_FILES))},
  touchedNotSuggested: [],
  notes: null,
  decisions: [${JSON.stringify([kept, escaped])}[Math.min(attempt, 1)]],
}));
`,
  );
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
    throw new Error('Expected local shell and agent fixture runners');
  }
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: { ...config.implementer, args: [implementerPath] },
    validation: { ...config.validation, testCommand: 'node --test' },
  });
  const run = await cli(target, ['start', 'smoke']);
  expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
  const sessions = readdirSync(sessionsRoot(target.projectDir));
  expect(sessions).toHaveLength(1);
  const sessionId = sessions[0];
  if (sessionId === undefined) throw new Error('Missing session');
  const replay = await readRunEvents({ projectDir: target.projectDir, sessionId });
  return { state: readState(target, sessionId), events: replay.events };
}

describe('e2e: decision confirm ledger', () => {
  it('keeps a reworded decision out of the ledger and records a confirmed one in the implementer words', async () => {
    const { state, events } = await runDecisionConfirms();

    expect(state.phase).toBe('complete');
    expect(
      events
        .filter((event) => event.type === 'consult_answered')
        .map((event) =>
          event.type === 'consult_answered'
            ? { decisionCount: event.decisionCount, rejectedCount: event.rejectedCount }
            : null,
        ),
    ).toEqual([
      { decisionCount: 0, rejectedCount: 1 },
      { decisionCount: 1, rejectedCount: 0 },
    ]);
    const rows = transcriptRows(events);
    expect(rows).toContainEqual(
      expect.stringContaining(`PLAN rejected 1 decision for T001 · ${rejectReason}`),
    );
    expect(rows).toContainEqual(
      expect.stringContaining(`PLAN confirmed 1 decision for T001 · ${confirmReason}`),
    );
    expect(state.plan?.decisions).toEqual([
      { text: `${escaped.what} — ${escaped.why}`, taskId: 'T001' },
    ]);
  });
});
