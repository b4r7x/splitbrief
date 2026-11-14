import { contractSha256 } from '../../../providers/candidate/contract.js';
import { CODEX_STDIN_PROMPT } from './args.js';
import type { CliPlannerAdapter, CliImplementerAdapter } from '../contract.js';
import {
  CODEX_ID,
  CODEX_COMMAND,
  CODEX_VERSION_ARGS,
  codexPlannerAdapter,
  codexImplementerAdapter,
} from './adapter.js';

export type RawCodexCliContract = Readonly<{
  id: typeof CODEX_ID;
  command: typeof CODEX_COMMAND;
  role: 'planner' | 'implementer';
  versionArgs: readonly ['--version'];
  auth: Readonly<{ kind: 'env-or-native'; env: readonly ['OPENAI_API_KEY'] }>;
  rawInvocation: readonly string[];
  promptTransport: 'stdin';
  expectedRawTerminal: 'turn.completed';
  asOf: '2026-09-29';
}>;

export type CodexCliConformanceCandidate = Readonly<{
  id: typeof CODEX_ID;
  role: 'planner' | 'implementer';
  rawContract: RawCodexCliContract;
  contractSha256: string;
  adapter: CliPlannerAdapter<'codex'> | CliImplementerAdapter<'codex'>;
}>;

function codexRawContract(role: 'planner' | 'implementer'): RawCodexCliContract {
  return {
    id: CODEX_ID,
    command: CODEX_COMMAND,
    role,
    versionArgs: CODEX_VERSION_ARGS,
    auth: { kind: 'env-or-native', env: ['OPENAI_API_KEY'] },
    rawInvocation:
      role === 'planner'
        ? [
            '--sandbox',
            'read-only',
            '--ask-for-approval',
            'never',
            'exec',
            '--ignore-user-config',
            '--ignore-rules',
            '--json',
            '--cd',
            '.',
            CODEX_STDIN_PROMPT,
          ]
        : [
            '--sandbox',
            'workspace-write',
            '--ask-for-approval',
            'never',
            'exec',
            '--ignore-user-config',
            '--json',
            '--skip-git-repo-check',
            '--cd',
            '.',
            CODEX_STDIN_PROMPT,
          ],
    promptTransport: 'stdin',
    expectedRawTerminal: 'turn.completed',
    asOf: '2026-09-29',
  };
}

const codexPlannerRawContract = codexRawContract('planner');
const codexImplementerRawContract = codexRawContract('implementer');

export const CLI_CONFORMANCE_CANDIDATES: readonly CodexCliConformanceCandidate[] = Object.freeze([
  Object.freeze({
    id: CODEX_ID,
    role: 'planner',
    rawContract: codexPlannerRawContract,
    contractSha256: contractSha256(codexPlannerRawContract),
    adapter: codexPlannerAdapter,
  }),
  Object.freeze({
    id: CODEX_ID,
    role: 'implementer',
    rawContract: codexImplementerRawContract,
    contractSha256: contractSha256(codexImplementerRawContract),
    adapter: codexImplementerAdapter,
  }),
]);
