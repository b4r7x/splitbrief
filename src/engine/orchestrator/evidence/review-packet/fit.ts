import {
  buildFinalReviewPrompt,
  type FinalReviewPromptInput,
} from '../../../spec/prompts/review.js';
import type { PromptLimit } from '../../../runners/input-limit.js';

export type ReviewInputDrop = Readonly<{ trim: 'task-evidence'; items: readonly string[] }>;
export type ReviewInputFit =
  | Readonly<{ kind: 'fits'; prompt: string; size: number; dropped: readonly ReviewInputDrop[] }>
  | Readonly<{
      kind: 'too-large';
      /** The packet after the trim, still over the limit. */
      prompt: string;
      size: number;
      limit: PromptLimit;
      dropped: readonly ReviewInputDrop[];
    }>;

export function fitReviewPrompt(
  input: Readonly<{
    prefix: string;
    prompt: FinalReviewPromptInput;
    limit: PromptLimit | undefined;
    /** The text the call appends after the packet; it counts toward the limit. */
    suffix: string;
    evidencePaths: Readonly<{ validation: string; sessionLog: string; drift: string }>;
  }>,
): ReviewInputFit {
  const prompt = { ...input.prompt };
  const dropped: ReviewInputDrop[] = [];
  const { limit } = input;
  let text = input.prefix + buildFinalReviewPrompt(prompt);
  if (limit === undefined) {
    return { kind: 'fits', prompt: text, size: text.length + input.suffix.length, dropped };
  }
  const sizeOf = (packet: string): number => packet.length + input.suffix.length;
  if (sizeOf(text) <= limit.max) {
    return { kind: 'fits', prompt: text, size: sizeOf(text), dropped };
  }

  const items: string[] = [];
  for (const [key, label, omitted] of [
    [
      'checksLog',
      'Checks Log',
      `Omitted for size; read ${input.evidencePaths.validation} for the checks and the isolation_outside_read warnings in ${input.evidencePaths.sessionLog}`,
    ],
    [
      'driftReport',
      'Deterministic Drift Report',
      `Omitted for size; read ${input.evidencePaths.drift}`,
    ],
  ] as const) {
    const evidence = prompt[key];
    if (evidence === undefined || evidence.length <= omitted.length) continue;
    items.push(label);
    prompt[key] = omitted;
  }
  if (items.length > 0) {
    dropped.push({ trim: 'task-evidence', items });
    prompt.trimmed = [
      `task-evidence: ${items.join(', ')}`,
      'You must read trimmed files in the workspace and must not report as verified anything you did not read.',
    ].join('\n');
  }
  text = input.prefix + buildFinalReviewPrompt(prompt);
  if (sizeOf(text) <= limit.max) {
    return { kind: 'fits', prompt: text, size: sizeOf(text), dropped };
  }
  return { kind: 'too-large', prompt: text, size: sizeOf(text), limit, dropped };
}
