import { CREW_SEAT_LABELS, type CrewSeatId } from '../crew/identity.js';
import { z } from 'zod';

export const SeatAccountCauseSchema = z.enum(['balance', 'billing', 'quota', 'auth']);
export type SeatAccountCause = z.infer<typeof SeatAccountCauseSchema>;

const ACCOUNT_CAUSE_WORDS: Readonly<Record<SeatAccountCause, string>> = {
  balance: 'Balance spent on',
  billing: 'Billing refused by',
  quota: 'Quota spent on',
  auth: 'Signed out of',
};

const ACCOUNT_CAUSE_ADVICE: Readonly<Record<Exclude<SeatAccountCause, 'auth'>, string>> = {
  balance: 'Add credit',
  billing: "Fix the account's billing",
  quota: 'Wait for the quota to renew',
};

export function formatAccountCause(cause: SeatAccountCause, tool: string): string {
  return `${ACCOUNT_CAUSE_WORDS[cause]} ${tool}`;
}

export function accountCauseAdvice(
  input: Readonly<{ cause: Exclude<SeatAccountCause, 'auth'>; tool: string; seat: CrewSeatId }>,
): string {
  return `${formatAccountCause(input.cause, input.tool)}. ${ACCOUNT_CAUSE_ADVICE[input.cause]} or change the ${CREW_SEAT_LABELS[input.seat]} tool, then continue.`;
}
