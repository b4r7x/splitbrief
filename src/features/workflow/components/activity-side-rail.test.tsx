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
});
