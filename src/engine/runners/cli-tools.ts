import type { ParsedLine } from './types.js';
import { confinedExists } from '../../lib/confined-fs.js';
import { parseJsonlLine } from '../streaming/parse-jsonl.js';
import { parseCopilotLine } from '../streaming/parse-copilot.js';
import { parseOpencodeLine } from '../streaming/parse-opencode.js';
import { parseTextLine } from '../streaming/parse-text.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import {
  CLI_TOOL_TRUST,
  type CliToolId,
  type RunnerRoleTrustMetadata,
} from '../../core/runners/cli-tool-catalog.js';
import type { InvokeResult } from './types.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import { CLI_TOOL_CATALOG } from '../../core/runners/cli-tool-catalog.js';
import type {
  CliImplementerAdapter,
  CliInvocation,
  CliPlannerAdapter,
  CliProtocolEvent,
} from './cli-tools/contract.js';
import { accumulateTokenUsage } from '../calls/usage.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import { RUNNER_IDLE_KILL_MS, RUNNER_IDLE_WARN_MS } from '../../core/schemas/runner-fields.js';
import { invokeProcessCli } from './cli-tools/process-invoke.js';
import { SANDBOX_CREDENTIAL_VALUES, sandboxCredentialValues } from './sandbox-env.js';

/** The only prompt sentinel understood by the lossless CLI transport. */
export const CLI_PROMPT_PLACEHOLDER = '<PROMPT>';
/** Linux's per-argument limit is the conservative bound for all supported hosts. */
export const CLI_ARGV_PROMPT_MAX_BYTES = 120_000;
/** The process executor owns explicit runner timeouts; this is its no-deadline sentinel. */
export const CLI_NO_DEADLINE_MS = 2_147_000_000;

const CLI_PROTECTED_FLAGS = new Set([
  '--agent',
  '--allow-all',
  '--auto',
  '--cd',
  '--chat-mode',
  '--cwd',
  '--effort',
  '--format',
  '--json',
  '--message',
  '--model',
  '--no-auto-commits',
  '--no-dirty-commits',
  '--no-pretty',
  '--no-stream',
  '--output-format',
  '--permission-mode',
  '--prompt',
  '--read',
  '--resume',
  '--sandbox',
  '--session',
  '--session-id',
  '--skip-git-repo-check',
  '--stream-json',
  '--terminal-event',
  '--yes-always',
  '-p',
  'architect',
  'exec',
  'plan',
  'resume',
  'run',
  'workspace-write',
]);

type InvokeCliOptions = {
  adapter: CliPlannerAdapter | CliImplementerAdapter;
  invocation: CliInvocation;
  prompt: string;
  callContext: RunnerCallContext;
  onOutput?: ((text: string) => void) | undefined;
  onSessionId?: ((id: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  idle?: { warnMs?: number | undefined; killMs?: number | undefined } | undefined;
};

export function toCliEnvironment(environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) result[name] = value;
  }
  const credentialValues = sandboxCredentialValues(environment);
  if (credentialValues.length > 0) {
    Object.defineProperty(result, SANDBOX_CREDENTIAL_VALUES, {
      value: credentialValues,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return result;
}

export interface CliToolPlanner {
  buildArgs(opts: {
    prompt: string;
    model?: string | undefined;
    projectDir: string;
    mode: 'plan' | 'escalate';
    sessionId?: string | null | undefined;
    effort?: EffortLevel | undefined;
  }): string[];
  parseLine: (line: string) => ParsedLine;
  postProcess?: (text: string, stderrOutput: string, usage: TokenDelta | null) => InvokeResult;
  isAvailableOpts?: { timeout?: number | undefined };
  /** Whether this tool supports resuming a previous session via a backend-specific flag. */
  supportsSessionResume?: boolean;
  /** Whether this CLI tool honours the planner-effort flag. */
  supportsEffort?: boolean;
}

export interface CliToolImplementer {
  buildArgs(opts: { prompt: string; model?: string | undefined }): string[];
  parseLine?: ((line: string) => ParsedLine) | undefined;
}

export interface CliToolEntry {
  command: string;
  description: string;
  notFoundMessage: string;
  trust: RunnerRoleTrustMetadata;
  /**
   * Upstream CLI release the flag, subcommand, and JSON-envelope contract was last verified
   * against. These tools ship breaking CLI changes with no compatibility guarantee, so
   * `detectAvailablePlanners` probes the installed version via `getVersion()`. When the
   * installed major version differs from the tested one, detection still reports the tool as
   * available and includes `compatibility: { kind: 'major-version-mismatch', installedVersion,
   * testedVersion }` on that planner result. Tested matrix lives in docs/PLANNERS-AND-IMPLEMENTERS.md.
   */
  testedVersion: string;
  planner?: CliToolPlanner;
  implementer?: CliToolImplementer;
}

export const CLI_TOOLS: Record<CliToolId, CliToolEntry> = {
  'claude-code': {
    command: 'claude',
    description: 'Claude Code CLI',
    notFoundMessage: 'Claude Code CLI not found. Install it from https://claude.ai/code',
    trust: CLI_TOOL_TRUST['claude-code'],
    testedVersion: '2.0.0',
  },
  codex: {
    command: 'codex',
    description: 'OpenAI Codex CLI',
    notFoundMessage: 'Codex CLI not found. Install it with: npm install -g @openai/codex',
    trust: CLI_TOOL_TRUST.codex,
    testedVersion: '0.40.0',
    planner: {
      supportsSessionResume: true,
      supportsEffort: false,
      buildArgs: ({ prompt: rawPrompt, model, projectDir, mode, sessionId }) => {
        const prompt = rawPrompt;
        // Resume path: `codex exec resume --json <SESSION_ID> <PROMPT>`. Only valid for live
        // planning turns; escalate uses one-shot `exec` to avoid polluting the resumed session.
        if (sessionId && mode === 'plan') {
          const args = ['exec', 'resume', '--json', sessionId, prompt];
          if (model) args.splice(2, 0, '--model', model);
          return args;
        }
        const args =
          mode === 'plan'
            ? ['exec', '--json', '--cd', projectDir, prompt]
            : [
                'exec',
                '--json',
                '--sandbox',
                'workspace-write',
                '--skip-git-repo-check',
                '--cd',
                projectDir,
                prompt,
              ];
        if (model) args.unshift('--model', model);
        return args;
      },
      parseLine: parseJsonlLine,
    },
    implementer: {
      buildArgs: ({ prompt, model }) => {
        const args: string[] = [
          'exec',
          '--json',
          '--sandbox',
          'workspace-write',
          '--skip-git-repo-check',
          prompt,
        ];
        if (model) args.unshift('--model', model);
        return args;
      },
      parseLine: parseJsonlLine,
    },
  },
  opencode: {
    command: 'opencode',
    description: 'OpenCode CLI',
    notFoundMessage: 'OpenCode CLI not found. Install it from https://opencode.ai',
    trust: CLI_TOOL_TRUST.opencode,
    testedVersion: '0.5.0',
    planner: {
      buildArgs: ({ prompt, model }) => {
        const args = ['run', '--format', 'json', '--agent', 'plan', prompt];
        if (model) args.splice(1, 0, '--model', model);
        return args;
      },
      parseLine: parseOpencodeLine,
      isAvailableOpts: { timeout: 5000 },
    },
    implementer: {
      buildArgs: ({ prompt, model }) => {
        const args = ['run', '--format', 'json', prompt];
        if (model) args.splice(1, 0, '--model', model);
        return args;
      },
      parseLine: parseOpencodeLine,
    },
  },
  aider: {
    command: 'aider',
    description: 'Aider CLI',
    notFoundMessage: 'Aider not found. Install it from https://aider.chat',
    trust: CLI_TOOL_TRUST.aider,
    testedVersion: '0.86.0',
    planner: {
      buildArgs: ({ prompt, model, projectDir, mode }) => {
        const args = [
          '--chat-mode',
          'ask',
          '--yes-always',
          '--no-stream',
          '--no-pretty',
          '--message',
          prompt,
        ];
        if (model) args.unshift('--model', model);
        if (mode === 'plan' && confinedExists(projectDir, 'src')) args.push('--read', 'src/');
        return args;
      },
      parseLine: (line) => ({ text: line + '\n' }),
      postProcess: (text, stderrOutput, usage) => {
        const allOutput = text + stderrOutput;
        for (const line of allOutput.split('\n')) {
          const parsed = parseTextLine(line);
          if (parsed.usage) return { text: text.trim(), usage: parsed.usage };
        }
        return { text: text.trim(), usage };
      },
    },
    implementer: {
      buildArgs: ({ prompt, model }) => {
        const args = [
          '--message',
          prompt,
          '--yes-always',
          '--no-auto-commits',
          '--no-dirty-commits',
        ];
        if (model) args.push('--model', model);
        return args;
      },
    },
  },
  copilot: {
    command: 'copilot',
    description: 'GitHub Copilot CLI',
    notFoundMessage:
      'Copilot CLI not found. Install: npm install -g @github/copilot — or see https://github.com/github/copilot-cli',
    trust: CLI_TOOL_TRUST.copilot,
    testedVersion: '0.3.0',
    planner: {
      buildArgs: ({ prompt, model }) => {
        const args = ['-p', prompt, '--output-format', 'json'];
        if (model) args.unshift('--model', model);
        return args;
      },
      parseLine: parseCopilotLine,
    },
    implementer: {
      buildArgs: ({ prompt, model }) => {
        const args = ['-p', prompt, '--allow-all'];
        if (model) args.unshift('--model', model);
        return args;
      },
    },
  },
  'kilo-code': {
    command: 'kilo',
    description: 'Kilo Code CLI',
    notFoundMessage: 'Kilo Code CLI not found. Install it with: npm install -g @kilocode/cli',
    trust: CLI_TOOL_TRUST['kilo-code'],
    testedVersion: '0.1.0',
    planner: {
      buildArgs: ({ prompt, model }) => {
        const args = ['run', '--format', 'json', '--agent', 'architect', prompt];
        if (model) args.splice(1, 0, '--model', model);
        return args;
      },
      parseLine: parseOpencodeLine,
      isAvailableOpts: { timeout: 5000 },
    },
    implementer: {
      buildArgs: ({ prompt, model }) => {
        const args = ['run', '--auto', prompt];
        if (model) args.splice(1, 0, '--model', model);
        return args;
      },
    },
  },
};

function promptPlaceholderConflict(arg: string): boolean {
  return arg.includes(CLI_PROMPT_PLACEHOLDER) || /\{prompt\}/i.test(arg) || /^<[^>]+>$/.test(arg);
}

function protectedFlag(arg: string): string | null {
  if (!arg.startsWith('-')) return null;
  const flag = arg.split('=', 1)[0] ?? arg;
  return CLI_PROTECTED_FLAGS.has(flag) ? flag : null;
}

function validateCliInvocationArgs(
  invocationArgs: readonly string[],
  baseArgs: readonly string[] | null,
): Readonly<{ valid: true }> | Readonly<{ valid: false; conflicts: readonly string[] }> {
  if (baseArgs === null) return { valid: false, conflicts: ['adapter-build-order'] };

  const conflicts: string[] = [];
  if (
    invocationArgs.length < baseArgs.length ||
    baseArgs.some((arg, index) => invocationArgs[index] !== arg)
  ) {
    conflicts.push('argument-order');
  }

  const promptCount = invocationArgs.filter((arg) => arg === CLI_PROMPT_PLACEHOLDER).length;
  if (promptCount !== 1) conflicts.push('prompt-transport');

  for (const arg of invocationArgs) {
    if (arg !== CLI_PROMPT_PLACEHOLDER && promptPlaceholderConflict(arg)) {
      conflicts.push('prompt-transport');
    }
  }

  const configuredArgs = invocationArgs.slice(baseArgs.length);
  for (const arg of configuredArgs) {
    const flag = protectedFlag(arg);
    if (flag) conflicts.push(flag);
  }

  const uniqueConflicts = [...new Set(conflicts)];
  return uniqueConflicts.length === 0
    ? { valid: true }
    : { valid: false, conflicts: uniqueConflicts };
}

function toProtocolEvents(parsed: ParsedLine): readonly CliProtocolEvent[] {
  const events: CliProtocolEvent[] = [];
  if (parsed.text !== undefined && parsed.text.length > 0) {
    events.push({
      type: 'text',
      channel: parsed.channel ?? (parsed.isResult ? 'result' : 'stdout'),
      text: parsed.text,
    });
  }
  if (parsed.usage) {
    events.push({
      type: 'usage',
      usage: parsed.usage,
      semantics: parsed.usageSemantics ?? (parsed.isResult ? 'final' : 'delta'),
    });
  }
  if (parsed.sessionId) events.push({ type: 'session', nativeSessionId: parsed.sessionId });
  for (const toolUse of [...(parsed.toolUse ?? []), ...(parsed.toolUseDone ?? [])]) {
    events.push({
      type: 'tool-use',
      id: toolUse.id ?? null,
      name: toolUse.name,
      input: { ...toolUse.input },
      ...(toolUse.output !== undefined && { output: toolUse.output }),
    });
  }
  for (const warning of parsed.warning ?? []) {
    events.push({ type: 'warning', code: warning.code, message: warning.message });
  }
  if (parsed.isError) {
    events.push({
      type: 'warning',
      code: 'runner_result_error',
      message: parsed.text ?? 'Runner result failed',
    });
  }
  return events;
}

function createCliAdapterTerminal(opts: {
  postProcess?:
    | ((text: string, stderrOutput: string, usage: TokenDelta | null) => InvokeResult)
    | undefined;
}): CliPlannerAdapter['terminal'] {
  return ({ events, stderr }) => {
    let usage: TokenDelta | null = null;
    let nativeSessionId: string | null = null;
    let text = '';
    for (const event of events) {
      switch (event.type) {
        case 'text':
          if (event.channel !== 'stderr') text += event.text;
          break;
        case 'usage':
          usage = accumulateTokenUsage(usage, event.usage, event.semantics);
          break;
        case 'session':
          nativeSessionId = event.nativeSessionId;
          break;
        default:
          break;
      }
    }
    const projected = opts.postProcess?.(text, stderr, usage);
    return {
      type: 'result',
      status: 'completed',
      // The deltas above are already recorded by invokeProcessCli. Returning an
      // empty terminal text prevents a second copy of the response from being emitted.
      text: '',
      usage: projected?.usage ?? usage,
      nativeSessionId,
      error: null,
      partial: false,
    };
  };
}

export function createCliPlannerAdapter(opts: {
  toolName: CliToolId;
  planner: CliToolPlanner;
  parseLine: (line: string) => ParsedLine;
  postProcess?:
    | ((text: string, stderrOutput: string, usage: TokenDelta | null) => InvokeResult)
    | undefined;
}): CliPlannerAdapter {
  let baseArgs: readonly string[] | null = null;
  const adapter: CliPlannerAdapter = {
    descriptor: CLI_TOOL_CATALOG[opts.toolName],
    role: 'planner',
    promptTransport: { kind: 'argv', maxBytes: CLI_ARGV_PROMPT_MAX_BYTES },
    buildArgs: (input) => {
      const built = opts.planner.buildArgs({
        prompt: input.prompt,
        ...(input.model !== undefined && { model: input.model }),
        projectDir: input.projectDir,
        mode: input.mode,
        ...(input.sessionId !== null &&
          input.sessionId !== undefined && {
            sessionId: input.sessionId,
          }),
        ...(input.effort !== undefined && { effort: input.effort }),
      });
      baseArgs = [...built];
      return [...built, ...input.configuredArgs];
    },
    validateArgs: (invocationArgs) => validateCliInvocationArgs(invocationArgs, baseArgs),
    environment: {},
    outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
    parse: (line) => toProtocolEvents(opts.parseLine(line)),
    terminal: createCliAdapterTerminal({ postProcess: opts.postProcess }),
    probe: {
      version: {
        command: [opts.toolName, '--version'],
        cwd: 'neutral',
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
      auth: {
        command: [opts.toolName, 'auth'],
        cwd: 'neutral',
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
    },
  };
  return adapter;
}

export function createCliImplementerAdapter(opts: {
  toolName: CliToolId;
  implementer: CliToolImplementer;
  parseLine: (line: string) => ParsedLine;
}): CliImplementerAdapter {
  let baseArgs: readonly string[] | null = null;
  const adapter: CliImplementerAdapter = {
    descriptor: CLI_TOOL_CATALOG[opts.toolName],
    role: 'implementer',
    promptTransport: { kind: 'argv', maxBytes: CLI_ARGV_PROMPT_MAX_BYTES },
    buildArgs: (input) => {
      const built = opts.implementer.buildArgs({
        prompt: input.prompt,
        ...(input.model !== undefined && { model: input.model }),
      });
      baseArgs = [...built];
      return [...built, ...input.configuredArgs];
    },
    validateArgs: (invocationArgs) => validateCliInvocationArgs(invocationArgs, baseArgs),
    environment: {},
    outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
    parse: (line) => toProtocolEvents(opts.parseLine(line)),
    terminal: createCliAdapterTerminal({}),
    probe: {
      version: {
        command: [opts.toolName, '--version'],
        cwd: 'neutral',
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
      auth: {
        command: [opts.toolName, 'auth'],
        cwd: 'neutral',
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
    },
  };
  return adapter;
}

export async function invokeCliAdapter(opts: InvokeCliOptions): Promise<RunnerCallResult> {
  const idleWarnMs = opts.idle?.warnMs ?? RUNNER_IDLE_WARN_MS;
  const idleKillMs = opts.idle?.killMs ?? RUNNER_IDLE_KILL_MS;
  const idleController = new AbortController();
  const signal = opts.invocation.signal
    ? AbortSignal.any([opts.invocation.signal, idleController.signal])
    : idleController.signal;
  let lastActivity = Date.now();
  let warned = false;
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  const tickMs = Math.max(10, Math.min(100, idleWarnMs, idleKillMs));
  if (Number.isFinite(idleWarnMs) && Number.isFinite(idleKillMs)) {
    idleTimer = setInterval(() => {
      const silentMs = Date.now() - lastActivity;
      if (!warned && silentMs >= idleWarnMs) {
        warned = true;
        opts.onCallEvent?.({
          type: 'call_stalled',
          ts: Date.now(),
          ...opts.callContext,
          silentMs,
        });
      }
      if (silentMs >= idleKillMs && !idleController.signal.aborted) {
        idleController.abort(new DOMException('CLI runner idle timeout', 'TimeoutError'));
      }
    }, tickMs);
    idleTimer.unref?.();
  }

  try {
    return await invokeProcessCli(opts.adapter, {
      invocation: { ...opts.invocation, signal },
      prompt: opts.prompt,
      callContext: opts.callContext,
      onEvent: (event) => {
        if (
          event.type !== 'call_started' &&
          event.type !== 'call_completed' &&
          event.type !== 'call_error'
        ) {
          lastActivity = Date.now();
        }
        opts.onCallEvent?.(event);
        if (event.type === 'call_text_delta') opts.onOutput?.(event.text);
        if (event.type === 'call_session_id') opts.onSessionId?.(event.nativeSessionId);
      },
    });
  } finally {
    if (idleTimer !== undefined) clearInterval(idleTimer);
  }
}
