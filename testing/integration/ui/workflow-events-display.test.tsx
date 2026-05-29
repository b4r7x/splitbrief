import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { WorkflowConfigCard } from '../../../src/features/workflow/components/event-cards/workflow-config-card.js';
import { PlannerStatusCard } from '../../../src/features/workflow/components/event-cards/planner-status-card.js';
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
    it('renders Mode, Planner, and Implementer inline on one line', () => {
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

      expect(lines).toHaveLength(1);
      expect(frame).toContain('standard');
      expect(frame).toContain('Planner:');
      expect(frame).toContain('Implementer:');
      expect(frame).toContain('claude-sonnet-4-20250514');
      expect(frame).toContain('deepseek-coder');

      ui.unmount();
    });

    it('renders both selected tool slots in tools density even when tools match', () => {
      const event: EngineEventOf<'workflow_config'> = {
        type: 'workflow_config',
        ts: Date.now(),
        phase: 'planning',
        mode: 'instant',
        plannerTool: 'codex',
        implementerTool: 'codex',
      };

      const ui = renderFeature(<WorkflowConfigCard event={event} density="tools" />);
      const frame = ui.lastFrame() ?? '';

      expect(frame).toContain('instant · Codex → Codex');
      expect(frame).not.toContain('Planner:');
      expect(frame).not.toContain('Implementer:');
      expect(frame.match(/Codex/g)).toHaveLength(2);

      ui.unmount();
    });

    it('renders both selected tools in tools density when planner and implementer differ', () => {
      const event: EngineEventOf<'workflow_config'> = {
        type: 'workflow_config',
        ts: Date.now(),
        phase: 'planning',
        mode: 'standard',
        plannerTool: 'anthropic',
        implementerTool: 'deepseek',
      };

      const ui = renderFeature(<WorkflowConfigCard event={event} density="tools" />);
      const frame = ui.lastFrame() ?? '';

      expect(frame).toContain('standard · Anthropic → DeepSeek');
      expect(frame).not.toContain('Planner:');
      expect(frame).not.toContain('Implementer:');

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
});
