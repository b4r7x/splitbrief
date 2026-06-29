import type { BriefQualityReport } from '../../engine/spec/brief-quality.js';
import { countNoun } from '../../utils/pluralize.js';
import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';

export function formatQualityDisplay(quality: BriefQualityReport | null): string {
  if (quality === null) return 'quality n/a';
  return `quality ${quality.score.toFixed(2)}`;
}

export function formatTaskCount(count: number): string {
  return countNoun(count, 'task');
}

export function sanitizeTaskDisplayText(text: string): string {
  return sanitizeTerminalDisplayText(text);
}
