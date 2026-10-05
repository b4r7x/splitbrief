import { error, type AppError } from '../../utils/error.js';

export function inputTooLargeFigures(message: string): {
  chars: number | null;
  maxChars: number | null;
} {
  const chars = /"actual_chars"\s*:\s*(\d+)/.exec(message)?.[1];
  const maxChars =
    /"max_chars"\s*:\s*(\d+)/.exec(message)?.[1] ??
    /maximum length of (\d+) characters/i.exec(message)?.[1];
  return {
    chars: chars === undefined ? null : Number(chars),
    maxChars: maxChars === undefined ? null : Number(maxChars),
  };
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
