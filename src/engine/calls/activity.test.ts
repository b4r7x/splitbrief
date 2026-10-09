import { describe, expect, it } from 'vitest';
import { EngineEventSchema } from '../events/schema.js';
import { projectRunnerCallActivity } from './activity.js';
import type { RunnerCallEvent, RunnerCallWarningInput } from './types.js';
import { normalizeRunnerCallWarning } from './warnings.js';

const runnerCallBase = {
  ts: 1_200,
  callId: 'call-1',
  role: 'implementer',
  backendKind: 'cli',
  runnerName: 'codex',
  model: 'xhigh',
  attempt: 0,
} as const;

type RunnerToolUseDeltaEvent = Extract<RunnerCallEvent, { type: 'call_tool_use_delta' }>;

function runnerToolUse(overrides?: Partial<RunnerToolUseDeltaEvent>): RunnerCallEvent {
  return {
    ...runnerCallBase,
    type: 'call_tool_use_delta',
    channel: 'tool',
    toolUseId: 'tool-1',
    name: 'Read',
    inputDelta: '{"file_path":"src/app.ts"}',
    ...overrides,
  };
}

function runnerWarning(input: RunnerCallWarningInput) {
  return normalizeRunnerCallWarning(input);
}

describe('projectRunnerCallActivity', () => {
  it('normalizes safe structured tool, artifact, and warning activity', () => {
    expect(projectRunnerCallActivity(runnerToolUse(), 1, '/project')).toMatchObject({
      kind: 'read',
      label: 'reading src/app.ts',
    });
    expect(
      projectRunnerCallActivity(
        runnerToolUse({ name: 'Bash', inputDelta: '{"command":"npm run typecheck"}' }),
        1,
        '/project',
      ),
    ).toMatchObject({ kind: 'command', label: 'running npm run typecheck' });
    expect(
      projectRunnerCallActivity(
        runnerToolUse({
          name: 'command_execution',
          inputDelta: '{"type":"command_execution","command":"npm test"}',
        }),
        1,
        '/project',
      ),
    ).toMatchObject({ kind: 'command', label: 'running npm test', target: 'npm test' });
    expect(
      projectRunnerCallActivity(
        runnerToolUse({ name: 'Grep', inputDelta: '{"pattern":"useWorkflowRunner"}' }),
        1,
        '/project',
      ),
    ).toMatchObject({ kind: 'search', label: 'searching useWorkflowRunner' });
    expect(
      projectRunnerCallActivity(
        runnerToolUse({ name: 'Glob', inputDelta: '{"pattern":"src/**/*.tsx"}' }),
        1,
        '/project',
      ),
    ).toMatchObject({ kind: 'glob', label: 'matching src/**/*.tsx' });
    expect(
      projectRunnerCallActivity(
        runnerToolUse({ name: 'Edit', inputDelta: '{"file_path":"src/app.tsx"}' }),
        1,
        '/project',
      ),
    ).toMatchObject({ kind: 'write', label: 'editing src/app.tsx' });
    expect(
      projectRunnerCallActivity(runnerToolUse({ name: 'apply_patch' }), 1, '/project'),
    ).toMatchObject({
      kind: 'edit',
      label: 'applying patch',
    });
    expect(
      projectRunnerCallActivity(
        { ...runnerCallBase, type: 'call_session_id', nativeSessionId: 'native-session-1' },
        1,
        '/project',
      ),
    ).toBeNull();
    expect(
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          type: 'call_artifact',
          artifact: {
            id: 'artifact-1',
            source: 'file',
            name: 'plan.md',
            path: null,
            mimeType: 'text/markdown',
            text: null,
          },
        },
        1,
        '/project',
      ),
    ).toMatchObject({ kind: 'artifact', label: 'artifact plan.md' });
    expect(
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          type: 'call_warning',
          warning: runnerWarning({ code: 'stderr', message: 'raw' }),
        },
        1,
        '/project',
      ),
    ).toMatchObject({ kind: 'warning', label: 'warning stderr' });
  });

  it('labels Antigravity inputs: CommandLine runs, AbsolutePath reads, TargetFile edits', () => {
    expect(
      projectRunnerCallActivity(
        runnerToolUse({
          name: 'run_command',
          inputDelta: '{"CommandLine":"pwd; ls -la README.md"}',
        }),
        1,
        '/project',
      ),
    ).toMatchObject({
      kind: 'command',
      label: 'running pwd; ls -la README.md',
      target: 'pwd; ls -la README.md',
    });
    expect(
      projectRunnerCallActivity(
        runnerToolUse({ name: 'view_file', inputDelta: '{"AbsolutePath":"/tmp/probe/README.md"}' }),
        1,
        '/project',
      ),
    ).toMatchObject({ kind: 'read', label: 'reading /tmp/probe/README.md' });
    for (const name of ['write_to_file', 'replace_file_content', 'multi_replace_file_content']) {
      expect(
        projectRunnerCallActivity(
          runnerToolUse({ name, inputDelta: '{"TargetFile":"/tmp/probe/check.sh"}' }),
          1,
          '/project',
        ),
      ).toMatchObject({ kind: 'write', label: 'editing /tmp/probe/check.sh' });
    }
  });

  it('ignores prompt-like tool fields and does not invent exploring labels', () => {
    const activity = projectRunnerCallActivity(
      runnerToolUse({
        name: 'Task',
        inputDelta: JSON.stringify({
          subagent_type: 'general',
          prompt: 'inspect token sk-abcdefghijklmnopqrstuvwxyz',
          description: 'explore the codebase',
          task: 'find the bug',
        }),
      }),
      1,
      '/project',
    );

    expect(activity).toMatchObject({ label: 'task general' });
    expect(activity?.label).not.toContain('prompt');
    expect(activity?.label).not.toContain('explore');
    expect(activity?.label).not.toContain('abcdefghijklmnopqrstuvwxyz');

    expect(
      projectRunnerCallActivity(
        runnerToolUse({ name: 'Explore', inputDelta: '{"description":"files"}' }),
        1,
        '/project',
      ),
    ).toMatchObject({ label: 'tool Explore' });
  });

  it('uses safe web and MCP targets without leaking URL query strings', () => {
    expect(
      projectRunnerCallActivity(
        runnerToolUse({
          name: 'WebFetch',
          inputDelta: '{"url":"https://example.com/path?token=sk-abcdefghijklmnopqrstuvwxyz"}',
        }),
        1,
        '/project',
      ),
    ).toMatchObject({ kind: 'web', label: 'calling WebFetch example.com' });

    expect(
      projectRunnerCallActivity(
        runnerToolUse({ name: 'mcp__chrome_devtools__click' }),
        1,
        '/project',
      ),
    ).toMatchObject({ kind: 'mcp', label: 'calling mcp__chrome_devtools__click' });

    expect(
      projectRunnerCallActivity(
        runnerToolUse({
          name: 'mcp_tool_call',
          inputDelta: '{"type":"mcp_tool_call","server":"github","tool_name":"list_issues"}',
        }),
        1,
        '/project',
      ),
    ).toMatchObject({
      kind: 'mcp',
      label: 'calling mcp_tool_call github/list_issues',
      target: 'github/list_issues',
    });
  });

  it('falls back to a safe tool name for malformed input deltas', () => {
    expect(
      projectRunnerCallActivity(
        runnerToolUse({ name: 'Bash', inputDelta: '{"command":' }),
        1,
        '/project',
      ),
    ).toMatchObject({ label: 'tool Bash' });
  });

  it('only projects explicitly system text activity', () => {
    expect(
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          type: 'call_text_delta',
          channel: 'system',
          text: 'reading\u001b[31m files\u001b[0m token sk-abcdefghijklmnopqrst',
        },
        1,
        '/project',
      ),
    ).toMatchObject({
      label: 'system activity',
      textPartial: 'reading files token sk-***REDACTED***',
      redacted: true,
    });
    expect(
      projectRunnerCallActivity(
        { ...runnerCallBase, type: 'call_text_delta', channel: 'stdout', text: 'stdout' },
        1,
        '/project',
      ),
    ).toBeNull();
    expect(
      projectRunnerCallActivity(
        { ...runnerCallBase, type: 'call_text_delta', channel: 'assistant', text: 'answer' },
        1,
        '/project',
      ),
    ).toBeNull();
    expect(
      projectRunnerCallActivity(
        { ...runnerCallBase, type: 'call_text_delta', channel: 'result', text: 'answer' },
        1,
        '/project',
      ),
    ).toBeNull();
    expect(
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          type: 'call_stderr_delta',
          channel: 'stderr',
          text: 'benign progress',
        },
        1,
        '/project',
      ),
    ).toBeNull();
  });

  it('preserves activity text beyond the old display caps', () => {
    const command = `npm test ${'界🙂e\u0301'.repeat(40)}`;
    expect(
      projectRunnerCallActivity(
        runnerToolUse({ name: 'Bash', inputDelta: JSON.stringify({ command }) }),
        1,
        '/project',
      ),
    ).toMatchObject({ label: `running ${command}`, target: command });
    expect(
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          type: 'call_text_delta',
          channel: 'system',
          text: command,
        },
        1,
        '/project',
      ),
    ).toMatchObject({ textPartial: command });
    expect(
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          type: 'call_warning',
          warning: runnerWarning({ code: 'progress', message: command }),
        },
        1,
        '/project',
      ),
    ).toMatchObject({ diagnosticPartial: command });
  });

  it('keeps oversized Unicode payloads within the event schema bounds', () => {
    const command = `npm test ${'🙂界'.repeat(1500)}`;
    const activities = [
      projectRunnerCallActivity(
        runnerToolUse({ name: 'Bash', inputDelta: JSON.stringify({ command }) }),
        1,
        '/project',
      ),
      projectRunnerCallActivity(
        { ...runnerCallBase, type: 'call_text_delta', channel: 'system', text: command },
        1,
        '/project',
      ),
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          type: 'call_warning',
          warning: runnerWarning({ code: 'progress', message: command }),
        },
        1,
        '/project',
      ),
    ];
    for (const activity of activities) {
      expect(activity).not.toBeNull();
      expect(
        EngineEventSchema.safeParse({
          ...runnerCallBase,
          ...activity,
          type: 'runner_call_activity',
          phase: 'implementing',
          sequence: 1,
        }).success,
      ).toBe(true);
      for (const value of [
        activity?.label,
        activity?.target,
        activity?.textPartial,
        activity?.diagnosticPartial,
      ]) {
        if (value !== undefined) expect(value.isWellFormed()).toBe(true);
      }
    }
    expect(activities[0]?.label.length).toBeLessThanOrEqual(512);
    expect(activities[0]?.target?.length).toBeLessThanOrEqual(2048);
  });

  it('redacts and normalizes command text beyond the old display caps', () => {
    const prefix = `npm test ${'test/file.ts '.repeat(12)}`;
    const activity = projectRunnerCallActivity(
      runnerToolUse({
        name: 'Bash',
        inputDelta: JSON.stringify({
          command: `${prefix}\n\u001b[31msk-abcdefghijklmnopqrst\u001b[0m`,
        }),
      }),
      1,
      '/project',
    );
    expect(activity).toMatchObject({
      redacted: true,
      target: `${prefix}sk-***REDACTED***`,
    });
    expect(activity?.label).not.toContain('abcdefghijklmnopqrst');
  });

  it('projects a terminal failure as activity and a success as none', () => {
    expect(
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          type: 'call_completed',
          status: 'completed',
          error: null,
          startedAt: 1_000,
          endedAt: 2_000,
          durationMs: 1_000,
          partial: false,
          usage: null,
          nativeSessionId: null,
        },
        10,
        '/project',
      ),
    ).toBeNull();

    expect(
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          type: 'call_error',
          status: 'timeout',
          error: { code: 'timeout', message: 'runner timed out sk-abcdefghijklmnopqrst' },
          startedAt: 1_000,
          endedAt: 2_000,
          durationMs: 1_000,
          partial: true,
          usage: null,
          nativeSessionId: null,
        },
        11,
        '/project',
      ),
    ).toMatchObject({
      activityId: 'call-1:terminal',
      stage: 'timeout',
      kind: 'error',
      label: 'timeout timeout',
      diagnosticPartial: 'runner timed out sk-***REDACTED***',
      rawAvailable: true,
      redacted: true,
    });
  });

  it('keeps safe warning detail separate from text partials', () => {
    const warning = runnerWarning({ code: 'stderr', message: 'line one sk-abcdefghijklmnopqrst' });

    expect(
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          type: 'call_warning',
          warning,
        },
        12,
        '/project',
      ),
    ).toMatchObject({
      stage: 'warning',
      kind: 'warning',
      label: 'warning stderr',
      diagnosticPartial: 'line one sk-***REDACTED***',
      rawAvailable: false,
      redacted: true,
    });
  });

  it('uses normalized visible warning content for activity identity', () => {
    const first = projectRunnerCallActivity(
      {
        ...runnerCallBase,
        type: 'call_warning',
        warning: runnerWarning({ code: 'stderr', message: 'line one sk-abcdefghijklmnopqrst' }),
      },
      12,
      '/project',
    );
    const repeated = projectRunnerCallActivity(
      {
        ...runnerCallBase,
        type: 'call_warning',
        warning: runnerWarning({ code: 'stderr', message: 'line one sk-abcdefghijklmnopqrst' }),
      },
      13,
      '/project',
    );
    const changed = projectRunnerCallActivity(
      {
        ...runnerCallBase,
        type: 'call_warning',
        warning: runnerWarning({ code: 'stderr', message: 'line two sk-abcdefghijklmnopqrst' }),
      },
      14,
      '/project',
    );

    expect(first?.activityId).toBe(repeated?.activityId);
    expect(changed?.activityId).not.toBe(first?.activityId);
    expect(first?.activityId).not.toContain('abcdefghijklmnopqrst');
  });
});
