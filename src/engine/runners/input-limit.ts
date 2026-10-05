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
