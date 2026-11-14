import { describe, expect, it } from 'vitest';
import { projectRunnerCallActivity } from '../../../../engine/calls/activity/project.js';
import { normalizeRunnerCallWarning } from '../../../../engine/calls/warnings.js';
import { parseOpencodeLine } from '../../../../engine/streaming/parse/opencode.js';
import {
  cleanRunnerActivityText,
  runnerActivityDiagnosticPreview,
  runnerActivityLedgerItem,
} from './ledger-item.js';
import type { RunnerActivityDisplayInput } from './types.js';

describe('runnerActivityLedgerItem', () => {
  it('hides internal interruption codes from compact activity', () => {
    expect(
      runnerActivityLedgerItem({
        stage: 'aborted',
        kind: 'error',
        label: 'aborted runner_interrupted',
        diagnosticPartial: 'cancelled',
      }),
    ).toMatchObject({
      label: 'STOP',
      value: 'current turn interrupted: cancelled',
      diagnosticPreview: 'cancelled',
      tone: 'warning',
      valueTone: 'warning',
      severity: 'warning',
    });
  });

  it('tags no stopped call as raw, though its partial output is kept', () => {
    expect(
      runnerActivityLedgerItem({
        stage: 'aborted',
        kind: 'error',
        label: 'aborted runner_interrupted',
        diagnosticPartial: 'stopped by you',
        rawAvailable: true,
      }),
    ).toMatchObject({
      label: 'STOP',
      value: 'current turn interrupted: stopped by you',
      rawMarker: null,
    });
  });

  it('prettifies recognized shell reads, searches, and listings out of RUN commands', () => {
    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'command',
        label: "running sed -n '1,240p' CLAUDE.md",
        target: "sed -n '1,240p' CLAUDE.md",
      }),
    ).toMatchObject({ label: 'READ', value: 'CLAUDE.md :1-240', fitMode: 'start' });

    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'unknown',
        label: '/bin/zsh -lc "rg -n deriveLiveStatus src"',
      }),
    ).toMatchObject({ label: 'FIND', value: '"deriveLiveStatus"  src' });

    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'command',
        label: 'running ls src/features',
        target: 'ls src/features',
      }),
    ).toMatchObject({ label: 'LIST', value: 'src/features', fitMode: 'start' });
  });

  // Review render (red gate, 60 columns): a prose READ cut from the left read
  // `…ing the typecheck failure and the pending input`.
  it('keeps the head of a prose value under a file label and the tail of a path', () => {
    const read = (label: string) =>
      runnerActivityLedgerItem({ stage: 'completed', kind: 'read', label })?.fitMode;

    expect(read('Reading the typecheck failure and the pending input')).toBe('end');
    expect(read('reading src/features/workflow/display/flow.tsx')).toBe('start');
    expect(read('reading /Users/me/My Projects/a.ts')).toBe('start');
  });

  it('keeps compound or unrecognized commands as raw RUN', () => {
    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'command',
        label: 'running cat a.ts && cat b.ts',
        target: 'cat a.ts && cat b.ts',
      }),
    ).toMatchObject({ label: 'RUN', value: 'cat a.ts && cat b.ts', fitMode: 'middle' });

    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'command',
        label: 'running wc -l CLAUDE.md',
        target: 'wc -l CLAUDE.md',
      }),
    ).toMatchObject({ label: 'RUN', value: 'wc -l CLAUDE.md' });
  });

  it.each<{
    case: string;
    input: RunnerActivityDisplayInput;
    expected: { label: string; value: string; fitMode: 'end' | 'middle' | 'start' };
  }>([
    {
      case: 'described compound grep',
      input: {
        stage: 'updated',
        kind: 'command',
        label: 'tool Shell',
        target: 'grep -c action src && git diff --name-only',
        description: 'Count the action flags and show the changed files',
      },
      expected: {
        label: 'RUN',
        value: 'Count the action flags and show the changed files',
        fitMode: 'end',
      },
    },
    {
      case: 'cat script',
      input: {
        stage: 'updated',
        kind: 'command',
        label: 'running cat a.ts',
        target: 'cat a.ts',
        moreLines: 2,
      },
      expected: { label: 'RUN', value: 'cat a.ts · +2 lines', fitMode: 'middle' },
    },
    {
      case: 'npx vitest run',
      input: {
        stage: 'updated',
        kind: 'command',
        label: 'running npx vitest run',
        target: 'npx vitest run',
        moreLines: 1,
      },
      expected: { label: 'RUN', value: 'npx vitest run · +1 line', fitMode: 'middle' },
    },
    {
      case: 'description over a script summary',
      input: {
        stage: 'updated',
        kind: 'command',
        label: 'tool Shell',
        target: 'cat a.ts',
        moreLines: 2,
        description: 'Show the two files',
      },
      expected: { label: 'RUN', value: 'Show the two files', fitMode: 'end' },
    },
    {
      case: 'described sed read',
      input: {
        stage: 'updated',
        kind: 'command',
        label: 'tool Shell',
        target: "sed -n '1,40p' CLAUDE.md",
        description: 'Read the rules',
      },
      expected: { label: 'READ', value: 'CLAUDE.md :1-40', fitMode: 'start' },
    },
  ])(
    'words a command row from its pretty form, its description or its first line: $case',
    ({ input, expected }) => {
      expect(runnerActivityLedgerItem(input)).toMatchObject(expected);
    },
  );

  it('keeps a single-line script as its command', () => {
    expect(
      runnerActivityLedgerItem({
        stage: 'completed',
        kind: 'command',
        label: "running /bin/zsh -lc 'npm test'",
        target: "/bin/zsh -lc 'npm test'",
      }),
    ).toMatchObject({ label: 'RUN', value: 'npm test', fitMode: 'middle' });
  });

  it('keeps the failure of a command with a description', () => {
    const command = "sed -n '1,40p' CLAUDE.md";
    const description = 'Read the rules';
    const failure = {
      stage: 'failed' as const,
      kind: 'command' as const,
      label: 'tool Shell',
      target: command,
      diagnosticPartial: 'Command failed',
    };
    const plain = runnerActivityLedgerItem(failure);
    const described = runnerActivityLedgerItem({ ...failure, description });

    expect(plain?.value).toBe('Command failed');
    expect(described?.value).toBe(plain?.value);
    expect(described).toMatchObject({ label: plain?.label, fitMode: plain?.fitMode });
    expect(
      runnerActivityLedgerItem({
        stage: 'aborted',
        kind: 'error',
        label: 'aborted runner_interrupted',
        diagnosticPartial: 'cancelled',
        description,
      })?.value,
    ).toBe('current turn interrupted: cancelled');
  });

  it('keeps every glob in a codex command with adjacent quoted segments', () => {
    const target = `/bin/zsh -lc "rg --files --hidden -g '"'!node_modules'"' -g '"'!.git'"' -g '"'!package-lock.json'"' -g '"'!yarn.lock'"' -g '"'!pnpm-lock.yaml'"'"`;

    expect(
      runnerActivityLedgerItem({
        stage: 'completed',
        kind: 'command',
        label: `running ${target}`,
        target,
      }),
    ).toMatchObject({
      label: 'RUN',
      value:
        "rg --files --hidden -g '!node_modules' -g '!.git' -g '!package-lock.json' -g '!yarn.lock' -g '!pnpm-lock.yaml'",
      fitMode: 'middle',
    });

    const quotedPath = String.raw`/bin/zsh -lc 'cat "src/loan'\''s"/renewals.ts'`;
    expect(
      runnerActivityLedgerItem({
        stage: 'completed',
        kind: 'command',
        label: `running ${quotedPath}`,
        target: quotedPath,
      }),
    ).toMatchObject({ label: 'READ', value: "src/loan's/renewals.ts" });
  });

  it('keeps the full unparseable wrapper as raw RUN', () => {
    const target = `/bin/zsh -lc "rg --files -g '"'!x`;

    expect(
      runnerActivityLedgerItem({
        stage: 'completed',
        kind: 'command',
        label: `running ${target}`,
        target,
      }),
    ).toMatchObject({ label: 'RUN', value: target, fitMode: 'middle' });
  });

  it.each([String.raw`bash -lc $'echo hi\nls'`, 'bash -lc $"echo hi"'])(
    'keeps unsupported wrapper quoting as raw RUN: %s',
    (target) => {
      expect(
        runnerActivityLedgerItem({ stage: 'completed', kind: 'tool', label: 'bash', target }),
      ).toMatchObject({ label: 'RUN', value: target, fitMode: 'middle' });
    },
  );

  it('displays an OpenCode bash tool command with nested quotes from its stream activity', () => {
    const target = `cat "src/loan's"/renewals.ts`;
    const parsed = parseOpencodeLine(
      JSON.stringify({
        type: 'tool_use',
        sessionID: 'ses-open',
        part: {
          type: 'tool',
          callID: 'bash_0',
          tool: 'bash',
          state: { status: 'completed', input: { command: target }, output: '' },
        },
      }),
    );
    const toolUse = parsed.toolUseDone?.[0];
    expect(toolUse).toEqual({ id: 'bash_0', name: 'bash', input: { command: target }, output: '' });
    if (toolUse === undefined) return;

    const activity = projectRunnerCallActivity(
      {
        type: 'call_tool_use_done',
        channel: 'tool',
        ts: 1_200,
        callId: 'call-open',
        role: 'implementer',
        backendKind: 'cli',
        runnerName: 'opencode',
        model: 'test-model',
        attempt: 0,
        toolUse: { ...toolUse, id: toolUse.id ?? null },
      },
      1,
      '/project',
    );
    expect(activity).toMatchObject({
      stage: 'completed',
      kind: 'command',
      label: `running ${target}`,
      target,
    });
    if (activity === null) return;

    expect(runnerActivityLedgerItem(activity)).toMatchObject({
      label: 'READ',
      value: "src/loan's/renewals.ts",
      fitMode: 'start',
    });
  });

  it('keeps a raw claude-code Bash target intact', () => {
    expect(
      runnerActivityLedgerItem({
        stage: 'completed',
        kind: 'tool',
        label: 'bash',
        target: 'rg -n "foo" src',
      }),
    ).toMatchObject({ label: 'CALL', value: 'rg -n "foo" src' });

    expect(
      runnerActivityLedgerItem({
        stage: 'completed',
        kind: 'command',
        label: 'bash',
        target: 'rg -n "foo" src',
      }),
    ).toMatchObject({ label: 'FIND', value: '"foo"  src' });

    expect(
      runnerActivityLedgerItem({
        stage: 'completed',
        kind: 'command',
        label: 'bash',
        target: `cat "src/loan's"/renewals.ts`,
      }),
    ).toMatchObject({ label: 'READ', value: "src/loan's/renewals.ts" });
  });

  it('shows the tool name for a task row that has no target', () => {
    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'task',
        label: 'task Task',
        description: 'explore the codebase',
      }),
    ).toMatchObject({ label: 'AGENT', value: 'Task' });
  });

  it('labels a subagent row Agent with the subagent name, and keeps Plan for a plan row', () => {
    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'task',
        label: 'task Explore',
        target: 'Explore',
      }),
    ).toMatchObject({ label: 'AGENT', value: 'Explore' });

    expect(
      runnerActivityLedgerItem({ stage: 'updated', kind: 'plan', label: 'plan steps' }),
    ).toMatchObject({ label: 'PLAN' });
  });

  it('keeps every word of a target that starts with a verb', () => {
    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'command',
        label: 'running task build',
        target: 'task build',
      }),
    ).toMatchObject({ label: 'RUN', value: 'task build' });

    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'command',
        label: 'running running tests',
        target: 'running tests',
      }),
    ).toMatchObject({ label: 'RUN', value: 'running tests' });

    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'search',
        label: 'searching task started',
        target: 'task started',
      }),
    ).toMatchObject({ label: 'FIND', value: 'task started' });

    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'read',
        label: 'reading task notes.md',
        target: 'task notes.md',
      }),
    ).toMatchObject({ label: 'READ', value: 'task notes.md' });
  });

  it('keeps real terminal failures distinct from interruption', () => {
    expect(
      runnerActivityLedgerItem({
        stage: 'timeout',
        kind: 'error',
        label: 'timeout command_timeout',
        diagnosticPartial: 'Command timed out',
      }),
    ).toMatchObject({
      label: 'ERR',
      value: 'Command timed out',
      diagnosticPreview: 'Command timed out',
      tone: 'error',
      valueTone: 'error',
      severity: 'error',
    });
  });

  it('shows a tool warning and failure as the tool message, without the code they carry', () => {
    const message = 'provider.quota: Insufficient Balance (request_id: c69db249)';
    const base = {
      ts: 1_200,
      callId: 'call-open',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'opencode',
      model: 'deepseek/deepseek-flash',
      attempt: 0,
    } as const;
    const warning = projectRunnerCallActivity(
      {
        ...base,
        type: 'call_warning',
        warning: normalizeRunnerCallWarning({ code: 'opencode-error', message }),
      },
      1,
      '/project',
    );
    const failure = projectRunnerCallActivity(
      {
        ...base,
        type: 'call_error',
        status: 'failed',
        error: { code: 'opencode-error', message },
        startedAt: 1_000,
        endedAt: 2_000,
        durationMs: 1_000,
        partial: true,
        usage: null,
        nativeSessionId: null,
      },
      2,
      '/project',
    );
    if (warning === null || failure === null) throw new Error('expected activity');

    expect(runnerActivityLedgerItem(warning)).toMatchObject({ label: 'WARN', value: message });
    expect(runnerActivityLedgerItem(failure)).toMatchObject({ label: 'ERR', value: message });
  });

  it('reads a stopped call as a stop, whatever its recorded label', () => {
    expect(
      runnerActivityLedgerItem({
        stage: 'aborted',
        kind: 'error',
        label: 'aborted',
        diagnosticPartial: 'stopped by you',
      }),
    ).toMatchObject({ label: 'STOP', value: 'current turn interrupted: stopped by you' });
  });
});

describe('runnerActivityDiagnosticPreview', () => {
  it('uses bounded sanitized diagnostics for warning and error activity', () => {
    const preview = runnerActivityDiagnosticPreview(
      {
        stage: 'warning',
        kind: 'warning',
        label: 'warning stderr',
        diagnosticPartial: 'stderr sk-abcdefghijklmnopqrstuvwxyz keeps going',
      },
      24,
    );

    expect(preview).toBe('stderr sk-***REDACTED**…');
  });

  it('falls back to textPartial when no diagnosticPartial is available', () => {
    expect(
      runnerActivityDiagnosticPreview({
        stage: 'warning',
        kind: 'warning',
        label: 'warning stderr',
        textPartial: 'stderr preview',
      }),
    ).toBe('stderr preview');
  });
});

describe('cleanRunnerActivityText', () => {
  it('sanitizes terminal controls, secrets, and internal runner interruption code', () => {
    expect(
      cleanRunnerActivityText(
        '\u001b[31mrunner_interrupted\u001b[0m sk-abcdefghijklmnopqrstuvwxyz',
      ),
    ).toBe('interrupted sk-***REDACTED***');
  });
});
