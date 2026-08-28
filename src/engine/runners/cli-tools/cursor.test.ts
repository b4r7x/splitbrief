import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toTokenDelta } from '../../calls/usage.js';
import {
  CLI_TOOL_CATALOG,
  CURSOR_CLI_ADMISSION_VERDICT,
} from '../../../core/runners/cli-tool-catalog.js';
import { isRecord } from '../../../utils/type-guards.js';
import { CLI_PROMPT_SENTINEL } from './candidate-contract.js';
import {
  CLI_CONFORMANCE_CANDIDATES,
  cursorImplementerAdapter,
  cursorPlannerAdapter,
  cursorProtocolEvents,
} from './cursor.js';

const PROMPT = CLI_PROMPT_SENTINEL;
const WRITE_ENABLING_FLAGS = ['--force', '--yolo', '-f'] as const;
const STREAM_JSON_FIXTURE = join(
  import.meta.dirname,
  '../../../../testing/fixtures/cursor/stream-json-plan.txt',
);

function plannerArgs(mode: 'plan' | 'escalate', configuredArgs: readonly string[] = []) {
  return cursorPlannerAdapter.buildArgs({
    prompt: PROMPT,
    model: undefined,
    projectDir: '/project',
    configuredArgs,
    mode,
    sessionId: null,
    effort: undefined,
  });
}

function implementerArgs(configuredArgs: readonly string[] = []) {
  return cursorImplementerAdapter.buildArgs({
    prompt: PROMPT,
    model: undefined,
    projectDir: '/staged',
    configuredArgs,
  });
}

function fixtureNdjsonLines(): readonly string[] {
  return readFileSync(STREAM_JSON_FIXTURE, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'));
}

function fixtureEvents() {
  return fixtureNdjsonLines().flatMap((line) => [...cursorProtocolEvents(line)]);
}

function terminalOf(events: ReturnType<typeof cursorProtocolEvents>) {
  return cursorPlannerAdapter.terminal({
    outputContract: cursorPlannerAdapter.outputContract,
    events,
    stderr: '',
    exitCode: 0,
    signal: null,
  });
}

describe('Cursor CLI', () => {
  it('is admitted as an active CLI tool', () => {
    expect(CURSOR_CLI_ADMISSION_VERDICT).toBe('PASS');
    expect(CLI_TOOL_CATALOG.cursor.admission.state).toBe('active');
    expect(CLI_TOOL_CATALOG.cursor).toMatchObject({
      id: 'cursor',
      displayName: 'Cursor Agent CLI',
      command: 'cursor-agent',
      executableAliases: ['cursor-agent', 'agent'],
      category: 'cli',
    });
  });
});

describe('Cursor role adapters', () => {
  it('exports planner then implementer candidates with matching canonical hashes', () => {
    expect(CLI_CONFORMANCE_CANDIDATES).toHaveLength(2);
    expect(CLI_CONFORMANCE_CANDIDATES.map((candidate) => candidate.role)).toEqual([
      'planner',
      'implementer',
    ]);
    for (const candidate of CLI_CONFORMANCE_CANDIDATES) {
      expect(candidate.id).toBe('cursor');
      expect(candidate.rawContract.id).toBe(candidate.id);
      expect(candidate.rawContract.role).toBe(candidate.role);
      expect(candidate.rawContract.promptTransport).toBe('argv');
      expect(candidate.rawContract.rawInvocation.filter((arg) => arg === PROMPT)).toHaveLength(1);
      expect(candidate.contractSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(candidate.adapter.role).toBe(candidate.role);
      expect(candidate.adapter.descriptor).toBe(CLI_TOOL_CATALOG.cursor);
    }
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.contractSha256).not.toBe(
      CLI_CONFORMANCE_CANDIDATES[1]?.contractSha256,
    );
  });

  it('planner args never contain a write-enabling flag', () => {
    const args = plannerArgs('plan');
    expect(args).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--mode',
      'plan',
      '--trust',
      PROMPT,
    ]);
    expect(args).toContain('--trust');
    for (const flag of WRITE_ENABLING_FLAGS) {
      expect(args).not.toContain(flag);
    }
    expect(implementerArgs()).toContain('--trust');
  });

  it('escalate planner args contain --force and not --mode plan', () => {
    const args = plannerArgs('escalate');
    expect(args).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--force',
      '--trust',
      PROMPT,
    ]);
  });

  it('user args cannot inject a protected flag', () => {
    const plannerBase = plannerArgs('plan');
    const implementerBase = implementerArgs();
    expect(
      cursorPlannerAdapter.validateArgs({
        invocationArgs: [...plannerBase, '--force'],
        baseArgs: plannerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['--force'] });
    expect(
      cursorPlannerAdapter.validateArgs({
        invocationArgs: [...plannerBase, '--yolo'],
        baseArgs: plannerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['--yolo'] });
    expect(
      cursorPlannerAdapter.validateArgs({
        invocationArgs: [...plannerBase, '--trust'],
        baseArgs: plannerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['--trust'] });
    expect(
      cursorImplementerAdapter.validateArgs({
        invocationArgs: [...implementerBase, '--trust'],
        baseArgs: implementerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['--trust'] });
    expect(
      cursorImplementerAdapter.validateArgs({
        invocationArgs: [...implementerBase, '--mode', 'ask'],
        baseArgs: implementerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['--mode'] });
    expect(
      cursorImplementerAdapter.validateArgs({
        invocationArgs: [...implementerBase, '-f'],
        baseArgs: implementerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['-f'] });
    expect(
      cursorImplementerAdapter.validateArgs({
        invocationArgs: [...implementerBase, '--workspace', '/tmp/other'],
        baseArgs: implementerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['--workspace'] });
    expect(
      cursorImplementerAdapter.validateArgs({
        invocationArgs: [...implementerBase, '--worktree', '/tmp/other'],
        baseArgs: implementerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['--worktree'] });
    expect(
      cursorImplementerAdapter.validateArgs({
        invocationArgs: [...implementerBase, '--auto-review'],
        baseArgs: implementerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['--auto-review'] });
    expect(
      cursorImplementerAdapter.validateArgs({
        invocationArgs: [...implementerBase, '--header', 'X-Test: 1'],
        baseArgs: implementerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['--header'] });
    expect(
      cursorImplementerAdapter.validateArgs({
        invocationArgs: [...implementerBase, '-H', 'X-Test: 1'],
        baseArgs: implementerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['-H'] });
    expect(
      cursorImplementerAdapter.validateArgs({
        invocationArgs: [...implementerBase, '-HX-Test:1'],
        baseArgs: implementerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['-H'] });
  });

  it('retains explicit failure terminals and malformed JSON', () => {
    const isError = cursorProtocolEvents(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'request failed',
      }),
    );
    expect(isError.at(-1)).toMatchObject({
      type: 'result',
      status: 'failed',
      error: { code: 'cursor-result-failed', message: 'request failed' },
    });

    const nonSuccessSubtype = cursorProtocolEvents(
      JSON.stringify({ type: 'result', subtype: 'error', result: 'request failed' }),
    );
    expect(nonSuccessSubtype.at(-1)).toMatchObject({
      type: 'result',
      status: 'failed',
      error: { code: 'cursor-result-failed', message: 'request failed' },
    });

    const malformed = cursorProtocolEvents('{not-json');
    expect(malformed).toHaveLength(1);
    expect(malformed[0]).toMatchObject({
      type: 'result',
      status: 'failed',
      error: { code: 'malformed-cursor-json', message: 'Cursor emitted malformed JSON' },
    });
  });

  it('stream-json fixture maps to a terminal result event', () => {
    const terminal = terminalOf(fixtureEvents());
    expect(terminal).toMatchObject({
      type: 'result',
      status: 'completed',
      text: 'Hello. How can I help you today?',
      nativeSessionId: '2e9f4f6e-784f-453b-bf0f-3163f1b4ec29',
      error: null,
      partial: false,
    });
  });

  it('usage maps to a TokenDelta', () => {
    const resultLine = fixtureNdjsonLines().find((line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return false;
      }
      return isRecord(value) && value.type === 'result';
    });
    expect(resultLine).toBeDefined();
    if (resultLine === undefined) return;

    const record: unknown = JSON.parse(resultLine);
    expect(isRecord(record) && isRecord(record.usage)).toBe(true);
    if (!isRecord(record) || !isRecord(record.usage)) return;

    const expected = toTokenDelta(record.usage);
    expect(expected).not.toBeNull();
    const events = cursorProtocolEvents(resultLine);
    expect(events).toContainEqual({ type: 'usage', usage: expected, semantics: 'final' });
    expect(terminalOf(events).usage).toEqual(expected);
  });
});
