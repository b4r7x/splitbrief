import { describe, expect, it } from 'vitest';
import { taskId } from '../../../../core/schemas/task.js';
import { type ReviewPacket, ReviewPacketSchema } from '../../../../core/schemas/review-packet.js';
import { makeReviewPacket } from '#testing/helpers/factories/review-packet.js';
import { renderChecksLogForPrompt, renderReviewPacketMarkdown } from './render.js';
import { NULL_CACHE } from '../../../providers/model/resolution.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';

const EVIDENCE_PATH = '/project/.splitbrief/sessions/sess/evidence.json';
const SESSION_LOG_PATH = '/project/.splitbrief/sessions/sess/session.jsonl';
const EVIDENCE_PATHS = { validation: EVIDENCE_PATH, sessionLog: SESSION_LOG_PATH };

describe('renderReviewPacketMarkdown review seat', () => {
  it('uses catalog names for every recorded seat and a switched seat', () => {
    const packet = makeReviewPacket();
    const seat = { tool: 'codex', model: 'gpt-6-luna', kind: 'cli', axes: ['high'] } as const;
    const rendered = renderReviewPacketMarkdown(
      {
        ...packet,
        run: {
          ...packet.run,
          planner: { ...seat, axes: [...seat.axes] },
          implementer: { ...seat, axes: [...seat.axes] },
          reviewer: { ...seat, axes: [...seat.axes] },
        },
        recoveryDecisions: {
          ...packet.recoveryDecisions,
          events: [
            {
              type: 'seat_switched',
              ts: '2026-10-15T00:00:00Z',
              seat: 'build',
              from: { tool: 'codex', model: 'gpt-6-luna', effort: 'low' },
              to: { tool: 'codex', model: 'gpt-6-luna', effort: 'high' },
              cause: 'runner-usage-limit',
              auto: false,
            },
          ],
        },
      },
      makeModelCacheAccessor({
        providerModels: { codex: [{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna' }] },
      }),
    );
    for (const role of ['Planner', 'Implementer', 'Reviewer']) {
      expect(rendered).toContain(`- ${role}: OpenAI Codex CLI · GPT-6-Luna · high`);
    }
    expect(rendered).toContain(
      'OpenAI Codex CLI · GPT-6-Luna · low → OpenAI Codex CLI · GPT-6-Luna · high',
    );
    expect(rendered).not.toContain('GPT-6 Luna');
  });

  it('lists the task tally without a local count', () => {
    const packet = makeReviewPacket();
    const rendered = renderReviewPacketMarkdown(
      {
        ...packet,
        run: { ...packet.run, totalTasks: 7, escalated: 2, skipped: 1, failed: 1 },
      },
      NULL_CACHE,
    );

    const tally = rendered.split('\n').find((line) => line.startsWith('- Tasks:'));
    expect(tally).toBe('- Tasks: 7 total, 2 escalated, 1 skipped, 1 failed');
  });

  it('heads the verdict with the review seat and names the runner that held it', () => {
    const packet = makeReviewPacket();
    const rendered = renderReviewPacketMarkdown(
      {
        ...packet,
        run: {
          ...packet.run,
          planner: { tool: 'claude-code', model: 'sonnet' },
          reviewer: { tool: 'codex', model: 'gpt-5' },
        },
      },
      NULL_CACHE,
    );

    expect(rendered).toContain('## Reviewer Final Review');
    expect(rendered).toContain('- Reviewer: OpenAI Codex CLI · GPT-5');
    expect(rendered.toLowerCase()).not.toContain('planner final review');
  });

  it('reads packets written before the reviewer was recorded and shows its absence', () => {
    const packet = makeReviewPacket();
    const saved = ReviewPacketSchema.parse({
      ...packet,
      run: { ...packet.run, reviewer: undefined },
    });

    expect(saved.run.reviewer).toBeUndefined();
    expect(renderReviewPacketMarkdown(saved, NULL_CACHE)).toContain('- Reviewer: n/a\n');
  });
});

describe('packet switch and admission evidence', () => {
  it('keeps tool-default candidates without a model word on both sides of a switch', () => {
    const packet = makeReviewPacket();
    const rendered = renderReviewPacketMarkdown(
      {
        ...packet,
        recoveryDecisions: {
          ...packet.recoveryDecisions,
          events: [
            {
              type: 'seat_switched',
              ts: '2026-10-15T00:00:00Z',
              seat: 'build',
              from: { tool: 'codex' },
              to: { tool: 'claude-code' },
              cause: 'runner-usage-limit',
              auto: false,
            },
          ],
        },
      },
      NULL_CACHE,
    );
    expect(rendered).toContain('OpenAI Codex CLI → Claude Code CLI; usage limit');
  });

  it('renders the switch, recorded seat axes, and admission scope', () => {
    const packet = makeReviewPacket();
    const rendered = renderReviewPacketMarkdown(
      ReviewPacketSchema.parse({
        ...packet,
        run: {
          ...packet.run,
          planner: { tool: 'codex', model: 'gpt-5', kind: 'cli', axes: ['xhigh'] },
          implementer: {
            tool: 'opencode',
            model: 'opencode-go/deepseek-v4.1-flash',
            kind: 'cli',
            axes: ['high'],
          },
          reviewer: { tool: 'codex', model: 'gpt-5', kind: 'cli', axes: ['high'] },
        },
        readiness: {
          ...packet.readiness,
          present: true,
          generatedAt: '2026-10-10T12:56:00.000Z',
          checks: [
            {
              id: 'implementer',
              severity: 'warning',
              summary:
                'Default implementer opencode (deepseek/deepseek-flash) can execute commands on this machine.',
            },
          ],
        },
        recoveryDecisions: {
          ...packet.recoveryDecisions,
          events: [
            {
              ts: '2026-10-10T12:57:12.126Z',
              type: 'seat_switched',
              seat: 'build',
              from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
              to: { tool: 'codex', model: 'gpt-5', effort: 'high' },
              cause: 'runner-usage-limit',
              accountCause: 'balance',
              headline: 'Balance spent on OpenCode CLI',
              auto: true,
              configRevision: 'revision',
            },
          ],
          outcomes: [
            {
              issueId: 'rec_balance',
              action: 'switch-seat',
              status: 'retry-current-task',
              message: 'Balance spent on OpenCode CLI',
            },
          ],
        },
      }),
      NULL_CACHE,
    );

    expect(rendered).toContain('- Planner: OpenAI Codex CLI · GPT-5 · xhigh');
    expect(rendered).toContain(
      '- BUILD switched automatically: OpenCode CLI · DeepSeek V4.1 Flash · via deepseek → OpenAI Codex CLI · GPT-5 · high; Balance spent on OpenCode CLI',
    );
    expect(rendered).toContain(
      '- Implementer: OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go · high',
    );
    expect(rendered).toContain('- Reviewer: OpenAI Codex CLI · GPT-5 · high');
    expect(rendered).toContain('## Admission readiness');
    expect(rendered).toContain(
      '- Scope: Recorded at admission; later seat switches are listed under Recovery Decisions.',
    );
    expect(rendered).toContain('- Captured: 2026-10-10T12:56:00.000Z');
    expect(rendered).toContain(
      '- retry-current-task via switch-seat (rec_balance): Balance spent on OpenCode CLI',
    );
    expect(rendered).toContain(
      'Default implementer opencode (deepseek/deepseek-flash) can execute commands on this machine.',
    );
  });

  it('preserves Cursor model-ID axes on both sides of an axis-only switch', () => {
    const packet = makeReviewPacket();
    const rendered = renderReviewPacketMarkdown(
      {
        ...packet,
        recoveryDecisions: {
          ...packet.recoveryDecisions,
          events: [
            {
              type: 'seat_switched',
              ts: '2026-10-10T12:57:12.126Z',
              seat: 'build',
              from: { tool: 'cursor', model: 'claude-opus-5-thinking' },
              to: { tool: 'cursor', model: 'claude-opus-5-thinking-high-fast' },
              cause: 'runner-usage-limit',
              accountCause: 'balance',
              headline: 'Balance spent on Cursor Agent CLI',
              auto: true,
            },
          ],
        },
      },
      NULL_CACHE,
    );

    expect(rendered).toContain(
      '- BUILD switched automatically: Cursor Agent CLI · Claude Opus 5 · thinking → Cursor Agent CLI · Claude Opus 5 · high · thinking · fast; Balance spent on Cursor Agent CLI',
    );
  });

  it('renders a manual legacy switch from state labels without inventing a cause', () => {
    const packet = makeReviewPacket();
    const rendered = renderReviewPacketMarkdown(
      {
        ...packet,
        recoveryDecisions: {
          ...packet.recoveryDecisions,
          events: [
            {
              type: 'seat_switched',
              ts: '2026-10-10T12:57:12.126Z',
              seat: 'plan',
              from: 'old recorded seat',
              to: 'new recorded seat',
              cause: 'runner-usage-limit',
              auto: false,
            },
          ],
        },
      },
      NULL_CACHE,
    );

    expect(rendered).toContain(
      '- PLAN switched manually: old recorded seat → new recorded seat; usage limit',
    );
    expect(rendered).not.toContain('Balance spent');
    expect(rendered).not.toContain('- No recovery decisions recorded.');
  });
});

describe('renderReviewPacketMarkdown admission readiness checks', () => {
  function renderReadiness(readiness: Partial<ReviewPacket['readiness']>): string {
    const packet = makeReviewPacket();
    return renderReviewPacketMarkdown(
      { ...packet, readiness: { ...packet.readiness, ...readiness } },
      NULL_CACHE,
    );
  }

  it('reads a clean readiness record as no warnings or blockers', () => {
    const rendered = renderReadiness({
      present: true,
      status: 'ready',
      nextAction: 'continue',
      blockerCount: 0,
      warningCount: 0,
      checks: [],
    });
    expect(rendered).toContain('- Checks: no warnings or blockers');
    expect(rendered).not.toContain('- Checks: unavailable');
  });

  it('lists each recorded warning', () => {
    const rendered = renderReadiness({
      present: true,
      status: 'ready-with-warnings',
      nextAction: 'continue',
      blockerCount: 0,
      warningCount: 1,
      checks: [{ id: 'implementer', severity: 'warning', summary: 'BUILD can run commands.' }],
    });
    expect(rendered).toContain('- warning implementer: BUILD can run commands.');
    expect(rendered).not.toContain('- Checks:');
  });

  it('lists the details and the fix the record keeps under their warning', () => {
    const rendered = renderReadiness({
      present: true,
      status: 'ready-with-warnings',
      nextAction: 'continue',
      blockerCount: 0,
      warningCount: 1,
      checks: [
        {
          id: 'repo.dirty-worktree',
          severity: 'warning',
          summary: 'Working tree has 1 changed file.',
          details: ['Examples: README.md'],
          remediation:
            'A revert saves the files it replaces in .splitbrief/sessions/2026-01-01-fix-the-readme/reverted/.',
        },
      ],
    });
    expect(rendered).toContain(
      [
        '- warning repo.dirty-worktree: Working tree has 1 changed file.',
        '  - Examples: README.md',
        '  - Fix: A revert saves the files it replaces in .splitbrief/sessions/2026-01-01-fix-the-readme/reverted/.',
      ].join('\n'),
    );
  });

  it('reads a missing readiness record as unavailable', () => {
    const rendered = renderReadiness({ present: false });
    expect(rendered).toContain('- Artifact: missing');
    expect(rendered).toContain('- Checks: unavailable');
  });
});

describe('renderReviewPacketMarkdown checks log', () => {
  it('lists each check entry with its task, command and exit code', () => {
    const packet = makeReviewPacket({
      checks: {
        entries: [
          {
            taskId: taskId('T001'),
            id: 'K1',
            command: 'npm test',
            exitCode: 0,
            output: 'ok',
            ts: '2026-01-01T00:00:00.000Z',
          },
          { id: 'typecheck', command: 'tsc --noEmit' },
        ],
        outsideReadPaths: [],
      },
    });

    const rendered = renderReviewPacketMarkdown(packet, NULL_CACHE);

    expect(rendered).toContain('## Checks Log');
    expect(rendered).toContain('- K1 T001 (exit 0): npm test');
    expect(rendered).toContain('- typecheck: tsc --noEmit');
  });

  it('prints the output tail, artifact hashes, snapshot and time of an entry', () => {
    const packet = makeReviewPacket({
      checks: {
        entries: [
          {
            taskId: taskId('T001'),
            id: 'K1',
            command: 'render overlay-picker /tmp/out',
            exitCode: 1,
            output: 'failed to render\nsecond line',
            artifacts: [{ path: 'renders/K1/shot.png', sha256: 'deadbeef' }],
            workspaceSnapshotId: 'snap-9',
            ts: '2026-01-01T00:00:00.000Z',
          },
        ],
        outsideReadPaths: [],
      },
    });

    const rendered = renderReviewPacketMarkdown(packet, NULL_CACHE);

    expect(rendered).toContain('- K1 T001 (exit 1): render overlay-picker /tmp/out');
    expect(rendered).toContain('  output: failed to render');
    expect(rendered).toContain('  output: second line');
    expect(rendered).toContain('  artifact: renders/K1/shot.png sha256 deadbeef');
    expect(rendered).toContain('  snapshot: snap-9');
    expect(rendered).toContain('  time: 2026-01-01T00:00:00.000Z');
  });

  it('marks a refused check as refused and prints why, not as output', () => {
    const packet = makeReviewPacket({
      checks: {
        entries: [
          {
            taskId: taskId('T001'),
            id: 'K2',
            status: 'refused',
            command: 'npm run test',
            output: 'runs a package script or binary',
            ts: '2026-01-01T00:00:00.000Z',
          },
        ],
        outsideReadPaths: [],
      },
    });

    const rendered = renderReviewPacketMarkdown(packet, NULL_CACHE);

    expect(rendered).toContain('- K2 T001 (refused): npm run test');
    expect(rendered).toContain('  reason: runs a package script or binary');
    expect(rendered).not.toContain('output: runs a package script or binary');
  });

  it('lists every isolation outside-read warning path, not only their count', () => {
    const packet = makeReviewPacket({
      checks: {
        entries: [],
        outsideReadPaths: [
          'Task T004 searched ~ with run_command: find ~ -name "process-invoke.ts"',
          'Task T004 read /Users/alice/.ssh/id_ed25519 (outside) with view_file',
        ],
      },
    });

    const rendered = renderReviewPacketMarkdown(packet, NULL_CACHE);

    expect(rendered).toContain(
      '- outside read: Task T004 searched ~ with run_command: find ~ -name "process-invoke.ts"',
    );
    expect(rendered).toContain(
      '- outside read: Task T004 read /Users/alice/.ssh/id_ed25519 (outside) with view_file',
    );
  });

  it('says no checks were recorded for an empty log', () => {
    const packet = makeReviewPacket();
    expect(renderReviewPacketMarkdown(packet, NULL_CACHE)).toContain('- No checks recorded.');
  });
});

describe('renderChecksLogForPrompt', () => {
  it('names the failures that were red at the run base before any task ran', () => {
    const checks = makeReviewPacket({
      checks: {
        entries: [
          {
            taskId: taskId('T002'),
            id: 'test',
            command: 'npm test',
            exitCode: 1,
            output: 'FAIL src/legacy.test.ts > adds',
            preExisting: ['src/legacy.test.ts:5', 'src/old.test.ts:9'],
            ts: '2026-10-08T00:00:00.000Z',
          },
        ],
        outsideReadPaths: [],
      },
    }).checks;

    expect(renderChecksLogForPrompt(checks, EVIDENCE_PATHS)).toContain(
      '  pre-existing (also red at the run base): src/legacy.test.ts:5, src/old.test.ts:9',
    );
  });

  it('uses the packet checks renderer with command, output, artifact and candidate identity', () => {
    const checks = makeReviewPacket({
      checks: {
        entries: [
          {
            taskId: taskId('T001'),
            id: 'K1',
            command: 'npm test',
            exitCode: 1,
            output: 'recorded failure\nTest Files  1 failed (1)',
            artifacts: [{ path: 'renders/shot.png', sha256: 'abc' }],
            workspaceSnapshotId: 'candidate-1',
            ts: '2026-10-06T00:00:00.000Z',
          },
        ],
        outsideReadPaths: ['outside/path'],
      },
    }).checks;

    const rendered = renderChecksLogForPrompt(checks, EVIDENCE_PATHS);
    const packet = renderReviewPacketMarkdown(makeReviewPacket({ checks }), NULL_CACHE);
    expect(packet).toContain(`## Checks Log\n${rendered}\n`);
    expect(rendered).toContain('- K1 T001 (exit 1): npm test');
    expect(rendered).toContain('output: Test Files  1 failed (1)');
    expect(rendered).toContain('artifact: renders/shot.png sha256 abc');
    expect(rendered).toContain('snapshot: candidate-1');
    expect(rendered).toContain('- outside read: outside/path');
  });

  it('bounds output tails and the section, marks omissions and retains failures', () => {
    const checks = makeReviewPacket().checks;
    checks.entries = [
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `pass-${index}`,
        command: 'npm test',
        exitCode: 0,
        output: 'x'.repeat(2_000),
        workspaceSnapshotId: `candidate-${index}`,
      })),
      {
        id: 'failed',
        command: 'npm test',
        exitCode: 1,
        output: 'e'.repeat(1_500) + 'FAIL_MARKER_',
        workspaceSnapshotId: 'candidate-failed',
      },
    ];

    const rendered = renderChecksLogForPrompt(checks, EVIDENCE_PATHS);
    expect(rendered.length).toBeLessThanOrEqual(30_000);
    expect(rendered).not.toContain('x'.repeat(800));
    expect(rendered).toContain('entries omitted');
    expect(rendered).toContain('- failed (exit 1): npm test');
    expect(rendered).toContain('FAIL_MARKER_');
    expect(rendered).toContain('snapshot: candidate-failed');
  });

  it('keeps every check of the current candidate when a 35-task log exceeds the cap', () => {
    const at = (minute: number): string => new Date(Date.UTC(2026, 9, 6, 0, minute)).toISOString();
    const checks = makeReviewPacket().checks;
    checks.entries = Array.from({ length: 35 }, (_, index) => {
      const id = taskId(`T${String(index + 1).padStart(3, '0')}`);
      const historicalFailure = index === 3;
      return ['typecheck', 'lint', 'test'].map((stage) => ({
        taskId: id,
        id: stage,
        command: `npm run ${stage}`,
        exitCode: historicalFailure && stage === 'test' ? 1 : 0,
        output: `${stage} ${id} `.repeat(200),
        workspaceSnapshotId: `candidate-${id}`,
        ts: at(index),
      }));
    }).flat();
    checks.entries.push({
      taskId: taskId('T035'),
      id: 'K1',
      command: 'npm run required',
      exitCode: 0,
      output: 'REQUIRED_PASSED '.repeat(100),
      workspaceSnapshotId: 'candidate-T035',
      ts: at(40),
    });

    const rendered = renderChecksLogForPrompt(checks, EVIDENCE_PATHS);

    expect(rendered.length).toBeLessThanOrEqual(30_000);
    expect(rendered).toContain('- typecheck T035 (exit 0): npm run typecheck');
    expect(rendered).toContain('- lint T035 (exit 0): npm run lint');
    expect(rendered).toContain('- test T035 (exit 0): npm run test');
    expect(rendered).toContain('- K1 T035 (exit 0): npm run required');
    expect(rendered).toContain('- test T004 (exit 1): npm run test');
    expect(rendered).toMatch(/\d+ entries omitted/);
    expect(rendered).toContain(EVIDENCE_PATH);
    expect(rendered).not.toContain(SESSION_LOG_PATH);
  });

  it('names the session log when outside-read lines are omitted', () => {
    const checks = makeReviewPacket().checks;
    checks.outsideReadPaths = Array.from(
      { length: 400 },
      (_, index) =>
        `Task T001 read /Users/someone/${'nested/'.repeat(20)}file-${index}.txt (outside) with view_file`,
    );

    const rendered = renderChecksLogForPrompt(checks, EVIDENCE_PATHS);

    expect(rendered.length).toBeLessThanOrEqual(30_000);
    expect(rendered).toContain('- outside read: Task T001 read');
    expect(rendered).toMatch(/\d+ entries omitted/);
    expect(rendered).toContain(EVIDENCE_PATH);
    expect(rendered).toContain(SESSION_LOG_PATH);
  });

  it('keeps every outside-read path when a log exceeds the cap', () => {
    const checks = makeReviewPacket().checks;
    checks.entries = Array.from({ length: 400 }, (_, index) => ({
      id: `K${index}`,
      command: 'npm test',
      exitCode: 0,
      output: 'x'.repeat(60),
    }));
    const deepPath = `/Users/someone/${'nested/'.repeat(20)}secret.txt`;
    checks.outsideReadPaths = [
      `Task T001 read ${deepPath} (outside) with view_file`,
      'Task T002 searched ~ with run_command: find ~ -name x',
    ];

    const rendered = renderChecksLogForPrompt(checks, EVIDENCE_PATHS);

    expect(rendered.length).toBeLessThanOrEqual(30_000);
    expect(rendered).toMatch(/\d+ entries omitted/);
    expect(rendered).toContain(
      `- outside read: Task T001 read ${deepPath} (outside) with view_file`,
    );
    expect(rendered).toContain(
      '- outside read: Task T002 searched ~ with run_command: find ~ -name x',
    );
  });

  it('names no omission when every entry fits', () => {
    const checks = makeReviewPacket().checks;
    checks.entries = [{ id: 'test', command: 'npm test', exitCode: 0, output: 'ok' }];

    const rendered = renderChecksLogForPrompt(checks, EVIDENCE_PATHS);

    expect(rendered).not.toContain('omitted');
    expect(rendered).not.toContain(EVIDENCE_PATH);
  });

  it('states that an empty checks log has no recorded checks', () => {
    expect(renderChecksLogForPrompt(makeReviewPacket().checks, EVIDENCE_PATHS)).toBe(
      '- No checks recorded.',
    );
  });
});
