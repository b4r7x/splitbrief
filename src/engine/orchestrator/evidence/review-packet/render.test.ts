import { describe, expect, it } from 'vitest';
import { taskId } from '../../../../core/schemas/task.js';
import { makeReviewPacket } from '#testing/helpers/factories/review-packet.js';
import { renderChecksLogForPrompt, renderReviewPacketMarkdown } from './render.js';

const EVIDENCE_PATH = '/project/.splitbrief/sessions/sess/evidence.json';
const SESSION_LOG_PATH = '/project/.splitbrief/sessions/sess/session.jsonl';
const EVIDENCE_PATHS = { validation: EVIDENCE_PATH, sessionLog: SESSION_LOG_PATH };

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

    const rendered = renderReviewPacketMarkdown(packet);

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

    const rendered = renderReviewPacketMarkdown(packet);

    expect(rendered).toContain('- K1 T001 (exit 1): render overlay-picker /tmp/out');
    expect(rendered).toContain('  output: failed to render');
    expect(rendered).toContain('  output: second line');
    expect(rendered).toContain('  artifact: renders/K1/shot.png sha256 deadbeef');
    expect(rendered).toContain('  snapshot: snap-9');
    expect(rendered).toContain('  time: 2026-01-01T00:00:00.000Z');
  });

  it('lists every isolation outside-read warning path, not only their count', () => {
    const packet = makeReviewPacket({
      checks: {
        entries: [],
        outsideReadPaths: [
          'Task T004 searched ~ with run_command: find ~ -name "process-invoke.ts"',
          'Task T004 read /Users/dev/.ssh/id_ed25519 (outside) with view_file',
        ],
      },
    });

    const rendered = renderReviewPacketMarkdown(packet);

    expect(rendered).toContain(
      '- outside read: Task T004 searched ~ with run_command: find ~ -name "process-invoke.ts"',
    );
    expect(rendered).toContain(
      '- outside read: Task T004 read /Users/dev/.ssh/id_ed25519 (outside) with view_file',
    );
  });

  it('says no checks were recorded for an empty log', () => {
    const packet = makeReviewPacket();
    expect(renderReviewPacketMarkdown(packet)).toContain('- No checks recorded.');
  });
});

describe('renderChecksLogForPrompt', () => {
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
    const packet = renderReviewPacketMarkdown(makeReviewPacket({ checks }));
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
