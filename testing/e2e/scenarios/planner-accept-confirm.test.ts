import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { createStopContinueFixture } from '../helpers/stop-continue-fixture.js';

const VIEWPORT = { cols: 120, rows: 40 };

const TOTAL_FILE = 'src/total.mjs';
const TOTAL_TEST_FILE = 'src/total.test.mjs';
const TOTAL_SOURCE = 'export const total = (a, b) => a + b;\n';
const TOTAL_TEST_SOURCE = `import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { total } from './total.mjs';

test('total adds two numbers', () => {
  assert.equal(total(1, 2), 3);
});
`;
const NOTE = 'Kept as designed.';

const brief = makeTaskSpec({
  id: 'T001',
  title: 'Add the total helper',
  intent: 'Return the sum of two numbers.',
  criteria: ['C1'],
  suggestedFiles: [TOTAL_FILE, TOTAL_TEST_FILE],
  checks: [{ id: 'T001-K1', kind: 'test', value: TOTAL_TEST_FILE, required: true }],
});
const repair = makeTaskSpec({
  id: 'T002',
  title: 'Repair total',
  intent: 'Answer the open findings on total.',
  criteria: ['C1'],
  suggestedFiles: [TOTAL_FILE],
  checks: [{ id: 'T002-K1', kind: 'test', value: TOTAL_TEST_FILE, required: true }],
});
const plan = makePlanProposal({
  summary: 'Add a total helper with its test.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'total returns the sum.', checkIds: ['T001-K1'] }],
  tasks: [brief],
});
const FINDINGS = Array.from({ length: 8 }, (_, index) => `Open finding ${index + 1} needs a fix`);
const findings = FINDINGS.map((text, index) => ({
  id: `F${index + 1}`,
  kind: 'defect',
  severity: 'blocking',
  taskId: brief.id,
  criterionId: null,
  file: TOTAL_FILE,
  line: null,
  text,
  acceptance: null,
  checkIds: null,
}));

/**
 * Every final review blocks on the same 8 findings. The second finds that the fix cycle moved
 * nothing and asks the planner, which accepts the change as is with a note.
 */
function plannerScript(callsPath: string): string {
  return `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const ids = (label) => {
  const value = prompt.match(new RegExp('^' + label + ' (.+)$', 'm'))?.[1].trim();
  if (value === undefined) throw new Error('Missing ids: ' + label);
  return value === 'none' ? [] : value.split(',').map((id) => id.trim());
};
let kind;
let answer;
if (prompt.includes('# Final Implementation Review')) {
  kind = 'final-review';
  const findings = ${JSON.stringify(findings)};
  answer = {
    ...${JSON.stringify(passingVerdict({ kind: 'final', taskIds: [], criterionIds: [] }))},
    tasks: ids('Task ids:').map((id) => ({ id, plan: 'met', note: '' })),
    criteria: ids('Criterion ids:').map((id) => ({ id, status: 'pass', evidence: '' })),
    findings,
    fixTasks: [{ ...${JSON.stringify(repair)}, findingIds: findings.map((finding) => finding.id) }],
  };
} else if (/^# Consult on a failing task$/m.test(prompt)) {
  kind = 'consult';
  answer = { answer: { diagnosis: 'The findings ask for a design the plan does not take.', action: 'accept', note: ${JSON.stringify(NOTE)} } };
} else if (prompt.includes('# Plan the change')) {
  kind = 'plan';
  answer = ${JSON.stringify({ result: plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
appendFileSync(${JSON.stringify(callsPath)}, kind + '\\n');
process.stdout.write(JSON.stringify(answer));
`;
}

/** Each repair writes a new line, so no fix brief ends without a change. */
function implementerScript(callsPath: string): string {
  return `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const title = prompt.match(/^## Task: (.+)$/m)?.[1];
const builds = readFileSync(${JSON.stringify(callsPath)}, 'utf8').split('\\n').filter((line) => line.startsWith('implement')).length;
const files = {
  ${JSON.stringify(brief.title)}: { ${JSON.stringify(TOTAL_FILE)}: ${JSON.stringify(TOTAL_SOURCE)}, ${JSON.stringify(TOTAL_TEST_FILE)}: ${JSON.stringify(TOTAL_TEST_SOURCE)} },
  ${JSON.stringify(repair.title)}: { ${JSON.stringify(TOTAL_FILE)}: ${JSON.stringify(TOTAL_SOURCE)} + '// repair ' + builds + '\\n' },
}[title];
if (!files) throw new Error('Unexpected brief: ' + prompt);
appendFileSync(${JSON.stringify(callsPath)}, 'implement ' + title + '\\n');
mkdirSync('src', { recursive: true });
for (const [file, source] of Object.entries(files)) writeFileSync(file, source);
console.log('Implemented ' + title);
`;
}

it('confirms a planner-accepted Apply with the note above every open finding', {
  timeout: 300_000,
}, async () => {
  const target = createStopContinueFixture(() => '');
  const trustHome = useTrustHome('planner-accept-confirm');
  const callsPath = join(target.tmpDir, 'calls.txt');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  writeFileSync(callsPath, '');
  writeFileSync(plannerPath, plannerScript(callsPath));
  writeFileSync(implementerPath, implementerScript(callsPath));
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
    throw new Error('Expected local shell and agent fixture runners');
  }
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: { ...config.implementer, args: [implementerPath] },
    workflow: { ...config.workflow, approve: 'none' },
    validation: { ...config.validation, endChecks: false, testCommand: 'node --test' },
  });
  let confirm: string[] = [];
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
          'total',
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
          await expect.poll(screen, { timeout: 120_000 }).toContain('Ready to apply as is');
          // The mark shows only while the menu holds the keyboard.
          await expect.poll(screen).toContain('▌ Apply as is');
          child.write('\r');
          await expect.poll(screen).toContain('Apply with 8 open findings?');
          confirm = screen().split('\n');
          child.write('\x1b[B');
          await expect.poll(screen).toContain('▌ Back');
          child.write('\r');
          await expect.poll(screen).toContain('Ready to apply as is · 8 open findings');
          const menu = screen();
          expect(menu).toContain('Show diff · open the run’s changes as a patch');
          expect(menu).toContain('Discard · close the run; save its changes in run.patch');
          expect(menu).not.toContain('Apply with 8 open findings?');
          expect(menu).not.toContain("Planner's note");
          expect(menu).not.toContain('- Open finding 1 needs a fix');
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
    expect(readFileSync(callsPath, 'utf8').split('\n').filter(Boolean)).toEqual([
      'plan',
      `implement ${brief.title}`,
      'final-review',
      `implement ${repair.title}`,
      'final-review',
      'consult',
    ]);
    const title = confirm.findIndex((row) => row.includes('Apply with 8 open findings?'));
    expect(title, confirm.join('\n')).toBeGreaterThan(-1);
    expect(confirm[title + 1]).toContain(`Planner's note: ${NOTE}`);
    for (const [index, finding] of FINDINGS.entries()) {
      expect(confirm[title + 2 + index]).toContain(`- ${finding}`);
    }
    expect(confirm.join('\n')).not.toContain('more open finding');
    expect(confirm.join('\n')).toContain('Ready to apply as is · pick Apply as is or Back');
    expect(confirm.join('\n')).not.toContain('Show diff or Discard');
  } finally {
    trustHome.restore();
    cleanupTempDir(target.tmpDir);
  }
});
