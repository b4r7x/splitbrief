import { describe, it, expect } from 'vitest';
import { CLI_TOOLS } from './cli-tools.js';

describe('CLI_TOOLS', () => {
  describe('copilot', () => {
    const tool = CLI_TOOLS.copilot;

    it('has correct command', () => {
      expect(tool.command).toBe('copilot');
    });

    it('has planner and implementer configs', () => {
      expect(tool.planner).toBeDefined();
      expect(tool.implementer).toBeDefined();
    });

    it('planner buildArgs includes -p and --output-format', () => {
      const args = tool.planner!.buildArgs({ prompt: 'test prompt', model: undefined, projectDir: '/tmp', mode: 'plan' });
      expect(args).toContain('-p');
      expect(args).toContain('test prompt');
      expect(args).toContain('--output-format');
    });

    it('planner buildArgs prepends --model when model is set', () => {
      const args = tool.planner!.buildArgs({ prompt: 'test', model: 'gpt-5.2', projectDir: '/tmp', mode: 'plan' });
      const modelIdx = args.indexOf('--model');
      const promptIdx = args.indexOf('-p');
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(args[modelIdx + 1]).toBe('gpt-5.2');
      expect(modelIdx).toBeLessThan(promptIdx);
    });

    it('planner buildArgs omits --model when model is undefined', () => {
      const args = tool.planner!.buildArgs({ prompt: 'test', model: undefined, projectDir: '/tmp', mode: 'plan' });
      expect(args).not.toContain('--model');
    });

    it('implementer buildArgs includes --allow-all', () => {
      const args = tool.implementer!.buildArgs({ prompt: 'implement this', model: undefined });
      expect(args).toContain('--allow-all');
      expect(args).toContain('-p');
      expect(args).toContain('implement this');
    });

    it('implementer buildArgs prepends --model when set', () => {
      const args = tool.implementer!.buildArgs({ prompt: 'test', model: 'claude-sonnet-4-6' });
      expect(args).toContain('--model');
      expect(args).toContain('claude-sonnet-4-6');
    });
  });

  describe('kilo-code', () => {
    const tool = CLI_TOOLS['kilo-code'];

    it('has correct command', () => {
      expect(tool.command).toBe('kilo');
    });

    it('has planner and implementer configs', () => {
      expect(tool.planner).toBeDefined();
      expect(tool.implementer).toBeDefined();
    });

    it('planner buildArgs uses run command with --json', () => {
      const args = tool.planner!.buildArgs({ prompt: 'plan this', model: undefined, projectDir: '/tmp', mode: 'plan' });
      expect(args[0]).toBe('run');
      expect(args).toContain('--json');
      expect(args).toContain('--auto');
      expect(args).toContain('plan this');
      // Should NOT have --format as separate key-value
      expect(args).not.toContain('--format');
    });

    it('planner buildArgs includes model when set', () => {
      const args = tool.planner!.buildArgs({ prompt: 'test', model: 'claude-sonnet-4-6', projectDir: '/tmp', mode: 'plan' });
      expect(args).toContain('--model');
      expect(args).toContain('claude-sonnet-4-6');
    });

    it('planner buildArgs omits --model when undefined', () => {
      const args = tool.planner!.buildArgs({ prompt: 'test', model: undefined, projectDir: '/tmp', mode: 'plan' });
      expect(args).not.toContain('--model');
    });

    it('implementer buildArgs uses run with --auto and --yolo', () => {
      const args = tool.implementer!.buildArgs({ prompt: 'do this', model: undefined });
      expect(args[0]).toBe('run');
      expect(args).toContain('--auto');
      expect(args).toContain('--yolo');
      expect(args).toContain('do this');
    });

    it('implementer buildArgs includes model when set', () => {
      const args = tool.implementer!.buildArgs({ prompt: 'test', model: 'qwen2.5-coder:7b' });
      expect(args).toContain('--model');
      expect(args).toContain('qwen2.5-coder:7b');
    });

    it('has planner timeout set to 5000ms', () => {
      expect(tool.planner!.isAvailableOpts?.timeout).toBe(5000);
    });
  });
});
