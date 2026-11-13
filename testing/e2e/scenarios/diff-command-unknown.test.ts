import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { PTY_SUBMIT_INPUT } from '../../integration/cli/pty/contract.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { createStopContinueFixture } from '../helpers/stop-continue-fixture.js';

const VIEWPORT = { cols: 120, rows: 40 };
const PAINT = { timeout: 15_000 };
const RUN = { timeout: 120_000 };

const TOTAL_FILE = 'src/total.mjs';
const TOTAL_TEST_FILE = 'src/total.test.mjs';
const brief = makeTaskSpec({
  id: 'T001',
  title: 'Add the total helper',
  intent: 'Return the sum of two numbers.',
  criteria: ['C1'],
  suggestedFiles: [TOTAL_FILE, TOTAL_TEST_FILE],
  checks: [{ id: 'T001-K1', kind: 'test', value: TOTAL_TEST_FILE }],
});
const plan = makePlanProposal({
  summary: 'Add a total helper with its test.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'total returns the sum.', checkIds: ['T001-K1'] }],
  tasks: [brief],
});

/** Answers the plan, then holds the final review open until the test ends the CLI. */
function plannerScript(reviewCalls: string): string {
  return `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
if (prompt.includes('# Plan the change')) {
  process.stdout.write(JSON.stringify(${JSON.stringify({ result: plan })}));
} else {
  if (!prompt.includes('# Final Implementation Review')) throw new Error('Unexpected prompt: ' + prompt);
  appendFileSync(${JSON.stringify(reviewCalls)}, 'final-review\\n');
  await new Promise((resolve) => setTimeout(resolve, 120000));
  process.exit(143);
}
`;
}

/** Writes the two files of the brief itself, as a tool that edits the checkout does. */
function implementerScript(): string {
  return `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(TOTAL_FILE)}, 'export const total = (a, b) => a + b;\\n');
writeFileSync(${JSON.stringify(TOTAL_TEST_FILE)}, "import { strict as assert } from 'node:assert';\\nimport { test } from 'node:test';\\nimport { total } from './total.mjs';\\ntest('total adds', () => assert.equal(total(1, 2), 3));\\n");
console.log('Implemented');
`;
}

describe('e2e: /diff after a brief that changed files', {
  timeout: 180_000,
}, () => {
  let trustHome: ReturnType<typeof useTrustHome>;

  beforeEach(() => {
    trustHome = useTrustHome('diff-command-unknown');
  });

  afterEach(() => {
    trustHome.restore();
  });

  it('lists no /diff for a /di draft and answers a typed /diff as an unknown command', async () => {
    const target = createStopContinueFixture(() => '', { isolation: 'none' });
    try {
      const reviewCalls = join(target.tmpDir, 'review-calls.txt');
      const plannerPath = join(target.tmpDir, 'planner.mjs');
      const implementerPath = join(target.tmpDir, 'implementer.mjs');
      const offlinePath = join(target.tmpDir, 'offline.mjs');
      writeFileSync(reviewCalls, '');
      writeFileSync(plannerPath, plannerScript(reviewCalls));
      writeFileSync(implementerPath, implementerScript());
      writeFileSync(
        offlinePath,
        "globalThis.fetch = async () => { throw new Error('offline'); };\n",
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
        validation: { ...config.validation, testCommand: 'node --test' },
      });
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
            '--import',
            offlinePath,
            'src/cli.ts',
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
            await expect.poll(screen, RUN).toContain('Describe your feature');
            child.write('add a total helper');
            await expect.poll(screen, PAINT).toContain('› add a total helper');
            child.write(PTY_SUBMIT_INPUT);
            await vi.waitFor(
              () => expect(readFileSync(reviewCalls, 'utf8')).toContain('final-review'),
              RUN,
            );
            await expect.poll(screen, PAINT).toContain(TOTAL_FILE);

            child.write('/di');
            await expect.poll(screen, PAINT).toContain('› /di');
            await expect.poll(screen, PAINT).toContain('↑↓ select');
            expect(
              screen()
                .split('\n')
                .filter((line) => line.includes('/diff')),
            ).toEqual([]);

            child.write('ff');
            await expect.poll(screen, PAINT).toContain('› /diff');
            child.write(PTY_SUBMIT_INPUT);
            await expect
              .poll(screen, PAINT)
              .toContain('Unknown command: /diff. Type /help for available commands.');
          } finally {
            if (outcome === undefined) await terminatePtyProcessGroup(child, exit.promise);
            await reapOrphanRunners(target.projectDir);
            dataListener.dispose();
            exitListener.dispose();
            terminal.dispose();
          }
        },
      );
    } finally {
      cleanupTempDir(target.tmpDir);
    }
  });
});
