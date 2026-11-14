import { describe, it, expect } from 'vitest';
import { Command, InvalidArgumentError } from 'commander';
import { parseContinueActionOption } from './continue-action.js';
import { addWorkflowOptions } from './workflow.js';
import { runCommand } from '#testing/helpers/commander.js';
import { parseWorkflowOptions } from '#testing/helpers/workflow-options.js';

describe('parseContinueActionOption', () => {
  it('maps the three continue actions to their RecoveryAction ids', () => {
    expect(parseContinueActionOption('skip')).toEqual({ action: 'skip-current-task' });
    expect(parseContinueActionOption('retry')).toEqual({ action: 'retry-same-worker' });
    expect(parseContinueActionOption('switch-seat:codex')).toEqual({
      action: 'switch-seat',
      candidate: { tool: 'codex' },
    });
    expect(parseContinueActionOption('switch-seat:codex:gpt-5')).toEqual({
      action: 'switch-seat',
      candidate: { tool: 'codex', model: 'gpt-5' },
    });
  });

  it('keeps the seat switch effort the seat grammar reads after the last @', () => {
    expect(parseContinueActionOption('switch-seat:opencode:opencode-go/kimi-k3@high')).toEqual({
      action: 'switch-seat',
      candidate: { tool: 'opencode', model: 'opencode-go/kimi-k3', variant: 'high' },
    });
    expect(parseContinueActionOption('switch-seat:codex@xhigh')).toEqual({
      action: 'switch-seat',
      candidate: { tool: 'codex', effort: 'xhigh' },
    });
  });

  it('rejects a seat switch whose effort is not an admitted level', () => {
    expect(() => parseContinueActionOption('switch-seat:codex@furious')).toThrow(
      InvalidArgumentError,
    );
  });

  it('maps apply and discard to the two ways a ready run settles', () => {
    expect(parseContinueActionOption('apply')).toEqual({ action: 'apply' });
    expect(parseContinueActionOption('discard')).toEqual({ action: 'discard' });
  });

  it('maps restore to the backup restore a partial Apply offers', () => {
    expect(parseContinueActionOption('restore')).toEqual({ action: 'restore-backup' });
  });

  it.each([
    { word: 'accept-as-is', option: { action: 'accept-as-is' } },
    { word: 'apply-as-is', option: { action: 'apply-as-is' } },
  ])('takes $word, the word of its run screen row', ({ word, option }) => {
    expect(() => parseContinueActionOption(word)).not.toThrow();
    expect(parseContinueActionOption(word)).toEqual(option);
  });

  it('exits 2 on an action it does not offer and names each action it offers', () => {
    expect(() => parseContinueActionOption('abort')).toThrowError(
      expect.objectContaining({
        exitCode: 2,
        message:
          "'abort' is not a continue action. Use skip, retry, restore, switch-seat:<tool>[:<model>][@<effort>], accept-as-is, end-run, apply, apply-as-is, or discard.",
      }),
    );
  });

  it('registers --action on the workflow options', () => {
    expect(parseWorkflowOptions(['--action', 'skip'])).toMatchObject({
      action: { action: 'skip-current-task' },
    });
  });

  it('omits --action from start and resume help and describes CLI and API model overrides', async () => {
    const help = addWorkflowOptions(new Command('start')).helpInformation();

    expect(help).not.toContain('--action');
    expect(addWorkflowOptions(new Command('resume')).helpInformation()).not.toContain('--action');
    expect(
      help
        .split('\n')
        .filter((line) => /--(?:planner|reviewer)-model/.test(line))
        .join('\n'),
    ).toMatchInlineSnapshot(`
        "  --planner-model <model>                Planner model (CLI and API planners)
          --reviewer-model <model>               Reviewer model (CLI and API reviewers)"
      `);

    const result = await runCommand(['start', 'smoke', '--action', 'skip']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown option '--action'");

    const resume = await runCommand(['resume', '--help']);
    expect(resume.exitCode).toBe(0);
    expect(resume.stdout).toContain('Resume the most recent run');
    expect(resume.stdout).not.toContain('--action');

    const resumeRejected = await runCommand(['resume', '--action', 'skip']);
    expect(resumeRejected.exitCode).toBe(1);
    expect(resumeRejected.stderr).toBe("error: unknown option '--action'\n");
  });

  it('describes continue actions with the seat grammar the parser accepts', async () => {
    const description =
      'skip, retry, restore, switch-seat:<tool>[:<model>][@<effort>], accept-as-is, or end-run answer recovery; apply, apply-as-is and discard settle a run that is ready to apply';
    const help = addWorkflowOptions(new Command('continue')).helpInformation().replace(/\s+/g, ' ');

    expect(help).toContain(description);
    expect(help).not.toContain('switch-seat:<seat>');
    expect(help).not.toContain('`continue` only');

    const registered = await runCommand(['continue', '--help']);
    const registeredHelp = registered.stdout.replace(/\s+/g, ' ');
    expect(registered.exitCode).toBe(0);
    expect(registeredHelp).toContain(description);
    expect(registeredHelp).not.toContain('switch-seat:<seat>');
    expect(registeredHelp).not.toContain('`continue` only');
  });
});
