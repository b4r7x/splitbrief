import { buildPrompt, fenced, instructionsSection } from './builder.js';

export function buildPlannerEstimateReviewPrompt(packet: unknown): string {
  return buildPrompt({
    title: 'Planner Estimate Review',
    intro:
      'You are reviewing a deterministic pre-run estimate before implementation starts. The user explicitly opted into this extra planner call.',
    sections: [
      {
        heading: 'Estimate Packet',
        body: fenced(JSON.stringify(packet, null, 2), 'json'),
      },
      instructionsSection(
        `Answer only from the packet. Do not request repo maps, source code, full task bodies, or logs.

Review:
- Is the deterministic estimate likely enough?
- Which tasks are likely too big for the selected cheap implementer?
- Which tasks are risky for a weak implementer?
- Should any task be split?
- Is a user decision required before spending?

You may recommend a stronger implementer or a split, but do not reassign models. The user decides routing changes.`,
      ),
    ],
    output: `Return only compact JSON in this exact shape:

{
  "classification": "ok" | "split-suggested" | "risk" | "needs-user-decision",
  "affectedTaskIds": ["T001"],
  "reason": "One short sentence.",
  "recommendedUserDecision": "One short sentence for the user."
}`,
  });
}
