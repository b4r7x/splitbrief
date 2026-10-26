import { error, type AppError } from '../../utils/error.js';

/** The largest prompt a seat's tool takes, in the unit the tool counts. */
export type PromptLimit = Readonly<{ max: number; unit: 'characters' }>;

/** A too-large prompt's size and the limit it broke, in the unit the refusal counts. */
export type PromptSize = Readonly<{
  unit: 'characters';
  size: number | null;
  limit: number | null;
}>;

/** The figures a too-large refusal names: Codex counts characters, and Claude Code names none. */
export function inputTooLargeFigures(message: string): PromptSize {
  const chars = /"actual_chars"\s*:\s*(\d+)/.exec(message)?.[1];
  const maxChars =
    /"max_chars"\s*:\s*(\d+)/.exec(message)?.[1] ??
    /maximum length of (\d+) characters/i.exec(message)?.[1];
  return {
    unit: 'characters',
    size: chars === undefined ? null : Number(chars),
    limit: maxChars === undefined ? null : Number(maxChars),
  };
}

/**
 * A too-large prompt in SPLITBRIEF's words: its size and the tool's limit where the refusal
 * named them, never a figure it did not name.
 */
export function inputTooLargeSentence(subject: string, figures: PromptSize, tool: string): string {
  const { unit, size, limit } = figures;
  if (size === null) {
    return limit === null
      ? `${subject} is too large for ${tool}`
      : `${subject} is larger than the ${limit.toLocaleString('en-US')} ${unit} ${tool} takes`;
  }
  return `${subject} is ${size.toLocaleString('en-US')} ${unit}; ${tool} ${
    limit === null ? 'refused it as too large' : `takes at most ${limit.toLocaleString('en-US')}`
  }`;
}

/** The facts a halt keeps for a too-large prompt. */
export function inputTooLargeFacts({
  size,
  limit,
}: PromptSize): Record<string, number | undefined> {
  return { chars: size ?? undefined, maxChars: limit ?? undefined };
}

/** A prompt's size in each unit a tool's limit can count. */
export type PromptLength = Readonly<Record<PromptLimit['unit'], number>>;

export function promptLength(prompt: string): PromptLength {
  return { characters: prompt.length };
}

/**
 * The refusal SPLITBRIEF raises when a prompt it built is larger than the seat's
 * tool accepts, before sending it. Shaped like the tool's own refusal so the one
 * reader classifies both the same way.
 */
export function inputTooLargeRefusal(
  size: number,
  limit: PromptLimit,
): AppError<'input-too-large', { error: { code: 'input-too-large'; message: string } }> {
  const message = `Input exceeds the maximum length of ${limit.max} characters. (code -32602), data: {"input_error_code":"input_too_large","max_chars":${limit.max},"actual_chars":${size}}`;
  return error('input-too-large', message, {
    error: { code: 'input-too-large' as const, message },
  });
}
