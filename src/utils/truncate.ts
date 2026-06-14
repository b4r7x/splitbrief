export function truncateByChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + '\u2026';
}

export function truncateByLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n');
}

export function truncateByTailLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(-maxLines).join('\n');
}

export function truncateWithEllipsis(str: string, max: number): string {
  if (max <= 0) return '';
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '\u2026';
}
