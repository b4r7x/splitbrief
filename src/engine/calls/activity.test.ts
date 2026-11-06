import { describe, expect, it } from 'vitest';
import { EngineEventSchema } from '../events/schema.js';
import { projectRunnerCallActivity } from './activity.js';
import { createRunnerCallRecorder } from './recorder.js';
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

let toolUseExample = 0;

function runnerToolUse(overrides?: Partial<RunnerToolUseDeltaEvent>): RunnerCallEvent {
  toolUseExample += 1;
  return {
    ...runnerCallBase,
    type: 'call_tool_use_delta',
    channel: 'tool',
    toolUseId: `tool-${toolUseExample}`,
    name: 'Read',
    inputDelta: '{"file_path":"src/app.ts"}',
    ...overrides,
  };
}

function runnerWarning(input: RunnerCallWarningInput) {
  return normalizeRunnerCallWarning(input);
}

describe('projectRunnerCallActivity', () => {
  it('keeps distinct uses without upstream ids distinct at the recording boundary', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context: runnerCallBase,
      onEvent: (event) => events.push(event),
    });
    for (const file of ['src/first.ts', 'src/second.ts']) {
      recorder.toolUseDone({
        toolUse: { id: null, name: 'Read', input: { file_path: file }, output: null },
      });
    }
    const activities = events.flatMap((event, index) => {
      const activity = projectRunnerCallActivity(event, index, '/project');
      return activity === null ? [] : [activity];
    });
    expect(activities.map((activity) => activity.target)).toEqual([
      'src/first.ts',
      'src/second.ts',
    ]);
    expect(new Set(activities.map((activity) => activity.activityId)).size).toBe(2);
    expect(recorder.snapshot().toolUses.map((use) => use.id)).not.toContain(null);
  });

  it('keeps one identity across updates and completion of a use without an upstream id', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context: runnerCallBase,
      onEvent: (event) => events.push(event),
    });
    recorder.toolUseDelta({ toolUseId: null, name: 'Read', inputDelta: '', stage: 'started' });
    recorder.toolUseDelta({
      toolUseId: null,
      name: 'Read',
      inputDelta: '{"file_path":"src/first.ts"}',
      stage: 'delta',
    });
    recorder.toolUseDone({
      toolUse: { id: null, name: 'Read', input: { file_path: 'src/first.ts' }, output: null },
    });
    const activities = events.flatMap((event, index) => {
      const activity = projectRunnerCallActivity(event, index, '/project');
      return activity === null ? [] : [activity];
    });
    expect(activities).toHaveLength(3);
    expect(new Set(activities.map((activity) => activity.activityId)).size).toBe(1);
    expect(recorder.snapshot().toolUses[0]?.id).not.toBeNull();
  });

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
        runnerToolUse({
          name: 'glob',
          inputDelta: '{"targetDirectory":"/project","globPattern":"biome.json*"}',
        }),
        1,
        '/project',
      ),
    ).toMatchObject({ kind: 'glob', label: 'matching biome.json*', target: 'biome.json*' });
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
    ).toMatchObject({ kind: 'warning', label: 'warning' });
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

  it.each<[string, Record<string, unknown>, string]>([
    ['Read', { file_path: 'src/app.ts', offset: 120, limit: 40 }, 'src/app.ts :120-159'],
    ['Read', { file_path: 'src/app.ts', limit: 40 }, 'src/app.ts :1-40'],
    ['Read', { file_path: 'src/app.ts', offset: 250 }, 'src/app.ts :250-end'],
    ['read', { path: 'biome.json', offset: 70 }, 'biome.json :70-end'],
    ['read', { path: 'biome.json', offset: 39, limit: 20 }, 'biome.json :39-58'],
    ['read_file', { Path: '/project/src/app.ts', StartLine: 1, EndLine: 40 }, 'src/app.ts :1-40'],
    ['read_file', { Path: '/project/src/app.ts', EndLine: 40 }, 'src/app.ts :1-40'],
    [
      'read_file',
      { Path: '/project/src/app.ts', StartLine: 10, EndLine: 40, limit: 5 },
      'src/app.ts :10-40',
    ],
  ])('names the lines that a %s read asks for', (name, input, target) => {
    expect(
      projectRunnerCallActivity(
        runnerToolUse({ name, inputDelta: JSON.stringify(input) }),
        1,
        '/project',
      ),
    ).toMatchObject({ kind: 'read', label: `reading ${target}`, target });
  });

  it('names only the path of a read that asks for no valid lines', () => {
    const inputs: ReadonlyArray<Record<string, unknown>> = [
      { file_path: 'src/app.ts' },
      { file_path: 'src/app.ts', offset: 0 },
      { file_path: 'src/app.ts', offset: -5 },
      { file_path: 'src/app.ts', offset: '12' },
      { file_path: 'src/app.ts', offset: 1.5 },
      { file_path: 'src/app.ts', limit: 0 },
    ];
    for (const input of inputs) {
      expect(
        projectRunnerCallActivity(
          runnerToolUse({ name: 'Read', inputDelta: JSON.stringify(input) }),
          1,
          '/project',
        ),
      ).toMatchObject({ kind: 'read', label: 'reading src/app.ts', target: 'src/app.ts' });
    }
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['Edit', { file_path: 'src/app.ts', new_string: 'one\ntwo\nthree' }, 'src/app.ts · 3 lines'],
    ['Edit', { file_path: 'src/app.ts', new_string: 'one\n' }, 'src/app.ts · 1 line'],
    ['Edit', { file_path: 'src/app.ts', new_string: 'one\ntwo' }, 'src/app.ts · 2 lines'],
    ['Edit', { file_path: 'src/app.ts', new_string: 'one\ntwo\n' }, 'src/app.ts · 2 lines'],
    ['Edit', { file_path: 'src/app.ts', new_string: 'one\n\ntwo' }, 'src/app.ts · 3 lines'],
    ['Edit', { file_path: 'src/app.ts', new_string: '   ' }, 'src/app.ts · 1 line'],
    ['Edit', { file_path: 'src/app.ts', new_string: '\n' }, 'src/app.ts · 1 line'],
    ['Write', { file_path: 'src/app.ts', content: 'one\ntwo\nthree\n' }, 'src/app.ts · 3 lines'],
    ['edit', { path: 'src/app.ts', streamContent: 'one\n\ntwo' }, 'src/app.ts · 3 lines'],
    [
      'edit_file',
      { file_path: 'src/app.ts', old_string: 'a', new_string: 'one\ntwo\nthree' },
      'src/app.ts · 3 lines',
    ],
    ['write_file', { file_path: 'src/app.ts', content: 'one\n' }, 'src/app.ts · 1 line'],
  ])('counts the lines that a %s edit writes', (name, input, target) => {
    expect(
      projectRunnerCallActivity(
        runnerToolUse({ name, inputDelta: JSON.stringify(input) }),
        1,
        '/project',
      ),
    ).toMatchObject({ kind: 'write', label: `editing ${target}`, target });
  });

  it('names only the path of an edit with no new text', () => {
    const cases: ReadonlyArray<{ name: string; input: Record<string, unknown> }> = [
      { name: 'Edit', input: { file_path: 'src/app.ts', new_string: '' } },
      { name: 'Write', input: { file_path: 'src/app.ts', content: '' } },
      { name: 'edit', input: { path: 'src/app.ts', streamContent: '' } },
      {
        name: 'MultiEdit',
        input: { file_path: 'src/app.ts', edits: [{ new_string: 'one\ntwo\nthree' }] },
      },
      { name: 'edit_file', input: { Path: '/project/src/app.ts' } },
    ];
    for (const { name, input } of cases) {
      expect(
        projectRunnerCallActivity(
          runnerToolUse({ name, inputDelta: JSON.stringify(input) }),
          1,
          '/project',
        ),
      ).toMatchObject({ kind: 'write', label: 'editing src/app.ts', target: 'src/app.ts' });
    }
  });

  it('labels the Path input of Antigravity read_file, edit_file and write_file with the path and the lines', () => {
    expect(
      projectRunnerCallActivity(
        runnerToolUse({
          name: 'read_file',
          inputDelta: '{"Path":"/project/src/app.ts","StartLine":1,"EndLine":40}',
        }),
        1,
        '/project',
      ),
    ).toMatchObject({
      kind: 'read',
      label: 'reading src/app.ts :1-40',
      target: 'src/app.ts :1-40',
    });
    for (const name of ['edit_file', 'write_file']) {
      expect(
        projectRunnerCallActivity(
          runnerToolUse({ name, inputDelta: '{"Path":"/project/src/app.ts"}' }),
          1,
          '/project',
        ),
      ).toMatchObject({ kind: 'write', label: 'editing src/app.ts', target: 'src/app.ts' });
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
    expect(activity).not.toHaveProperty('description');
    expect(activity?.label).not.toContain('prompt');
    expect(activity?.label).not.toContain('explore');
    expect(activity?.label).not.toContain('abcdefghijklmnopqrstuvwxyz');

    const explore = projectRunnerCallActivity(
      runnerToolUse({ name: 'Explore', inputDelta: '{"description":"files"}' }),
      1,
      '/project',
    );
    expect(explore).toMatchObject({ label: 'tool Explore' });
    expect(explore).not.toHaveProperty('description');
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

  it('names command activity while its input is incomplete', () => {
    expect(
      projectRunnerCallActivity(
        runnerToolUse({ name: 'Bash', inputDelta: '{"command":' }),
        1,
        '/project',
      ),
    ).toMatchObject({ kind: 'command', label: 'running command' });
  });

  it('keeps the description that a tool gives for a command', () => {
    const command = 'grep -c action src && git diff --name-only';
    const description = 'Count the action flags and show the changed files';
    for (const name of ['Bash', 'Shell']) {
      const activity = projectRunnerCallActivity(
        runnerToolUse({ name, inputDelta: JSON.stringify({ command, description }) }),
        1,
        '/project',
      );
      expect(activity).toMatchObject({
        kind: 'command',
        label: `running ${command}`,
        target: command,
        description,
        redacted: false,
      });
      expect(activity).not.toHaveProperty('moreLines');
    }

    const secret = 'sk-abcdefghijklmnopqrst';
    const redacted = projectRunnerCallActivity(
      runnerToolUse({
        name: 'Bash',
        inputDelta: JSON.stringify({
          command: 'npm test',
          description: `Count ${secret} files`,
        }),
      }),
      1,
      '/project',
    );
    expect(redacted).toMatchObject({
      kind: 'command',
      description: 'Count sk-***REDACTED*** files',
      redacted: true,
      target: 'npm test',
    });
    expect(redacted).not.toHaveProperty('moreLines');
    expect(redacted?.description).not.toContain('abcdefghijklmnopqrst');

    const longDescription = 'd'.repeat(600);
    const longActivity = projectRunnerCallActivity(
      runnerToolUse({
        name: 'Bash',
        inputDelta: JSON.stringify({ command: 'npm test', description: longDescription }),
      }),
      1,
      '/project',
    );
    expect(longActivity?.description).toHaveLength(512);
    expect(longActivity?.description?.endsWith('…')).toBe(true);
    expect(
      EngineEventSchema.safeParse({
        ...runnerCallBase,
        ...longActivity,
        type: 'runner_call_activity',
        phase: 'implementing',
        sequence: 1,
      }).success,
    ).toBe(true);
  });

  it.each<[string, string, string, number | undefined]>([
    ['Bash', 'cat a.ts\nsed b.ts\ncat c.ts', 'cat a.ts', 2],
    ['command_execution', "/bin/zsh -lc 'cat a.ts\nsed b.ts'", 'cat a.ts', 1],
    ['Bash', "cat <<'EOF'\nfirst\nsecond\nEOF", "cat <<'EOF'", 3],
    ['Bash', '\n  cd src  \n   \n  ls  \n', 'cd src', 1],
    ['Bash', 'npm test', 'npm test', undefined],
    ['Bash', "/bin/zsh -lc 'npm test'", "/bin/zsh -lc 'npm test'", undefined],
  ])(
    'names the first line of a script and counts the other lines',
    (name, command, target, moreLines) => {
      const activity = projectRunnerCallActivity(
        runnerToolUse({ name, inputDelta: JSON.stringify({ command }) }),
        1,
        '/project',
      );
      expect(activity).toMatchObject({
        kind: 'command',
        target,
        label: `running ${command.replace(/\s+/g, ' ').trim()}`,
      });
      if (moreLines === undefined) {
        expect(activity).not.toHaveProperty('moreLines');
      } else {
        expect(activity).toMatchObject({ moreLines });
      }
    },
  );

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
      target: prefix.trim(),
      moreLines: 1,
    });
    expect(activity?.label).toContain('sk-***REDACTED***');
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
      label: 'timeout',
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
      label: 'warning',
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

  it('keeps a known target across malformed and targetless tool fragments', () => {
    const callId = 'retain-call';
    const toolUseId = 'tool-read';
    const project = (inputDelta: string, sequence: number, name: string | null = 'Read') =>
      projectRunnerCallActivity(
        runnerToolUse({ callId, toolUseId, name, inputDelta }),
        sequence,
        '/project',
      );

    expect(project('{"file_path":"/project/src/app.ts"}', 1)).toMatchObject({
      activityId: 'retain-call:tool:tool-read',
      stage: 'updated',
      kind: 'read',
      label: 'reading src/app.ts',
      target: 'src/app.ts',
      redacted: false,
    });
    expect(project('{"file_path":', 2)).toMatchObject({
      activityId: 'retain-call:tool:tool-read',
      stage: 'updated',
      kind: 'read',
      label: 'reading src/app.ts',
      target: 'src/app.ts',
    });
    expect(project('', 3)).toMatchObject({
      activityId: 'retain-call:tool:tool-read',
      stage: 'started',
      kind: 'read',
      label: 'reading src/app.ts',
      target: 'src/app.ts',
    });
    expect(project('{"description":"later"}', 4)).toMatchObject({
      activityId: 'retain-call:tool:tool-read',
      stage: 'updated',
      kind: 'read',
      label: 'reading src/app.ts',
      target: 'src/app.ts',
    });
    expect(project('', 5, null)).toMatchObject({
      activityId: 'retain-call:tool:tool-read',
      stage: 'started',
      kind: 'read',
      label: 'reading src/app.ts',
      target: 'src/app.ts',
    });
    expect(project('{"file_path":"src/next.ts"}', 6)).toMatchObject({
      activityId: 'retain-call:tool:tool-read',
      stage: 'updated',
      kind: 'read',
      label: 'reading src/next.ts',
      target: 'src/next.ts',
    });
    expect(project('{"file_path":', 7)).toMatchObject({
      label: 'reading src/next.ts',
      target: 'src/next.ts',
    });
  });

  it('keeps a known subagent target while Task and Agent input streams', () => {
    const callId = 'task-retain-call';
    const rootDir = '/project';

    for (const name of ['Task', 'Agent']) {
      const toolUseId = `tool-${name}`;
      const project = (inputDelta: string) =>
        projectRunnerCallActivity(
          runnerToolUse({ callId, toolUseId, name, inputDelta }),
          1,
          rootDir,
        );

      expect(project(JSON.stringify({ subagent_type: 'Explore' }))).toMatchObject({
        kind: 'task',
        label: 'task Explore',
        target: 'Explore',
      });
      expect(project('{"prompt":')).toMatchObject({
        kind: 'task',
        label: 'task Explore',
        target: 'Explore',
      });
      expect(project('')).toMatchObject({
        kind: 'task',
        label: 'task Explore',
        target: 'Explore',
      });
    }

    const bare = projectRunnerCallActivity(
      runnerToolUse({
        callId,
        toolUseId: 'tool-bare-task',
        name: 'Task',
        inputDelta: '{"prompt":"inspect the files"}',
      }),
      2,
      rootDir,
    );
    expect(bare).toMatchObject({ kind: 'task', label: 'task Task' });
    expect(bare?.target).toBeUndefined();

    expect(
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          callId,
          type: 'call_tool_use_done',
          channel: 'tool',
          toolUse: {
            id: 'tool-Task',
            name: 'Task',
            input: { subagent_type: 'general', prompt: 'inspect the files' },
          },
        },
        3,
        rootDir,
      ),
    ).toMatchObject({
      stage: 'completed',
      kind: 'task',
      label: 'task general',
      target: 'general',
    });
  });

  it('keeps the sanitized command when a later fragment has no target', () => {
    const callId = 'redact-call';
    const toolUseId = 'tool-bash';
    const secret = 'sk-abcdefghijklmnopqrst';
    const redacted = 'echo sk-***REDACTED***';
    const command = (inputDelta: string) =>
      projectRunnerCallActivity(
        runnerToolUse({ callId, toolUseId, name: 'Bash', inputDelta }),
        1,
        '/project',
      );

    expect(command(JSON.stringify({ command: `echo ${secret}` }))).toMatchObject({
      kind: 'command',
      label: `running ${redacted}`,
      target: redacted,
      redacted: true,
    });
    const fragment = command(`{"command":"echo ${secret}`);
    expect(fragment).toMatchObject({
      kind: 'command',
      label: `running ${redacted}`,
      target: redacted,
      redacted: true,
    });
    expect(fragment?.label).not.toContain(secret);
    expect(fragment?.target).not.toContain('abcdefghijklmnopqrst');

    expect(command(JSON.stringify({ command: 'npm test' }))).toMatchObject({
      kind: 'command',
      label: 'running npm test',
      target: 'npm test',
      redacted: false,
    });
    expect(command('{"command":')).toMatchObject({
      kind: 'command',
      label: 'running npm test',
      target: 'npm test',
      redacted: false,
    });
  });

  it('keeps the description and the line count of a command when a later fragment has no input', () => {
    const callId = 'command-description-call';
    const toolUseId = 'tool-bash';
    const secret = 'sk-abcdefghijklmnopqrst';
    const description = `Count ${secret} files`;
    const sanitized = 'Count sk-***REDACTED*** files';
    const command = 'cat a.ts\nsed b.ts\ncat c.ts';
    const project = (inputDelta: string) =>
      projectRunnerCallActivity(
        runnerToolUse({ callId, toolUseId, name: 'Bash', inputDelta }),
        1,
        '/project',
      );

    expect(project(JSON.stringify({ command, description }))).toMatchObject({
      kind: 'command',
      label: 'running cat a.ts sed b.ts cat c.ts',
      target: 'cat a.ts',
      moreLines: 2,
      description: sanitized,
      redacted: true,
    });
    const fragment = project('');
    expect(fragment).toMatchObject({
      kind: 'command',
      stage: 'started',
      label: 'running cat a.ts sed b.ts cat c.ts',
      target: 'cat a.ts',
      moreLines: 2,
      description: sanitized,
      redacted: true,
    });
    expect(fragment?.description).not.toContain('abcdefghijklmnopqrst');
    expect(fragment?.label).not.toContain('abcdefghijklmnopqrst');
    expect(project('{"command":')).toMatchObject({
      kind: 'command',
      label: 'running cat a.ts sed b.ts cat c.ts',
      target: 'cat a.ts',
      moreLines: 2,
      description: sanitized,
      redacted: true,
    });
  });

  it('keeps activity targets isolated by call and by tool use', () => {
    const call = (callId: string, toolUseId: string, name: string, inputDelta: string) =>
      projectRunnerCallActivity(
        runnerToolUse({ callId, toolUseId, name, inputDelta }),
        1,
        '/project',
      );

    expect(call('call-a', 'tool-1', 'Read', '{"file_path":"src/a.ts"}')).toMatchObject({
      target: 'src/a.ts',
    });
    expect(call('call-a', 'tool-2', 'Bash', '{"command":"npm test"}')).toMatchObject({
      kind: 'command',
      target: 'npm test',
    });
    expect(call('call-b', 'tool-1', 'Read', '{"file_path":"src/b.ts"}')).toMatchObject({
      target: 'src/b.ts',
    });

    expect(call('call-a', 'tool-1', 'Read', '{"file_path":')).toMatchObject({
      activityId: 'call-a:tool:tool-1',
      kind: 'read',
      label: 'reading src/a.ts',
      target: 'src/a.ts',
    });
    expect(call('call-a', 'tool-2', 'Bash', '')).toMatchObject({
      activityId: 'call-a:tool:tool-2',
      stage: 'started',
      kind: 'command',
      label: 'running npm test',
      target: 'npm test',
    });
    expect(call('call-b', 'tool-1', 'Read', '{"description":"no path"}')).toMatchObject({
      activityId: 'call-b:tool:tool-1',
      kind: 'read',
      label: 'reading src/b.ts',
      target: 'src/b.ts',
    });
  });

  it('does not share a target across tool uses that have no id', () => {
    const callId = 'null-id-call';
    const first = projectRunnerCallActivity(
      runnerToolUse({
        callId,
        toolUseId: null,
        inputDelta: '{"file_path":"src/a.ts"}',
      }),
      4,
      '/project',
    );
    const second = projectRunnerCallActivity(
      runnerToolUse({
        callId,
        toolUseId: null,
        inputDelta: '{"file_path":',
      }),
      9,
      '/project',
    );

    expect(first).toMatchObject({
      activityId: 'null-id-call:tool:4',
      kind: 'read',
      label: 'reading src/a.ts',
      target: 'src/a.ts',
    });
    expect(second).toMatchObject({
      activityId: 'null-id-call:tool:9',
      kind: 'read',
      label: 'reading file',
    });
    expect(second?.target).toBeUndefined();
    expect(second?.activityId).not.toBe(first?.activityId);
  });

  it('projects completion from the tool input and then releases that tool use', () => {
    const callId = 'completion-call';
    const rootDir = '/project';
    const delta = (toolUseId: string, inputDelta: string, name = 'Read') =>
      projectRunnerCallActivity(runnerToolUse({ callId, toolUseId, name, inputDelta }), 1, rootDir);
    const done = (toolUseId: string, input: Record<string, unknown>) =>
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          callId,
          type: 'call_tool_use_done',
          channel: 'tool',
          toolUse: { id: toolUseId, name: 'Read', input },
        },
        2,
        rootDir,
      );

    expect(delta('tool-done', '{"file_path":"src/stream.ts"}')).toMatchObject({
      target: 'src/stream.ts',
    });
    expect(delta('tool-keep', '{"command":"npm test"}', 'Bash')).toMatchObject({
      target: 'npm test',
    });
    expect(done('tool-done', { file_path: 'src/final.ts' })).toMatchObject({
      activityId: 'completion-call:tool:tool-done',
      stage: 'completed',
      kind: 'read',
      label: 'reading src/final.ts',
      target: 'src/final.ts',
    });
    const forgotten = delta('tool-done', '{"file_path":');
    expect(forgotten).toMatchObject({ kind: 'read', label: 'reading file' });
    expect(forgotten?.target).toBeUndefined();
    expect(delta('tool-keep', '{"command":', 'Bash')).toMatchObject({
      kind: 'command',
      label: 'running npm test',
      target: 'npm test',
    });

    expect(delta('tool-blank', '{"file_path":"src/stream.ts"}')).toMatchObject({
      target: 'src/stream.ts',
    });
    const blank = done('tool-blank', {});
    expect(blank).toMatchObject({ kind: 'read', label: 'reading file' });
    expect(blank?.target).toBeUndefined();
    expect(delta('tool-blank', '{"file_path":')?.target).toBeUndefined();
  });

  it('releases every tool target when the call ends', () => {
    const rootDir = '/project';
    const remember = (callId: string, toolUseId: string, file: string) => {
      expect(
        projectRunnerCallActivity(
          runnerToolUse({
            callId,
            toolUseId,
            inputDelta: JSON.stringify({ file_path: file }),
          }),
          1,
          rootDir,
        )?.target,
      ).toBe(file);
    };
    const rememberedTarget = (callId: string, toolUseId: string) =>
      projectRunnerCallActivity(
        runnerToolUse({ callId, toolUseId, inputDelta: '{"file_path":' }),
        2,
        rootDir,
      )?.target;

    remember('completed-call', 'tool-1', 'src/one.ts');
    remember('completed-call', 'tool-2', 'src/two.ts');
    remember('live-call', 'tool-1', 'src/live.ts');
    expect(
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          callId: 'completed-call',
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
        3,
        rootDir,
      ),
    ).toBeNull();
    expect(rememberedTarget('completed-call', 'tool-1')).toBeUndefined();
    expect(rememberedTarget('completed-call', 'tool-2')).toBeUndefined();
    expect(rememberedTarget('live-call', 'tool-1')).toBe('src/live.ts');

    remember('failed-call', 'tool-1', 'src/bad.ts');
    expect(
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          callId: 'failed-call',
          type: 'call_error',
          status: 'timeout',
          error: { code: 'timeout', message: 'runner timed out' },
          startedAt: 1_000,
          endedAt: 2_000,
          durationMs: 1_000,
          partial: true,
          usage: null,
          nativeSessionId: null,
        },
        4,
        rootDir,
      ),
    ).toMatchObject({ activityId: 'failed-call:terminal', kind: 'error' });
    expect(rememberedTarget('failed-call', 'tool-1')).toBeUndefined();
    expect(rememberedTarget('live-call', 'tool-1')).toBe('src/live.ts');
  });

  it('keeps every tool target when the call starts', () => {
    const rootDir = '/project';
    const remember = (toolUseId: string, file: string) =>
      projectRunnerCallActivity(
        runnerToolUse({
          callId: 'started-call',
          toolUseId,
          inputDelta: JSON.stringify({ file_path: file }),
        }),
        1,
        rootDir,
      );
    remember('tool-1', 'src/one.ts');
    remember('tool-2', 'src/two.ts');
    const rememberedTarget = (toolUseId: string) =>
      projectRunnerCallActivity(
        runnerToolUse({ callId: 'started-call', toolUseId, inputDelta: '{"file_path":' }),
        3,
        rootDir,
      )?.target;

    expect(
      projectRunnerCallActivity(
        { ...runnerCallBase, callId: 'started-call', type: 'call_started' },
        2,
        rootDir,
      ),
    ).toBeNull();
    expect(rememberedTarget('tool-1')).toBe('src/one.ts');
    expect(rememberedTarget('tool-2')).toBe('src/two.ts');
  });
});
