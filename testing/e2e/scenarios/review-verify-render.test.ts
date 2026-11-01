import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import XtermHeadless from '@xterm/headless';
import { expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  PLAN_ANSWER,
} from '../helpers/stop-continue-fixture.js';

const VIEWPORT = { cols: 120, rows: 40 };
const QUESTION = 'Keep the lowercase greeting?';
const ANSWER = 'KEEP_LOWERCASE';

/** The text of the `## Renders` section; the Checks Log of the same prompt lists every run. */
function rendersOf(prompt: string): string {
  return prompt.slice(prompt.indexOf('## Renders'), prompt.indexOf('## Instructions'));
}

it('hands the review after a reviewer question the render its verify ran', async () => {
  const target = createStopContinueFixture(
    () => `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
`,
    { isolation: 'none' },
  );
  // Each render writes under .test-artifacts/; unignored, it would change the candidate.
  writeFileSync(join(target.projectDir, '.git', 'info', 'exclude'), '.test-artifacts/\n');
  const trustHome = useTrustHome('review-verify-render');
  const planner = join(target.tmpDir, 'planner.mjs');
  const render = join(target.tmpDir, 'render.mjs');
  const renders = join(target.tmpDir, 'renders.txt');
  const reviewer = join(target.tmpDir, 'reviewer.mjs');
  const calls = join(target.tmpDir, 'review-prompts.jsonl');
  const [task] = PLAN_ANSWER.result.tasks;
  if (task === undefined) throw new Error('the fixture plan has no task');
  const plan = {
    result: {
      ...PLAN_ANSWER.result,
      tasks: [
        {
          ...task,
          checks: [
            ...task.checks,
            { id: 'T001-R1', kind: 'render', value: 'greet-card', required: true },
          ],
        },
      ],
    },
  };
  const verdict = passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] });
  const unverified = {
    id: 'F1',
    kind: 'unverified',
    severity: 'minor',
    taskId: 'T001',
    file: null,
    line: null,
    text: 'Render greet-card again to confirm the card.',
    acceptance: null,
    checkIds: ['T001-R1'],
    criterionId: null,
  };
  writeFileSync(
    planner,
    `for await (const chunk of process.stdin) void chunk;
process.stdout.write(${JSON.stringify(JSON.stringify(plan))});
`,
  );
  // Each call writes its PNG under run-<call number>, so a prompt names the run it shows.
  writeFileSync(
    render,
    `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [, , id, out] = process.argv;
const log = ${JSON.stringify(renders)};
const run = (existsSync(log) ? readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0) + 1;
appendFileSync(log, id + '\\n');
mkdirSync(join(out, 'run-' + run), { recursive: true });
writeFileSync(join(out, 'run-' + run, 'frame.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
`,
  );
  writeFileSync(
    reviewer,
    `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ prompt }) + '\\n');
if (!prompt.includes(${JSON.stringify(ANSWER)})) {
  console.log(${JSON.stringify(JSON.stringify({ ...verdict, findings: [unverified], ask: { question: QUESTION, whyOnlyUserCanAnswer: 'The user chooses the casing.' } }))});
} else {
  console.log(${JSON.stringify(JSON.stringify({ ...verdict, rejected: [{ findingId: 'A1', reason: 'The answer keeps the greeting as built.' }] }))});
}
`,
  );
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell') throw new Error('Expected the fixture shell planner');
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [planner] },
    validation: { ...config.validation, render: `node ${render} {id} {out}` },
    reviewer: { kind: 'shell', command: process.execPath, args: [reviewer], outputFormat: 'text' },
  });
  try {
    const env: Readonly<Record<string, string>> = {
      ...safeChildEnvironment(trustHome.home),
      XDG_STATE_HOME: target.stateHome,
    };
    await trustDeclaredRunners({
      projectDir: target.projectDir,
      config: loadConfig(target.projectDir).config,
      pathEnv: env.PATH ?? '',
    });
    await runWithPtyChild(
      {
        requirement: 'required',
        argv: [
          '--import',
          'tsx',
          'src/cli.ts',
          'start',
          'smoke',
          '--allow-repo-runners',
          '--project',
          target.projectDir,
        ],
        spawnOptions: {
          name: 'xterm-256color',
          ...VIEWPORT,
          cwd: resolve(import.meta.dirname, '../../..'),
          env,
        },
      },
      async (child) => {
        const exit = Promise.withResolvers<PtyExitEvent>();
        let outcome: PtyExitEvent | undefined;
        const terminal = new XtermHeadless.Terminal({
          ...VIEWPORT,
          allowProposedApi: true,
          convertEol: true,
          scrollback: 0,
          logLevel: 'off',
        });
        const screen = () =>
          Array.from(
            { length: VIEWPORT.rows },
            (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '',
          ).join('\n');
        const dataListener = child.onData((data) => terminal.write(data));
        const exitListener = child.onExit((event) => {
          outcome = event;
          exit.resolve(event);
        });
        try {
          await expect.poll(screen, { timeout: 45_000 }).toContain(QUESTION);
          await delay(PROMPT_TYPEAHEAD_GRACE_MS * 2);
          child.write(ANSWER);
          await expect.poll(screen).toContain(ANSWER);
          child.write('\r');
          await expect.poll(screen, { timeout: 45_000 }).toContain('Final review re-run passed');
          expect(screen().match(/Render greet-card · rendered/g)).toHaveLength(2);
          child.write('\x11');
          await expect.poll(() => outcome, { timeout: 10_000 }).toBeDefined();
          expect(outcome?.exitCode, screen()).toBe(0);
        } finally {
          if (outcome === undefined) await terminatePtyProcessGroup(child, exit.promise);
          await reapOrphanRunners(target.projectDir);
          dataListener.dispose();
          exitListener.dispose();
          terminal.dispose();
        }
      },
    );
    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('CLI started without a run');
    // The pre-review renders once and the verify once; the review after the answer runs no pre-review.
    expect(readFileSync(renders, 'utf8')).toBe('greet-card\ngreet-card\n');
    const prompts = readFileSync(calls, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => (JSON.parse(line) as { prompt: string }).prompt);
    expect(prompts).toHaveLength(2);
    const [asked = '', answered = ''] = prompts;
    const first = join('run-1', 'frame.png');
    const verified = join('run-2', 'frame.png');
    expect(rendersOf(asked)).toContain('greet-card → ');
    expect(rendersOf(asked)).toContain(first);
    expect(rendersOf(answered)).toContain(verified);
    expect(rendersOf(answered)).not.toContain(first);
    expect(asked).not.toMatch(/^- T001-R1 \(exit 0\): /m);
    expect(answered).toMatch(/^- T001-R1 \(exit 0\): /m);
    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    expect(
      events.flatMap((event) =>
        event.type === 'full_suite' && event.id === 'T001-R1' && event.status === 'running'
          ? [event.moment]
          : [],
      ),
    ).toEqual(['plan', 'verify']);
  } finally {
    trustHome.restore();
    cleanupTempDir(target.tmpDir);
  }
});
