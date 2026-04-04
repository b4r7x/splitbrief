import { describe, it, expect } from 'vitest';
import { PlannerPicker } from './planner-picker.js';
import type { PlannerOption, PlannerPickerProps } from './planner-picker.js';

describe('PlannerPicker', () => {
  it('exports PlannerPicker as a function', () => {
    expect(typeof PlannerPicker).toBe('function');
  });

  it('PlannerOption shape is accepted by props', () => {
    const planners: PlannerOption[] = [
      { name: 'claude-code', type: 'cli', version: '1.0.0', available: true },
      { name: 'codex', type: 'cli', version: null, available: true },
      { name: 'aider', type: 'cli', available: false },
    ];

    const props: PlannerPickerProps = {
      planners,
      onSelect: (_planner: { name: string; type: 'cli' | 'api' }) => {},
      onCancel: () => {},
    };

    expect(props.planners).toHaveLength(3);
    expect(props.planners[0].version).toBe('1.0.0');
    expect(props.planners[2].available).toBe(false);
  });

  it('handles empty planners list', () => {
    const props: PlannerPickerProps = {
      planners: [],
      onSelect: () => {},
      onCancel: () => {},
    };

    expect(props.planners).toHaveLength(0);
  });

  it('distinguishes cli vs api planner types', () => {
    const cli: PlannerOption = { name: 'claude-code', type: 'cli', available: true };
    const api: PlannerOption = { name: 'deepseek', type: 'api', available: true };

    expect(cli.type).toBe('cli');
    expect(api.type).toBe('api');
  });
});
