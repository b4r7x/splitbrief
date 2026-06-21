import { describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { getWorkflowConfigDensity, WorkflowConfigCard } from './config.js';

const jwt =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

function workflowConfig(
  overrides: Partial<Omit<EngineEventOf<'workflow_config'>, 'type' | 'ts' | 'phase'>> = {},
): EngineEventOf<'workflow_config'> {
  return {
    type: 'workflow_config',
    ts: 1,
    phase: 'planning',
    mode: 'instant',
    plannerTool: 'codex',
    implementerTool: 'codex',
    ...overrides,
  };
}

describe('WorkflowConfigCard', () => {
  it('chooses density by terminal cell width for wide-character model names', () => {
    expect(
      getWorkflowConfigDensity(
        workflowConfig({
          plannerModel: '漢字漢字漢字漢字',
        }),
        56,
      ),
    ).toBe('labels');
  });

  it('sanitizes tool and model names in the config header', () => {
    const ui = renderFeature(
      <WorkflowConfigCard
        event={workflowConfig({
          plannerTool: `custom \u001b[31mred\u001b[0m ${jwt}`,
          plannerModel: 'model sk-abcdefghijklmnopqrstuvwxyz',
          implementerTool: `runner ${jwt}`,
          implementerModel: 'impl \u001b[7mvisible\u001b[0m',
        })}
        density="full"
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('custom red');
    expect(frame).toContain('model');
    expect(frame).toContain('sk-***REDACTED***');
    expect(frame).toContain('runner');
    expect(frame).toContain('impl');
    expect(frame).toContain('visible');
    expect(frame.match(/\*\*\*REDACTED\*\*\*/g)?.length).toBe(3);
    expect(frame).not.toContain('eyJhbGci');
    expect(frame).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(frame).not.toContain('\u001b');

    ui.unmount();
  });
});
