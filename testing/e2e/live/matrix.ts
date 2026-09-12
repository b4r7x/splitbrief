import {
  type LiveSeat,
  type ReleaseMatrixRun,
  liveModelPin,
  openCodeFreeModelId,
} from '../helpers/live-harness.js';

export type ReleaseMatrixRow = Readonly<{
  id: string;
  mode: 'quick' | 'standard' | 'speckit';
  plan: string;
  build: string;
  review?: string | undefined;
  task: string;
}>;

/** Cheapest pin per tool; every entry goes through liveModelPin, so the env override and the cost ceiling both apply. */
const PIN_FALLBACKS: Readonly<Record<string, () => string | undefined>> = {
  'claude-code': () => 'haiku',
  codex: () => 'gpt-5.6-luna',
  opencode: () => openCodeFreeModelId(),
  'command-code': () => 'deepseek/deepseek-v4-flash',
  'kilo-code': () => 'kilo/kilo-auto/free',
  cursor: () => 'gpt-5.3-codex-low-fast',
  copilot: () => 'claude-haiku-4.5',
};

export function resolveReleaseMatrixSeat(tool: string): LiveSeat {
  const pinned =
    process.env[`SPLITBRIEF_REAL_CLI_${tool.toUpperCase().replaceAll('-', '_')}_MODEL`];
  const fallback = pinned === undefined ? PIN_FALLBACKS[tool] : undefined;
  return {
    tool,
    model: liveModelPin({ tool, fallback: fallback === undefined ? undefined : fallback() }),
  };
}

export const RELEASE_MATRIX: readonly ReleaseMatrixRow[] = [
  {
    id: 'quick-canary-claude-code',
    mode: 'quick',
    plan: 'claude-code',
    build: 'claude-code',
    task: 'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
  },
  {
    id: 'quick-canary-codex',
    mode: 'quick',
    plan: 'codex',
    build: 'codex',
    task: 'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
  },
  {
    id: 'quick-canary-opencode',
    mode: 'quick',
    plan: 'opencode',
    build: 'opencode',
    task: 'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
  },
  {
    id: 'quick-canary-command-code',
    mode: 'quick',
    plan: 'command-code',
    build: 'command-code',
    task: 'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
  },
  {
    id: 'quick-canary-kilo-code',
    mode: 'quick',
    plan: 'kilo-code',
    build: 'kilo-code',
    task: 'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
  },
  {
    id: 'quick-canary-cursor',
    mode: 'quick',
    plan: 'cursor',
    build: 'cursor',
    task: 'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
  },
  {
    id: 'quick-canary-copilot',
    mode: 'quick',
    plan: 'copilot',
    build: 'copilot',
    task: 'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
  },
  {
    id: 'quick-cross-codex-cursor',
    mode: 'quick',
    plan: 'codex',
    build: 'cursor',
    task: 'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
  },
  {
    id: 'standard-cross-command-code-opencode',
    mode: 'standard',
    plan: 'command-code',
    build: 'opencode',
    task: 'Add src/live-heavy/value.ts exporting a number constant liveHeavyValue with value 42, and src/live-heavy/double.ts exporting a function doubleLiveHeavy that returns its numeric argument times two.',
  },
  {
    id: 'standard-cross-claude-code-kilo-code',
    mode: 'standard',
    plan: 'claude-code',
    build: 'kilo-code',
    task: 'Add src/live-heavy/value.ts exporting a number constant liveHeavyValue with value 42, and src/live-heavy/double.ts exporting a function doubleLiveHeavy that returns its numeric argument times two.',
  },
  {
    id: 'speckit-cross-opencode-command-code',
    mode: 'speckit',
    plan: 'opencode',
    build: 'command-code',
    review: 'codex',
    task: 'Create src/live-speckit.ts exporting a string constant named liveSpeckit with value "live-speckit".',
  },
];

export function resolveReleaseMatrixRun(row: ReleaseMatrixRow): ReleaseMatrixRun {
  return {
    id: row.id,
    mode: row.mode,
    task: row.task,
    plan: resolveReleaseMatrixSeat(row.plan),
    build: resolveReleaseMatrixSeat(row.build),
    ...(row.review === undefined ? {} : { review: resolveReleaseMatrixSeat(row.review) }),
  };
}
