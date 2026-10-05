import {
  REVIEW_INPUT_TRIMS,
  type ReviewInputTrim,
} from '../../../../core/schemas/review-packet.js';
import {
  buildFinalReviewPrompt,
  type FinalReviewPromptInput,
} from '../../../spec/prompts/review.js';

export type ReviewInputDrop = Readonly<{ trim: ReviewInputTrim; items: readonly string[] }>;
export type ReviewInputFit =
  | Readonly<{ kind: 'fits'; prompt: string; chars: number; dropped: readonly ReviewInputDrop[] }>
  | Readonly<{
      kind: 'too-large';
      chars: number;
      maxChars: number;
      dropped: readonly ReviewInputDrop[];
      largestFiles: readonly Readonly<{ path: string; chars: number }>[];
    }>;

export function largestReviewFiles(
  prompt: Pick<FinalReviewPromptInput, 'files' | 'workspaceContext'>,
): Readonly<{ path: string; chars: number }>[] {
  return [...(prompt.files ?? []), ...(prompt.workspaceContext ?? [])]
    .map((file) => ({ path: file.path, chars: file.diff.length }))
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 5);
}

export function fitReviewPrompt(
  input: Readonly<{
    prefix: string;
    prompt: FinalReviewPromptInput;
    maxChars: number | undefined;
    declared: (path: string) => boolean;
    evidencePaths: Readonly<{ validation: string; drift: string }>;
  }>,
): ReviewInputFit {
  const prompt = { ...input.prompt };
  const dropped: ReviewInputDrop[] = [];
  let text = input.prefix + buildFinalReviewPrompt(prompt);
  if (input.maxChars === undefined || text.length <= input.maxChars) {
    return { kind: 'fits', prompt: text, chars: text.length, dropped };
  }

  for (const trim of REVIEW_INPUT_TRIMS) {
    const items: string[] = [];
    switch (trim) {
      case 'full-file-context':
        for (const key of ['files', 'workspaceContext'] as const) {
          prompt[key] = prompt[key]?.map((file) => {
            if (!/^--- \/dev\/null$/m.test(file.diff)) return file;
            items.push(file.path);
            return {
              ...file,
              diff: `${file.diff.split('\n', 1).join('')}\n(whole new file omitted for size; read ${file.path} in the workspace)`,
            };
          });
        }
        break;
      case 'undeclared-file-diffs':
        for (const key of ['files', 'workspaceContext'] as const) {
          prompt[key] = prompt[key]?.filter((file) => {
            if (input.declared(file.path)) return true;
            items.push(file.path);
            return false;
          });
        }
        break;
      case 'task-evidence':
        for (const [key, label, path] of [
          ['validationEvidence', 'Recorded Validation Output', input.evidencePaths.validation],
          ['driftReport', 'Deterministic Drift Report', input.evidencePaths.drift],
        ] as const) {
          const omitted = `Omitted for size; read ${path}`;
          const evidence = prompt[key];
          if (evidence === undefined || evidence.length <= omitted.length) continue;
          items.push(label);
          prompt[key] = omitted;
        }
        break;
    }
    if (items.length > 0) {
      dropped.push({ trim, items });
      prompt.trimmed = [
        ...dropped.map((drop) => `${drop.trim}: ${drop.items.join(', ')}`),
        'You must read trimmed files in the workspace and must not report as verified anything you did not read.',
      ].join('\n');
    }
    text = input.prefix + buildFinalReviewPrompt(prompt);
    if (text.length <= input.maxChars) {
      return { kind: 'fits', prompt: text, chars: text.length, dropped };
    }
  }
  return {
    kind: 'too-large',
    chars: text.length,
    maxChars: input.maxChars,
    dropped,
    largestFiles: largestReviewFiles(input.prompt),
  };
}
