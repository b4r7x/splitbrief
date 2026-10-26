import { CREW_SEAT_LABELS, type CrewSeatId } from '../crew/identity.js';
import { z } from 'zod';

export const SeatAccountCauseSchema = z.enum(['balance', 'billing', 'quota', 'access', 'auth']);
export type SeatAccountCause = z.infer<typeof SeatAccountCauseSchema>;

const ACCOUNT_CAUSE_WORDS: Readonly<Record<SeatAccountCause, string>> = {
  balance: 'Balance spent on',
  billing: 'Billing refused by',
  quota: 'Quota spent on',
  access: 'Access refused by',
  auth: 'Signed out of',
};

// Access is refused for a model the plan leaves out (Cursor) or by an organization policy for every
// model (Copilot): only the account can say which.
const ACCOUNT_CAUSE_ADVICE: Readonly<
  Record<Exclude<SeatAccountCause, 'auth'>, (tool: string) => string>
> = {
  balance: () => 'Add credit or',
  billing: () => "Fix the account's billing or",
  quota: () => 'Wait for the quota to renew or',
  access: (tool) => `Check what the ${tool} account allows, or`,
};

export function formatAccountCause(cause: SeatAccountCause, tool: string): string {
  return `${ACCOUNT_CAUSE_WORDS[cause]} ${tool}`;
}

export function accountCauseAdvice(
  input: Readonly<{ cause: Exclude<SeatAccountCause, 'auth'>; tool: string; seat: CrewSeatId }>,
): string {
  return `${formatAccountCause(input.cause, input.tool)}. ${ACCOUNT_CAUSE_ADVICE[input.cause](input.tool)} change the ${CREW_SEAT_LABELS[input.seat]} tool, then continue.`;
}
