export type LadderRungId = 'recipe-fix' | 'local' | 'consult' | 'takeover';

export type LadderRung = Readonly<{
  id: LadderRungId;
  who: 'implementer' | 'planner-then-implementer' | 'planner';
  consumesRetry?: boolean;
  count?: 'DEFAULT_LOCAL_RETRIES';
  /** False for a rung the skill runs but the engine has no call site for. */
  engine?: boolean;
}>;

export const LADDER: readonly LadderRung[] = [
  { id: 'recipe-fix', who: 'implementer', consumesRetry: false },
  { id: 'local', who: 'implementer', count: 'DEFAULT_LOCAL_RETRIES' },
  { id: 'consult', who: 'planner-then-implementer' },
  { id: 'takeover', who: 'planner', engine: false },
];

const FINAL_FRAMING = 'Multiple attempts have failed. Try a completely different approach:';

export const RETRY_FRAMINGS: Readonly<Record<number, string>> = {
  1: 'Your previous attempt had an error. Fix it:',
  2: 'Previous attempts failed. Here is the task rephrased differently:',
  3: FINAL_FRAMING,
};

export function framingForAttempt(attempt: number): string {
  return RETRY_FRAMINGS[attempt] ?? FINAL_FRAMING;
}

/** How much of an implementer's terminal text the hint prompt carries; the panel quotes only its last `HAND_BACK_PANEL_CHARS`. */
export const HAND_BACK_MAX_CHARS = 2000;

/** How much of a hand-back the recovery panel quotes: its end, where a stop says why. */
export const HAND_BACK_PANEL_CHARS = 300;
