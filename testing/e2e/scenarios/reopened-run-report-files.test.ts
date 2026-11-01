import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { SESSION_LOG_FILE, sessionsRoot } from '../../../src/core/paths.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import type { renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { openHaltedRun } from '../helpers/halted-run-screen.js';
import {
  cli,
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const SUMMARY_FILE = 'src/summary.mjs';
const REPORT_FILE = 'src/report.mjs';
const report = makeTaskSpec({
  id: 'T001',
  title: 'Add the report helper',
  intent: 'Return a report line.',
  criteria: ['C1'],
  suggestedFiles: [SUMMARY_FILE, REPORT_FILE],
  checks: [{ id: 'T001-K1', kind: 'cmd', value: 'node --version', required: true }],
});
const plan = makePlanProposal({
  summary: 'Add one report helper.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'report returns a line.', checkIds: ['T001-K1'] }],
  tasks: [report],
});

let fixture: StopContinueFixture | undefined;
let ui: ReturnType<typeof renderFeature> | undefined;
let restorePath: (() => void) | undefined;

beforeEach(() => resetAllStores());

afterEach(() => {
  ui?.unmount();
  ui = undefined;
  resetAllStores();
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

/**
 * A run whose implementer writes only the brief's second file and reports it in a done report
 * whose `touchedNotSuggested` is a string, not a list. The planner crashes on the final review,
 * so the run halts after the brief is done.
 */
async function haltAfterBadFieldReport() {
  fixture = createStopContinueFixture(() => '');
  const target = fixture;
  restorePath = activateSafeCliShimPath(target.tmpDir);
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  writeFileSync(
    plannerPath,
    `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
if (prompt.includes('# Final Implementation Review')) {
  process.stderr.write('The planner process crashed.\\n');
  process.exit(1);
}
if (!prompt.includes('# Plan the change')) throw new Error('Unexpected prompt: ' + prompt);
process.stdout.write(${JSON.stringify(JSON.stringify({ result: plan }))});
`,
  );
  writeFileSync(
    implementerPath,
    `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const _chunk of process.stdin);
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(REPORT_FILE)}, "export const report = () => 'ok';\\n");
console.log(JSON.stringify({ status: 'done', filesChanged: [${JSON.stringify(REPORT_FILE)}], touchedNotSuggested: 'none', notes: null, decisions: [] }));
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
    workflow: { ...config.workflow, approve: 'none' },
  });
  const halted = await cli(target, ['start', 'smoke']);
  expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
  const [sessionId] = readdirSync(sessionsRoot(target.projectDir));
  if (sessionId === undefined) throw new Error('Missing session');
  return { target, logPath: join(sessionsRoot(target.projectDir), sessionId, SESSION_LOG_FILE) };
}

/**
 * Removes `files` from every done event of the saved log, the form a log from a version that
 * saved no files has. Returns how many events it changed.
 */
function dropDoneFiles(logPath: string): number {
  let changed = 0;
  const lines = readFileSync(logPath, 'utf8')
    .split('\n')
    .map((line) => {
      if (line === '') return line;
      const entry = JSON.parse(line);
      if (entry.type !== 'implementer_generate_done' || entry.data?.files === undefined) {
        return line;
      }
      changed += 1;
      const { files: _files, ...data } = entry.data;
      return JSON.stringify({ ...entry, data });
    });
  writeFileSync(logPath, lines.join('\n'));
  return changed;
}

describe('e2e: a reopened run shows the files of a done report', () => {
  it('names the file a done report with one bad field lists, in a log that saved no files', async () => {
    const { target, logPath } = await haltAfterBadFieldReport();
    expect(dropDoneFiles(logPath)).toBe(1);

    const opened = await openHaltedRun(target, { heading: 'Final review reached no verdict' });
    ui = opened.screen;

    const frame = stripAnsiStyles(opened.screen.lastFrame());
    expect(frame).toMatch(/^ +src\/report\.mjs$/m);
    expect(frame).toContain(
      'the implementer report did not match its contract in touchedNotSuggested',
    );
  });
});
