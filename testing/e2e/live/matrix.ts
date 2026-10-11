import {
  type LiveMatrixTierId,
  type LiveSeat,
  type ReleaseMatrixRun,
  liveModelPin,
  liveRowGateDecision,
  liveSkipAllowList,
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
const PIN_FALLBACKS: Readonly<Record<string, string>> = {
  'claude-code': 'haiku',
  codex: 'gpt-5.6-luna',
  opencode: 'opencode-go/deepseek-v4.1-flash',
  'command-code': 'deepseek/deepseek-v4-flash',
  'kilo-code': 'kilo/kilo-auto/free',
  cursor: 'gpt-5.3-codex-low-fast',
  copilot: 'claude-haiku-4.5',
  antigravity: 'gemini-3.8-flash-low',
};

export function resolveReleaseMatrixSeat(tool: string): LiveSeat {
  return {
    tool,
    model: liveModelPin({ tool, fallback: PIN_FALLBACKS[tool] }),
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
  const gate = liveRowGateDecision({
    readiness: [row.plan, row.build, ...(row.review === undefined ? [] : [row.review])].map(
      (tool) => ({ tool, state: 'ready' }),
    ),
    allowList: liveSkipAllowList(process.env.SPLITBRIEF_LIVE_SKIP),
  });
  const seat = (tool: string): LiveSeat =>
    gate.kind === 'skip' ? { tool, model: undefined } : resolveReleaseMatrixSeat(tool);
  return {
    id: row.id,
    tier: row.tier,
    task: row.task,
    plan: seat(row.plan),
    build: seat(row.build),
    ...(row.review === undefined ? {} : { review: seat(row.review) }),
  };
}
