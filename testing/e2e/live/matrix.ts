import {
  type LiveMatrixTierId,
  type LiveSeat,
  type ReleaseMatrixRun,
  liveModelPin,
  openCodeFreeModelId,
} from '../helpers/live-harness.js';

export type ReleaseMatrixRow = Readonly<{
  id: string;
  tier: LiveMatrixTierId;
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
  // `agy models` publishes nothing SPLITBRIEF can pin, so an unset env leaves
  // the seat on agy's own default.
  antigravity: () => undefined,
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
    id: 'one-file-canary-claude-code',
    tier: 'one-file',
    plan: 'claude-code',
    build: 'claude-code',
    task: 'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
  },
  {
    id: 'one-file-canary-codex',
    tier: 'one-file',
    plan: 'codex',
    build: 'codex',
    task: 'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
  },
  {
    id: 'one-file-canary-opencode',
    tier: 'one-file',
    plan: 'opencode',
    build: 'opencode',
    task: 'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
  },
  {
    id: 'one-file-canary-command-code',
    tier: 'one-file',
    plan: 'command-code',
    build: 'command-code',
    task: 'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
  },
  {
    id: 'one-file-canary-kilo-code',
    tier: 'one-file',
    plan: 'kilo-code',
    build: 'kilo-code',
    task: 'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
  },
  {
    id: 'one-file-canary-cursor',
    tier: 'one-file',
    plan: 'cursor',
    build: 'cursor',
    task: 'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
  },
  {
    id: 'one-file-canary-copilot',
    tier: 'one-file',
    plan: 'copilot',
    build: 'copilot',
    task: 'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
  },
  {
    id: 'one-file-canary-antigravity',
    tier: 'one-file',
    plan: 'antigravity',
    build: 'antigravity',
    task: 'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
  },
  {
    id: 'one-file-cross-codex-cursor',
    tier: 'one-file',
    plan: 'codex',
    build: 'cursor',
    task: 'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
  },
  {
    id: 'two-files-cross-command-code-opencode',
    tier: 'two-files',
    plan: 'command-code',
    build: 'opencode',
    task: 'Add src/live-heavy/value.ts exporting a number constant liveHeavyValue with value 42, and src/live-heavy/double.ts exporting a function doubleLiveHeavy that returns its numeric argument times two.',
  },
  {
    id: 'two-files-cross-claude-code-kilo-code',
    tier: 'two-files',
    plan: 'claude-code',
    build: 'kilo-code',
    task: 'Add src/live-heavy/value.ts exporting a number constant liveHeavyValue with value 42, and src/live-heavy/double.ts exporting a function doubleLiveHeavy that returns its numeric argument times two.',
  },
  {
    id: 'question-round-cross-opencode-command-code',
    tier: 'question-round',
    plan: 'opencode',
    build: 'command-code',
    review: 'codex',
    task: 'Create src/live-question.ts exporting a string constant named liveQuestion with value "live-question".',
  },
];

export function resolveReleaseMatrixRun(row: ReleaseMatrixRow): ReleaseMatrixRun {
  return {
    id: row.id,
    tier: row.tier,
    task: row.task,
    plan: resolveReleaseMatrixSeat(row.plan),
    build: resolveReleaseMatrixSeat(row.build),
    ...(row.review === undefined ? {} : { review: resolveReleaseMatrixSeat(row.review) }),
  };
}
