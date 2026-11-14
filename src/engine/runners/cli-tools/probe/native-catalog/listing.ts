import type { DetectedModel } from '../../../../../core/discovery/detection/model.js';
import {
  stripTerminalControls,
  normalizeDisplayLabel,
} from '../../../../../utils/display-text/sanitize.js';
import {
  type NativeCliModelCatalog,
  type NativeCliModelCatalogEntry,
  catalogFromEntries,
  nativeCliCatalogToDetectedModels,
} from './entries.js';

const CATALOG_HEADING_PATTERN = /^(?:available\s+)?models?\s*:?$/i;
const CURSOR_MODEL_LINE = /^(\S+) - (.+)$/;
// `cursor-agent --list-models` closes a row with one marker group, `current` before
// `default` (`auto - Auto (current, default)`). Verified in the 2026.09.18 bundle.
const CURSOR_MARKER_SUFFIX = /\s*\(((?:current|default)(?:, (?:current|default))?)\)$/;
// `copilot help config` prints the `--model` enum as quoted bullets under its
// `model` key, and a blank line separates the last bullet from the next config
// key, so the first non-bullet line ends the enum rather than interrupting it.
const COPILOT_MODEL_KEY_LINE = /^`model`:/;
const COPILOT_MODEL_BULLET = /^-\s+"([^"]+)"$/;
export const NATIVE_DEFAULT_SUFFIX = /\s*\(default\)$/i;

export function catalogLines(stdout: string): readonly string[] {
  return stripTerminalControls(stdout, { preserveLineBreaks: true }).split('\n');
}

export function cleanCatalogLines(stdout: string): readonly string[] {
  return catalogLines(stdout).map((line) => line.trim());
}

export function isCatalogHeading(value: string): boolean {
  return value.length === 0 || CATALOG_HEADING_PATTERN.test(value) || /^=+$/.test(value);
}

function parseDashSeparatedLines(
  input: Readonly<{
    tool: 'cursor';
    stdout: string;
    pattern: RegExp;
  }>,
): NativeCliModelCatalog | null {
  const entries: Omit<NativeCliModelCatalogEntry, 'nativeOrder'>[] = [];
  for (const line of cleanCatalogLines(input.stdout)) {
    if (isCatalogHeading(line)) continue;
    const match = input.pattern.exec(line);
    if (match === null) continue;
    const selectionId = match[1];
    const listedName = match[2];
    if (selectionId === undefined || listedName === undefined) continue;
    const markers = CURSOR_MARKER_SUFFIX.exec(listedName)?.[1]?.split(', ') ?? [];
    const displayName = normalizeDisplayLabel(listedName.replace(CURSOR_MARKER_SUFFIX, ''));
    entries.push({
      selectionId,
      ...(displayName.length === 0 ? {} : { displayName }),
      ...(markers.includes('default') ? { nativeDefault: true } : {}),
    });
  }
  return entries.length === 0 ? null : catalogFromEntries({ tool: input.tool, entries });
}

export function parseCursorNativeModelCatalog(stdout: string): NativeCliModelCatalog | null {
  return parseDashSeparatedLines({ tool: 'cursor', stdout, pattern: CURSOR_MODEL_LINE });
}

export function parseCopilotHelpConfigCatalog(stdout: string): NativeCliModelCatalog | null {
  const lines = cleanCatalogLines(stdout);
  const start = lines.findIndex((line) => COPILOT_MODEL_KEY_LINE.test(line));
  if (start === -1) return null;

  const entries: Omit<NativeCliModelCatalogEntry, 'nativeOrder'>[] = [];
  for (const line of lines.slice(start + 1)) {
    const selectionId = COPILOT_MODEL_BULLET.exec(line)?.[1];
    if (selectionId === undefined) break;
    entries.push({ selectionId });
  }
  return entries.length === 0 ? null : catalogFromEntries({ tool: 'copilot', entries });
}

// `agy models` prints `<id>\t<display name>` per model, one row per effort
// variant (`gemini-3.8-flash-high`), and sends its progress line to stderr. The
// tab is the only separator and `stripTerminalControls` turns it into a space, so
// a row is split before it is cleaned; a line without a tab carries no model.
export function parseAntigravityModelCatalog(stdout: string): NativeCliModelCatalog | null {
  const entries: Omit<NativeCliModelCatalogEntry, 'nativeOrder'>[] = [];
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const selectionId = stripTerminalControls(line.slice(0, tab)).trim();
    if (selectionId === '') continue;
    const displayName = stripTerminalControls(line.slice(tab + 1)).trim();
    entries.push({ selectionId, ...(displayName === '' ? {} : { displayName }) });
  }
  return entries.length === 0 ? null : catalogFromEntries({ tool: 'antigravity', entries });
}

export function parseCursorModels(stdout: string): DetectedModel[] | null {
  const catalog = parseCursorNativeModelCatalog(stdout);
  return catalog === null ? null : nativeCliCatalogToDetectedModels(catalog);
}
