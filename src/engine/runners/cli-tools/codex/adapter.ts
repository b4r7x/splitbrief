import { CLI_TOOL_CATALOG } from '../../../../core/runners/cli-tool/catalog.js';
import { plannerBaseArgs, implementerBaseArgs, validateArgs } from './args.js';
import { codexProtocolEvents, codexTerminal } from './protocol.js';
import type { CliPlannerAdapter, CliImplementerAdapter } from '../contract.js';

export const CODEX_ID = 'codex' as const;
export const CODEX_COMMAND = 'codex' as const;
const CODEX_PROMPT_TRANSPORT = Object.freeze({ kind: 'stdin' } as const);
// Codex refused a longer turn with input_too_large, captured 2026-10-05.
const CODEX_PROMPT_LIMIT = Object.freeze({ max: 1_048_576, unit: 'characters' } as const);
export const CODEX_VERSION_ARGS = Object.freeze(['--version'] as const);

// The refreshed call may refresh over the network when stale; the probe timeout and remembered
// catalog cover a cold miss. With no `auth.json` it exits 0 with the bundled list, which parses the
// same; a credential-less session channel stops first as `missing-credential`.
export const CODEX_NATIVE_MODEL_CATALOG_PROBE = Object.freeze({
  capability: 'debug-models-v2',
  command: Object.freeze([CODEX_COMMAND, 'debug', 'models'] as const),
  maxOutputBytes: 2 * 1024 * 1024,
});

function createCodexPlannerAdapter(): CliPlannerAdapter<'codex'> {
  return {
    descriptor: CLI_TOOL_CATALOG.codex,
    role: 'planner',
    supportsSessionResume: true,
    supportsEffort: CLI_TOOL_CATALOG.codex.supportsEffort,
    schemaFile: true,
    promptTransport: CODEX_PROMPT_TRANSPORT,
    promptLimit: CODEX_PROMPT_LIMIT,
    baseArgs: plannerBaseArgs,
    buildArgs: (input) => [...plannerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
    environment: {},
    outputContract: { kind: 'structured-terminal', terminalEvent: 'required' },
    parse: codexProtocolEvents,
    terminal: codexTerminal,
    probe: {
      version: {
        command: [CODEX_COMMAND, ...CODEX_VERSION_ARGS],
        cwd: 'neutral',
        maxOutputBytes: 4_096,
      },
    },
  };
}

function createCodexImplementerAdapter(): CliImplementerAdapter<'codex'> {
  return {
    descriptor: CLI_TOOL_CATALOG.codex,
    role: 'implementer',
    promptTransport: CODEX_PROMPT_TRANSPORT,
    promptLimit: CODEX_PROMPT_LIMIT,
    baseArgs: implementerBaseArgs,
    buildArgs: (input) => [...implementerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
    environment: {},
    outputContract: { kind: 'structured-terminal', terminalEvent: 'required' },
    parse: codexProtocolEvents,
    terminal: codexTerminal,
    probe: {
      version: {
        command: [CODEX_COMMAND, ...CODEX_VERSION_ARGS],
        cwd: 'neutral',
        maxOutputBytes: 4_096,
      },
    },
  };
}

export const codexPlannerAdapter = createCodexPlannerAdapter();
export const codexImplementerAdapter = createCodexImplementerAdapter();
