import { contractSha256 } from '../../../providers/candidate/contract.js';
import type { CliPlannerAdapter, CliImplementerAdapter } from '../contract.js';
import {
  CURSOR_ID,
  CURSOR_COMMAND,
  CURSOR_VERSION_ARGS,
  cursorPlannerAdapter,
  cursorImplementerAdapter,
} from './adapter.js';

export type RawCursorCliContract = Readonly<{
  id: typeof CURSOR_ID;
  command: typeof CURSOR_COMMAND;
  role: 'planner' | 'implementer';
  versionArgs: readonly ['--version'];
  auth: Readonly<{ kind: 'env-or-native'; env: readonly ['CURSOR_API_KEY'] }>;
  rawInvocation: readonly string[];
  promptTransport: 'stdin';
  expectedRawTerminal: 'result';
  asOf: '2026-08-27';
}>;

export type CursorCliConformanceCandidate = Readonly<{
  id: typeof CURSOR_ID;
  role: 'planner' | 'implementer';
  rawContract: RawCursorCliContract;
  contractSha256: string;
  adapter: CliPlannerAdapter<'cursor'> | CliImplementerAdapter<'cursor'>;
}>;

function cursorRawContract(role: 'planner' | 'implementer'): RawCursorCliContract {
  return {
    id: CURSOR_ID,
    command: CURSOR_COMMAND,
    role,
    versionArgs: CURSOR_VERSION_ARGS,
    auth: { kind: 'env-or-native', env: ['CURSOR_API_KEY'] },
    rawInvocation:
      role === 'planner'
        ? ['--print', '--output-format', 'stream-json', '--mode', 'plan', '--trust']
        : ['--print', '--output-format', 'stream-json', '--force', '--trust'],
    promptTransport: 'stdin',
    expectedRawTerminal: 'result',
    asOf: '2026-08-27',
  };
}

const cursorPlannerRawContract = cursorRawContract('planner');
const cursorImplementerRawContract = cursorRawContract('implementer');

export const CLI_CONFORMANCE_CANDIDATES: readonly CursorCliConformanceCandidate[] = Object.freeze([
  Object.freeze({
    id: CURSOR_ID,
    role: 'planner',
    rawContract: cursorPlannerRawContract,
    contractSha256: contractSha256(cursorPlannerRawContract),
    adapter: cursorPlannerAdapter,
  }),
  Object.freeze({
    id: CURSOR_ID,
    role: 'implementer',
    rawContract: cursorImplementerRawContract,
    contractSha256: contractSha256(cursorImplementerRawContract),
    adapter: cursorImplementerAdapter,
  }),
]);
