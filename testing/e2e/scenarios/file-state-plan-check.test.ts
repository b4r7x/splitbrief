import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import {
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

describe('e2e: a plan that checks a file mode and a symbolic link', () => {
  it('runs test -x, test -L and test -f as plan checks with no test file', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const target = fixture;
    restorePath = activateSafeCliShimPath(target.tmpDir);
    writeFileSync(join(target.projectDir, 'README.md'), '# Readme\n');
    writeFileSync(join(target.projectDir, 'cli.js'), "console.log('cli');\n", { mode: 0o644 });
    execFileSync('git', ['add', 'README.md', 'cli.js'], { cwd: target.projectDir });
    execFileSync('git', ['commit', '--quiet', '-m', 'add the cli'], { cwd: target.projectDir });

    const callsPath = join(target.tmpDir, 'calls.jsonl');
    const plannerPath = join(target.tmpDir, 'planner.mjs');
    const implementerPath = join(target.tmpDir, 'implementer.mjs');
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
    const plan = makePlanProposal({
      summary: 'Make the CLI executable and link the readme into docs.',
      decisions: [],
      criteria: [
        { id: 'C1', text: 'cli.js is executable.', checkIds: ['K1'] },
        { id: 'C2', text: 'docs/readme.md links to the readme.', checkIds: ['K2', 'K3'] },
      ],
      tasks: [
        makeTaskSpec({
          id: 'T001',
          title: 'Make the CLI executable and link the readme',
          intent:
            'cli.js starts with a node shebang and is executable, and docs/readme.md links to ../README.md.',
          criteria: ['C1', 'C2'],
          suggestedFiles: ['cli.js', 'docs/readme.md'],
          checks: [
            { id: 'K1', kind: 'cmd', value: 'test -x cli.js', required: true },
            { id: 'K2', kind: 'cmd', value: 'test -L docs/readme.md', required: true },
            { id: 'K3', kind: 'cmd', value: 'test -f docs/readme.md', required: true },
          ],
        }),
      ],
    });
    const passing = passingVerdict({
      kind: 'final',
      taskIds: ['T001'],
      criterionIds: ['C1', 'C2'],
    });
    writeFileSync(
      plannerPath,
      `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let kind;
let answer;
if (prompt.includes('# Task Implementation Review')) {
  kind = 'task-review';
  answer = ${JSON.stringify(passing)};
} else if (prompt.includes('# Final Implementation Review')) {
  kind = 'final-review';
  answer = ${JSON.stringify(passing)};
} else if (prompt.includes("The plan failed SPLITBRIEF's checks")) {
  kind = 'plan-repair';
  answer = { result: null };
} else if (prompt.includes('# Plan the change')) {
  kind = 'plan';
  answer = ${JSON.stringify({ result: plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind }) + '\\n');
process.stdout.write(JSON.stringify(answer));
`,
    );
    writeFileSync(
      implementerPath,
      `import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
writeFileSync('cli.js', "#!/usr/bin/env node\\nconsole.log('cli');\\n");
chmodSync('cli.js', 0o755);
mkdirSync('docs', { recursive: true });
symlinkSync('../README.md', 'docs/readme.md');
console.log('Implemented T001');
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
      workflow: { ...config.workflow, review: 'task', approve: 'none' },
      validation: { ...config.validation, endChecks: false },
    });

    const run = await cli(target, ['start', 'make the cli executable and link the readme']);

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    const sessions = readdirSync(sessionsRoot(target.projectDir));
    expect(sessions).toHaveLength(1);
    const sessionId = sessions[0];
    if (sessionId === undefined) throw new Error('Missing session');
    const state = readState(target, sessionId);
    expect(state.phase).toBe('complete');
    expect(state.reviewStatus).toBe('passed');
    const calls = readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).kind);
    expect(calls).not.toContain('plan-repair');
    expect(state.tasks[0]?.checkResults).toEqual([
      { id: 'K1', status: 'pass' },
      { id: 'K2', status: 'pass' },
      { id: 'K3', status: 'pass' },
    ]);
    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    expect(
      events.find((event) => event.type === 'full_suite' && event.status === 'refused'),
    ).toBeUndefined();
    expect(statSync(join(target.projectDir, 'cli.js')).mode & 0o111).not.toBe(0);
    expect(lstatSync(join(target.projectDir, 'docs/readme.md')).isSymbolicLink()).toBe(true);
  });
});
