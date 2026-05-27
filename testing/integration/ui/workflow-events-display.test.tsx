import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { WorkflowConfigCard } from '../../../src/features/workflow/components/event-cards/workflow-config-card.js';
import { PlannerStatusCard } from '../../../src/features/workflow/components/event-cards/planner-status-card.js';
import { StreamingLines } from '../../../src/features/workflow/components/event-cards/streaming-lines.js';
import { streamingOutputStore } from '../../../src/stores/workflow/streaming-output.js';
import { taskId } from '../../../src/core/schemas/task.js';
import type { EngineEventOf } from '../../../src/engine/events/types.js';

describe('workflow events display', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAllStores();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('WorkflowConfigCard', () => {
    it('renders Mode, Planner, and Implementer on separate lines', () => {
      const event: EngineEventOf<'workflow_config'> = {
        type: 'workflow_config',
        ts: Date.now(),
        phase: 'planning',
        mode: 'standard',
        plannerTool: 'anthropic',
        plannerModel: 'claude-sonnet-4-20250514',
        implementerTool: 'deepseek',
        implementerModel: 'deepseek-coder',
      };

      const ui = renderFeature(<WorkflowConfigCard event={event} />);
      const frame = ui.lastFrame() ?? '';
      const lines = frame.split('\n');

      const modeLine = lines.findIndex(l => l.includes('Mode:'));
      const plannerLine = lines.findIndex(l => l.includes('Planner:'));
      const implementerLine = lines.findIndex(l => l.includes('Implementer:'));

      expect(modeLine).toBeGreaterThanOrEqual(0);
      expect(plannerLine).toBeGreaterThanOrEqual(0);
      expect(implementerLine).toBeGreaterThanOrEqual(0);
      expect(modeLine).not.toBe(plannerLine);
      expect(plannerLine).not.toBe(implementerLine);
      expect(modeLine).not.toBe(implementerLine);

      ui.unmount();
    });
  });

  describe('PlannerStatusCard', () => {
    it('shows role and phase with single space when running', () => {
      const event: EngineEventOf<'planner_status'> = {
        type: 'planner_status',
        ts: Date.now(),
        phase: 'planning',
        status: 'running',
      };

      const ui = renderFeature(<PlannerStatusCard event={event} />);
      const frame = ui.lastFrame() ?? '';

      expect(frame).toContain('planner planning');
      expect(frame).not.toContain('planner  planning');

      ui.unmount();
    });
  });

  describe('StreamingLines', () => {
    it('displays streaming lines during implementer execution', () => {
      const id = taskId('T001');
      streamingOutputStore.startStreaming(id);
      streamingOutputStore.pushLines(['line one', 'line two', 'line three']);

      const ui = renderFeature(<StreamingLines />);
      const frame = ui.lastFrame() ?? '';

      expect(frame).toContain('line one');
      expect(frame).toContain('line two');
      expect(frame).toContain('line three');

      ui.unmount();
    });
  });
});
