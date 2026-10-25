import { error, type AppError } from '../../utils/error.js';

/** A too-large prompt's size and the limit it broke, in the unit the refusal counts. */
export type PromptSize = Readonly<{
  unit: 'characters' | 'bytes';
  size: number | null;
  limit: number | null;
}>;

const ARGV_REFUSAL = /CLI prompt is (\d+) bytes and exceeds the (\d+)-byte argv limit/;

/**
 * The figures a too-large refusal names: SPLITBRIEF's own command-line refusal counts bytes,
 * Codex counts characters, and Claude Code names none.
 */
export function inputTooLargeFigures(message: string): PromptSize {
  const argv = ARGV_REFUSAL.exec(message);
  if (argv !== null) return { unit: 'bytes', size: Number(argv[1]), limit: Number(argv[2]) };
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
 * The refusal SPLITBRIEF raises when a prompt is larger than a tool takes on its command line,
 * before it starts the tool. `inputTooLargeFigures` reads its figures back.
 */
export function argvPromptTooLarge(
  bytes: number,
  maxBytes: number,
): AppError<'argv-prompt-too-large'> {
  return error(
    'argv-prompt-too-large',
    `CLI prompt is ${bytes} bytes and exceeds the ${maxBytes}-byte argv limit`,
  );
}

/**
 * The refusal SPLITBRIEF raises when a prompt it built is larger than the seat's
 * tool accepts, before sending it. Shaped like the tool's own refusal so the one
 * reader classifies both the same way.
 */
export function inputTooLargeRefusal(
  chars: number,
  maxChars: number,
): AppError<'input-too-large', { error: { code: 'input-too-large'; message: string } }> {
  const message = `Input exceeds the maximum length of ${maxChars} characters. (code -32602), data: {"input_error_code":"input_too_large","max_chars":${maxChars},"actual_chars":${chars}}`;
  return error('input-too-large', message, {
    error: { code: 'input-too-large' as const, message },
  });
}
