import { NARROWING_KINDS } from '../validation/stacks/types.js';

export const CAPTURE_LIMITS = {
  outputChars: 4096,
  testTailLines: 40,
} as const;

export const STAGE_TIMEOUT_MS = 3_600_000;

export const NARROWING_RULE = {
  text: 'A planner `test` check runs only the tests its file affects when the resolved command comes from the stack default, or from the manifest with a recognised stack; a command pinned in config runs as written.',
  kinds: NARROWING_KINDS,
} as const;
