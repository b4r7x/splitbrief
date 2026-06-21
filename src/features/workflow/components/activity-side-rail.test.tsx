import { beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { activityStore } from '../../../stores/workflow/activity.js';
import { ActivitySideRail } from './activity-side-rail.js';

beforeEach(() => {
  activityStore.__testReset();
});

describe('ActivitySideRail', () => {
  it('preserves useful command tails in the wide activity rail', () => {
    activityStore.__testReset({
      items: [
        {
          id: 'activity-1',
          callId: 'call-1',
          phase: 'researching',
          role: 'planner',
          stage: 'updated',
          kind: 'command',
          label: 'running cat /Users/voitz/.agents/library/typescript-best-practices/SKILL.md',
          target: 'cat /Users/voitz/.agents/library/typescript-best-practices/SKILL.md',
          runnerName: 'codex',
          redacted: false,
          rawAvailable: false,
          expandId: 'activity-1',
          sequence: 1,
          ts: 1,
        },
      ],
    });

    const ui = renderFeature(<ActivitySideRail height={4} width={42} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('plan researching [Codex]');
    expect(frame).toContain('run 1');
    expect(frame).toContain('cat ');
    expect(frame).toContain('SKILL.md');
    expect(frame).toContain('…');
    ui.unmount();
  });

  it('renders aborted runner interruption as an interrupted warning with safe detail', () => {
    activityStore.__testReset({
      items: [
        {
          id: 'activity-1',
          callId: 'call-1',
          phase: 'implementing',
          role: 'implementer',
          stage: 'aborted',
          kind: 'error',
          label: 'aborted runner_interrupted',
          diagnosticPartial: 'cancelled sk-abcdefghijklmnopqrstuvwxyz',
          redacted: true,
          rawAvailable: true,
          expandId: 'activity-1',
          sequence: 1,
          ts: 1,
        },
      ],
    });

    const ui = renderFeature(<ActivitySideRail height={4} width={80} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('interrupted');
    expect(frame).toContain('cancelled sk-***REDACTED***');
    expect(frame).not.toContain('runner_interrupted');
    expect(frame).not.toContain('error aborted');
    expect(frame).not.toContain('[expand]');
    ui.unmount();
  });

  it('pins warning activity above the safe recent tail', () => {
    activityStore.__testReset({
      items: [
        {
          id: 'read-1',
          callId: 'call-1',
          phase: 'implementing',
          role: 'implementer',
          stage: 'updated',
          kind: 'read',
          label: 'reading a.ts',
          redacted: false,
          rawAvailable: false,
          sequence: 1,
          ts: 1,
        },
        {
          id: 'warn-1',
          callId: 'call-1',
          phase: 'implementing',
          role: 'implementer',
          stage: 'warning',
          kind: 'warning',
          label: 'warning stderr',
          diagnosticPartial: 'deprecated dependency',
          redacted: false,
          rawAvailable: true,
          expandId: 'warn-1',
          sequence: 2,
          ts: 2,
        },
        {
          id: 'read-2',
          callId: 'call-1',
          phase: 'implementing',
          role: 'implementer',
          stage: 'updated',
          kind: 'read',
          label: 'reading b.ts',
          redacted: false,
          rawAvailable: false,
          sequence: 3,
          ts: 3,
        },
      ],
    });

    const ui = renderFeature(<ActivitySideRail height={6} width={60} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('impl implementing');
    expect(frame).toContain('read 2  warn 1');
    expect(frame).toContain('WARN  stderr: deprecated dependency  raw');
    expect(frame).toContain('READ  b.ts');
    expect(frame.indexOf('WARN  stderr')).toBeLessThan(frame.indexOf('READ  b.ts'));
    ui.unmount();
  });

  it('scopes the header count to the current call overview', () => {
    activityStore.__testReset({
      items: [
        {
          id: 'old-1',
          callId: 'old-call',
          phase: 'planning',
          role: 'planner',
          stage: 'updated',
          kind: 'read',
          label: 'reading old-a.ts',
          redacted: false,
          rawAvailable: false,
          sequence: 1,
          ts: 1,
        },
        {
          id: 'old-2',
          callId: 'old-call',
          phase: 'planning',
          role: 'planner',
          stage: 'updated',
          kind: 'read',
          label: 'reading old-b.ts',
          redacted: false,
          rawAvailable: false,
          sequence: 2,
          ts: 2,
        },
        {
          id: 'new-1',
          callId: 'new-call',
          phase: 'implementing',
          role: 'implementer',
          stage: 'updated',
          kind: 'read',
          label: 'reading new.ts',
          redacted: false,
          rawAvailable: false,
          sequence: 3,
          ts: 3,
        },
      ],
    });

    const ui = renderFeature(<ActivitySideRail height={5} width={50} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Activity 1');
    expect(frame).toContain('READ  new.ts');
    expect(frame).not.toContain('Activity 3');
    expect(frame).not.toContain('old-a.ts');
    ui.unmount();
  });
});
