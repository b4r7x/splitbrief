import { stripVendorPrefix } from '../../../core/model-display.js';

const DATE_SUFFIX_RE = /[-_.]?\d{8}$/;
const CLAUDE_DOTTED_VERSION_RE = /claude-([a-z0-9-]+)-(\d+)\.(\d+)/g;

function normalizeModelKey(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(CLAUDE_DOTTED_VERSION_RE, 'claude-$1-$2-$3')
    .replace(DATE_SUFFIX_RE, '');
}

export function buildComparableKeys(modelId: string): string[] {
  const stripped = stripVendorPrefix(modelId);
  const keys = new Set([normalizeModelKey(modelId), normalizeModelKey(stripped)]);
  return [...keys];
}

export function idsMatch(a: string, b: string): boolean {
  const aKeys = new Set(buildComparableKeys(a));
  return buildComparableKeys(b).some((key) => aKeys.has(key));
}
