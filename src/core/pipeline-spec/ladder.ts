export type LadderRungId = 'recipe-fix' | 'local' | 'consult';

export type LadderRung = Readonly<{
  id: LadderRungId;
  who: 'implementer' | 'planner-then-implementer';
  consumesRetry?: boolean;
  count?: 'DEFAULT_LOCAL_RETRIES';
}>;

export const LADDER: readonly LadderRung[] = [
  { id: 'recipe-fix', who: 'implementer', consumesRetry: false },
  { id: 'local', who: 'implementer', count: 'DEFAULT_LOCAL_RETRIES' },
  { id: 'consult', who: 'planner-then-implementer' },
];

const FINAL_FRAMING = 'Multiple attempts have failed. Try a completely different approach:';

export const RETRY_FRAMINGS: Readonly<Record<number, string>> = {
  1: 'Your previous attempt had an error. Fix it:',
  2: 'Previous attempts failed. Here is the task rephrased differently:',
  3: FINAL_FRAMING,
};

/** A fix brief's first retry: the error names failures that are not its job, so it fixes only its own. */
const FIX_BRIEF_FRAMING =
  "Your previous attempt had an error. Fix what it names as yours; failures it names as not this brief's job are left to their fix tasks or the next review:";

export function framingForAttempt(attempt: number, fix: boolean): string {
  if (attempt === 1 && fix) return FIX_BRIEF_FRAMING;
  return RETRY_FRAMINGS[attempt] ?? FINAL_FRAMING;
}

/** How much of an implementer's terminal text the hint prompt carries; the panel quotes only its last `HAND_BACK_PANEL_CHARS`. */
export const HAND_BACK_MAX_CHARS = 2000;

/** How much of a hand-back the recovery panel quotes: its end, where a stop says why. */
export const HAND_BACK_PANEL_CHARS = 300;
