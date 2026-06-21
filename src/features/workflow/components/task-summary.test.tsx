import { describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { TaskSummary } from './task-summary.js';

const jwt =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

describe('TaskSummary', () => {
  it('sanitizes completed task title and file text', () => {
    const ui = renderFeature(
      <TaskSummary
        index={1}
        title={`apply \u001b[31mred\u001b[0m ${jwt}`}
        method="local"
        file="token=sk-abcdefghijklmnopqrstuvwxyz"
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('T1 apply red ***REDACTED***');
    expect(frame).toContain('token=sk-***REDACTED***');
    expect(frame).not.toContain('eyJhbGci');
    expect(frame).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(frame).not.toContain('\u001b');

    ui.unmount();
  });

  it('sanitizes skipped reasons', () => {
    const ui = renderFeature(
      <TaskSummary
        index={2}
        title="skip task"
        method="skipped"
        reason={`blocked by ${jwt} and \u001b[7mcontrol\u001b[0m`}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('blocked by ***REDACTED*** and control');
    expect(frame).not.toContain('eyJhbGci');
    expect(frame).not.toContain('\u001b');

    ui.unmount();
  });
});
