import { join } from 'node:path';
import type { UnregisteredCliCandidate } from '../../src/engine/runners/cli-tools/candidate-contract.js';
import { CLI_CONFORMANCE_CANDIDATES as claudeCodeCandidates } from '../../src/engine/runners/cli-tools/claude-code/conformance.js';
import { CLI_CONFORMANCE_CANDIDATES as codexCandidates } from '../../src/engine/runners/cli-tools/codex/conformance.js';
import { CLI_CONFORMANCE_CANDIDATES as opencodeCandidates } from '../../src/engine/runners/cli-tools/opencode/adapter.js';
import { CLI_CONFORMANCE_CANDIDATES as copilotCandidates } from '../../src/engine/runners/cli-tools/copilot/adapter.js';
import { CLI_CONFORMANCE_CANDIDATES as kiloCodeCandidates } from '../../src/engine/runners/cli-tools/kilo-code.js';
import { CLI_CONFORMANCE_CANDIDATES as cursorCandidates } from '../../src/engine/runners/cli-tools/cursor/conformance.js';
import { CLI_CONFORMANCE_CANDIDATES as commandCodeCandidates } from '../../src/engine/runners/cli-tools/command-code/conformance.js';

const ADAPTERS_DIR = join(import.meta.dirname, '../../src/engine/runners/cli-tools');

type ConformanceModule = Readonly<{
  modulePath: string;
  candidates: readonly UnregisteredCliCandidate[];
}>;

export const CONFORMANCE_MODULES: readonly ConformanceModule[] = [
  {
    modulePath: join(ADAPTERS_DIR, 'claude-code/conformance.ts'),
    candidates: claudeCodeCandidates,
  },
  { modulePath: join(ADAPTERS_DIR, 'codex/conformance.ts'), candidates: codexCandidates },
  { modulePath: join(ADAPTERS_DIR, 'opencode/adapter.ts'), candidates: opencodeCandidates },
  { modulePath: join(ADAPTERS_DIR, 'copilot/adapter.ts'), candidates: copilotCandidates },
  { modulePath: join(ADAPTERS_DIR, 'kilo-code.ts'), candidates: kiloCodeCandidates },
  { modulePath: join(ADAPTERS_DIR, 'cursor/conformance.ts'), candidates: cursorCandidates },
  {
    modulePath: join(ADAPTERS_DIR, 'command-code/conformance.ts'),
    candidates: commandCodeCandidates,
  },
];

export const CONFORMANCE_ROWS = CONFORMANCE_MODULES.flatMap((module) =>
  module.candidates.map((candidate) => ({
    ...candidate,
    modulePath: module.modulePath,
  })),
);
