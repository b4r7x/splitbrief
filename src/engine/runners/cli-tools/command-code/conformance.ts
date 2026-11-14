import { contractSha256 } from '../../../providers/candidate/contract.js';
import type { CliPlannerAdapter, CliImplementerAdapter } from '../contract.js';
import {
  COMMAND_CODE_ID,
  COMMAND_CODE_COMMAND,
  COMMAND_CODE_VERSION_ARGS,
  commandCodePlannerAdapter,
  commandCodeImplementerAdapter,
} from './adapter.js';

export type RawCommandCodeCliContract = Readonly<{
  id: typeof COMMAND_CODE_ID;
  command: typeof COMMAND_CODE_COMMAND;
  role: 'planner' | 'implementer';
  versionArgs: readonly ['--version', '--no-auto-update'];
  auth: Readonly<{ kind: 'none'; env: readonly [] }>;
  rawInvocation: readonly string[];
  promptTransport: 'stdin';
  expectedRawTerminal: 'result';
  asOf: '2026-09-08';
}>;

export type CommandCodeCliConformanceCandidate = Readonly<{
  id: typeof COMMAND_CODE_ID;
  role: 'planner' | 'implementer';
  rawContract: RawCommandCodeCliContract;
  contractSha256: string;
  adapter: CliPlannerAdapter<'command-code'> | CliImplementerAdapter<'command-code'>;
}>;

function commandCodeRawContract(role: 'planner' | 'implementer'): RawCommandCodeCliContract {
  return {
    id: COMMAND_CODE_ID,
    command: COMMAND_CODE_COMMAND,
    role,
    versionArgs: COMMAND_CODE_VERSION_ARGS,
    // No API-key env var is documented, so there is no env credential to require, and
    // `none` keeps contract-harness-raw from invoking a `cmd auth` subcommand that does
    // not exist — `cmd status --json` is the real auth probe.
    auth: { kind: 'none', env: [] },
    rawInvocation: [
      '-p',
      '--output-format',
      'json',
      '--trust',
      '--skip-onboarding',
      '--no-auto-update',
      ...(role === 'planner' ? ['--permission-mode', 'plan'] : ['--yolo']),
    ],
    promptTransport: 'stdin',
    expectedRawTerminal: 'result',
    asOf: '2026-09-08',
  };
}

const commandCodePlannerRawContract = commandCodeRawContract('planner');
const commandCodeImplementerRawContract = commandCodeRawContract('implementer');

export const CLI_CONFORMANCE_CANDIDATES: readonly CommandCodeCliConformanceCandidate[] =
  Object.freeze([
    Object.freeze({
      id: COMMAND_CODE_ID,
      role: 'planner',
      rawContract: commandCodePlannerRawContract,
      contractSha256: contractSha256(commandCodePlannerRawContract),
      adapter: commandCodePlannerAdapter,
    }),
    Object.freeze({
      id: COMMAND_CODE_ID,
      role: 'implementer',
      rawContract: commandCodeImplementerRawContract,
      contractSha256: contractSha256(commandCodeImplementerRawContract),
      adapter: commandCodeImplementerAdapter,
    }),
  ]);
