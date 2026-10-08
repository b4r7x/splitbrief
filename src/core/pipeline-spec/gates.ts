import type { ValidationStage } from '../schemas/enums.js';
import { NARROWING_KINDS } from '../validation/stacks/types.js';

export const GATE_ORDER: readonly ValidationStage[] = ['typecheck', 'lint', 'test'];

export const CAPTURE_LIMITS = {
  outputChars: 4096,
  testTailLines: 40,
} as const;

export const STAGE_TIMEOUT_MS = 3_600_000;

export const NO_GATES_WARNING = {
  category: 'validation',
  code: 'no_gates_unknown_stack',
} as const;

export const NARROWING_RULE = {
  text: "The brief gate's test stage runs only the tests affected by the brief's files and by every file the attempt changed when the resolved command comes from the stack default, or from the manifest with a recognised stack; a command pinned in config waits for the final review, except at the gate of a fix task that answers a test red, which runs it on the full suite.",
  kinds: NARROWING_KINDS,
} as const;
