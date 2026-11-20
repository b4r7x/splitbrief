import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import {
  reviewPacketJsonPath,
  reviewPacketMarkdownPath,
  sessionsRoot,
} from '../../../src/core/paths.js';
import { ReviewPacketSchema } from '../../../src/core/schemas/review/packet.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { deriveRunStatus } from '../../../src/core/sessions/run/status.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import { spawnCli } from '../helpers/live-cli-harness.js';
import {
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const DISCLOSURE = 'SPLITBRIEF config declares hooks this machine has not trusted:';
const NO_TTY_REFUSAL =
  'Hook config is not trusted and no TTY available. Re-run with --allow-hooks to trust it (CI usage).';

const IMPLEMENTER_SCRIPT = `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`;

let fixture: Pick<StopContinueFixture, 'tmpDir'> | undefined;
let home: ReturnType<typeof createTrustHome> | undefined;

afterEach(() => {
  home?.restore();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  home = undefined;
});

/**
 * A project whose config declares a `pre_task` hook that writes a file, in a throwaway home
 * that holds no hook grant, so the hooks are new to this machine as in a fresh CI checkout.
 */
function hookedProject(): { target: StopContinueFixture; hookMark: string } {
  const target = createStopContinueFixture(() => IMPLEMENTER_SCRIPT, { isolation: 'none' });
  fixture = target;
  home = createTrustHome('e2e-headless-hook-trust-home');
  const hookMark = join(target.tmpDir, 'pre-task-ran');
  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, {
    ...config,
    hooks: {
      pre_task: [
        {
          kind: 'command',
          command: 'node',
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(hookMark)}, '')`],
          timeout_ms: 30_000,
          on_failure: 'block',
        },
      ],
    },
  });
  return { target, hookMark };
}

function builtCli(
  target: Pick<StopContinueFixture, 'projectDir' | 'stateHome'>,
  args: readonly string[],
): ReturnType<typeof spawnCli> {
  return spawnCli({
    args: ['dist/cli.js', ...args, '--allow-repo-runners', '--project', target.projectDir],
    stateHome: target.stateHome,
    timeoutMs: 90_000,
  });
}

function jsonEvents(stdout: string): Array<{ type: string; taskId?: string }> {
  return stdout
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; data?: { type: string; taskId?: string } })
    .flatMap((record) =>
      record.type === 'event' && record.data !== undefined ? [record.data] : [],
    );
}

describe('e2e: a headless start with workflow hooks this machine has not trusted', {
  timeout: 180_000,
}, () => {
  it('with --allow-hooks trusts the hooks, runs them and completes the brief', async () => {
    const { target, hookMark } = hookedProject();

    const start = await builtCli(target, ['start', 'smoke', '--json', '--allow-hooks']);

    expect(start.exitCode, `${start.stdout}\n${start.stderr}`).toBe(0);
    expect(start.stderr).toContain(DISCLOSURE);
    expect(start.stderr).not.toContain('blocked');
    expect(existsSync(hookMark)).toBe(true);
    expect(jsonEvents(start.stdout)).toContainEqual(
      expect.objectContaining({ type: 'task_completed', taskId: 'T001' }),
    );
  });

  it('without --allow-hooks and without a terminal refuses with the trust text and makes no run', async () => {
    const { target, hookMark } = hookedProject();

    const start = await builtCli(target, ['start', 'smoke', '--json']);

    expect(start.exitCode, `${start.stdout}\n${start.stderr}`).toBe(1);
    expect(start.stderr).toContain(NO_TTY_REFUSAL);
    expect(existsSync(hookMark)).toBe(false);
    expect(readActive(target.projectDir)).toBeNull();
    const sessions = sessionsRoot(target.projectDir);
    expect(existsSync(sessions) ? readdirSync(sessions) : []).toEqual([]);
  });

  it('lists the route when BUILD ran but a pre_validation hook skipped the brief', async () => {
    const { target, hookMark } = hookedProject();
    const config = loadConfig(target.projectDir).config;
    const denied = JSON.stringify({ decision: 'deny', message: 'validation gated' });
    writeConfig(target.projectDir, {
      ...config,
      hooks: {
        ...config.hooks,
        pre_validation: [
          {
            kind: 'command',
            command: 'node',
            args: ['-e', `console.log(${JSON.stringify(denied)})`],
            timeout_ms: 30_000,
            on_failure: 'block',
          },
        ],
      },
    });

    const start = await builtCli(target, ['start', 'smoke', '--json', '--allow-hooks']);

    expect(existsSync(hookMark)).toBe(true);
    expect(jsonEvents(start.stdout)).toContainEqual(
      expect.objectContaining({ type: 'task_skipped', taskId: 'T001' }),
    );
    const [sessionId] = readdirSync(sessionsRoot(target.projectDir));
    if (sessionId === undefined) throw new Error('Missing session');
    const ref = { projectDir: target.projectDir, sessionId };
    const packet = ReviewPacketSchema.parse(
      JSON.parse(readFileSync(reviewPacketJsonPath(ref), 'utf8')),
    );
    expect(packet.routing.taskRouting).toEqual([
      expect.objectContaining({
        taskId: 'T001',
        method: 'skipped',
        retryCount: 0,
        implementerProfile: 'default',
        routingReason: expect.stringContaining('Selected profile default'),
      }),
    ]);
    const markdown = readFileSync(reviewPacketMarkdownPath(ref), 'utf8');
    const routing = markdown.split('## Routing\n')[1]?.split('\n## ')[0];
    expect(routing).toMatch(/- T001: .* · default · Selected profile default/);
  });
});

const NOTES_FILE = 'notes.txt';
const NOTES_BASE = 'one\ntwo\nthree\nfour\nfive\n';
const NOTES_RUN = 'ONE\ntwo\nthree\nfour\nfive\n';
const NOTES_CHECKOUT = 'one\ntwo\nthree\nfour\nFIVE\n';

/**
 * A worktree run that changed the first line of the notes and is ready to apply, then a checkout
 * that changed their last line and a config that gained a hook this machine has not trusted.
 */
async function readyRunWithNewHook(): Promise<{
  target: Pick<StopContinueFixture, 'projectDir' | 'stateHome'>;
  sessionId: string;
  hookMark: string;
}> {
  const tmpDir = createTempDir('e2e-headless-hook-trust-apply');
  fixture = { tmpDir };
  home = createTrustHome('e2e-headless-hook-trust-apply-home');
  const target = { projectDir: join(tmpDir, 'project'), stateHome: join(tmpDir, 'state') };
  const plan = makePlanProposal({
    summary: 'Capitalize the first note',
    tasks: [
      makeTaskSpec({
        title: 'Capitalize the first note',
        intent: 'Write the first line of the notes in capitals.',
        suggestedFiles: [NOTES_FILE],
        checks: [{ id: 'K1', kind: 'cmd', value: 'node --version' }],
      }),
    ],
  });
  const review = passingVerdict({
    kind: 'final',
    taskIds: plan.tasks.map((task) => task.id),
    criterionIds: plan.criteria.map((criterion) => criterion.id),
  });
  createTestGitRepo(target.projectDir, {
    [NOTES_FILE]: NOTES_BASE,
    'tools/planner.mjs': `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
process.stdout.write(JSON.stringify(prompt.includes('# Final Implementation Review')
  ? ${JSON.stringify(review)} : ${JSON.stringify({ result: plan })}));
`,
    'tools/implementer.mjs': `import { writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
writeFileSync(${JSON.stringify(NOTES_FILE)}, ${JSON.stringify(NOTES_RUN)});
`,
  });
  mkdirSync(target.stateHome);
  const config = makeConfig({
    planner: {
      kind: 'shell',
      command: 'node',
      args: ['./tools/planner.mjs'],
      outputFormat: 'text',
    },
    implementer: {
      kind: 'agent',
      command: 'node',
      args: ['./tools/implementer.mjs'],
      outputFormat: 'text',
      model: 'fixture',
      contextLength: 200_000,
    },
    workflow: { approve: 'none', isolation: 'worktree' },
    validation: { endChecks: false },
  });
  writeConfig(target.projectDir, config);

  const start = await builtCli(target, ['start', 'Capitalize the first note', '--plain']);
  expect(start.exitCode, `${start.stdout}\n${start.stderr}`).toBe(0);
  const sessionId = readActive(target.projectDir);
  if (sessionId === null) throw new Error('the run has no active session');
  expect(runSide(target, sessionId)).toEqual({ status: 'ready-to-apply', phase: 'complete' });

  writeFileSync(join(target.projectDir, NOTES_FILE), NOTES_CHECKOUT);
  const hookMark = join(tmpDir, 'post-validation-ran');
  writeConfig(target.projectDir, {
    ...config,
    hooks: {
      post_validation: [
        {
          kind: 'command',
          command: 'node',
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(hookMark)}, '')`],
          timeout_ms: 30_000,
          on_failure: 'block',
        },
      ],
    },
  });
  return { target, sessionId, hookMark };
}

function runSide(
  target: Pick<StopContinueFixture, 'projectDir'>,
  sessionId: string,
): { status: string; phase: string } | undefined {
  const state = loadState({ projectDir: target.projectDir, sessionId });
  if (state === null) return undefined;
  return {
    status: deriveRunStatus({ state, liveness: 'not-alive', reviewNone: false }).kind,
    phase: state.phase,
  };
}

describe('e2e: a headless Apply with workflow hooks this machine has not trusted', {
  timeout: 240_000,
}, () => {
  it('refuses before Apply writes, so the same command with --allow-hooks carries the run into its checks and review', async () => {
    const { target, sessionId, hookMark } = await readyRunWithNewHook();
    const apply = ['continue', sessionId, '--action', 'apply', '--json'];

    const refused = await builtCli(target, apply);

    expect(refused.exitCode, `${refused.stdout}\n${refused.stderr}`).toBe(1);
    expect(refused.stderr).toContain(NO_TTY_REFUSAL);
    expect(runSide(target, sessionId)).toEqual({ status: 'ready-to-apply', phase: 'complete' });
    expect(readFileSync(join(target.projectDir, NOTES_FILE), 'utf8')).toBe(NOTES_CHECKOUT);
    expect(existsSync(hookMark)).toBe(false);

    const trusted = await builtCli(target, [...apply, '--allow-hooks']);

    expect(trusted.exitCode, `${trusted.stdout}\n${trusted.stderr}`).toBe(0);
    expect(trusted.stderr).toContain(DISCLOSURE);
    expect(trusted.stderr).toContain('the merged result goes through its checks and review again.');
    expect(trusted.stderr).not.toContain('is not ready to apply');
    expect(existsSync(hookMark)).toBe(true);
    expect(runSide(target, sessionId)).toEqual({ status: 'ready-to-apply', phase: 'complete' });
    expect(readFileSync(join(target.projectDir, NOTES_FILE), 'utf8')).toBe(NOTES_CHECKOUT);
  });
});
