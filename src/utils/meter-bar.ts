export function renderMeterBar(value: number, max: number, width: number): string {
  if (max <= 0) return '░'.repeat(width);
  const filled = Math.round((Math.min(value, max) / max) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}
