import { contractSha256 } from '../../../providers/candidate/contract.js';
import {
  CLAUDE_ID,
  CLAUDE_COMMAND,
  claudeCodePlannerAdapter,
  claudeCodeImplementerAdapter,
} from './adapter.js';
import type { CliPlannerAdapter, CliImplementerAdapter } from '../contract.js';
import { CLAUDE_BASE_ARGS, sandboxSettings } from './args.js';

export type RawClaudeCliContract = Readonly<{
  id: typeof CLAUDE_ID;
  command: typeof CLAUDE_COMMAND;
  role: 'planner' | 'implementer';
  versionArgs: readonly ['--version'];
  auth: Readonly<{ kind: 'env-or-native'; env: readonly ['ANTHROPIC_API_KEY'] }>;
  rawInvocation: readonly string[];
  promptTransport: 'stdin';
  expectedRawTerminal: 'result';
  asOf: '2026-07-31';
}>;

export type ClaudeCliConformanceCandidate = Readonly<{
  id: typeof CLAUDE_ID;
  role: 'planner' | 'implementer';
  rawContract: RawClaudeCliContract;
  contractSha256: string;
  adapter: CliPlannerAdapter<'claude-code'> | CliImplementerAdapter<'claude-code'>;
}>;

function rawContract(role: 'planner' | 'implementer'): RawClaudeCliContract {
  return {
    id: CLAUDE_ID,
    command: CLAUDE_COMMAND,
    role,
    versionArgs: ['--version'],
    auth: { kind: 'env-or-native', env: ['ANTHROPIC_API_KEY'] },
    rawInvocation:
      role === 'planner'
        ? [...CLAUDE_BASE_ARGS, '--permission-mode', 'plan', '--disallowedTools', 'AskUserQuestion']
        : [
            ...CLAUDE_BASE_ARGS,
            '--permission-mode',
            'acceptEdits',
            '--settings',
            sandboxSettings({ readable: [], blockReads: true, skillRoots: [] }),
          ],
    promptTransport: 'stdin',
    expectedRawTerminal: 'result',
    asOf: '2026-07-31',
  };
}

const plannerRawContract = rawContract('planner');
const implementerRawContract = rawContract('implementer');

export const CLI_CONFORMANCE_CANDIDATES: readonly ClaudeCliConformanceCandidate[] = Object.freeze([
  Object.freeze({
    id: CLAUDE_ID,
    role: 'planner',
    rawContract: plannerRawContract,
    contractSha256: contractSha256(plannerRawContract),
    adapter: claudeCodePlannerAdapter,
  }),
  Object.freeze({
    id: CLAUDE_ID,
    role: 'implementer',
    rawContract: implementerRawContract,
    contractSha256: contractSha256(implementerRawContract),
    adapter: claudeCodeImplementerAdapter,
  }),
]);
