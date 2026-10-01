import type { TaskId } from '../../../core/schemas/task.js';
import { extractFrontmatter } from '../../../utils/frontmatter.js';
import { countNoun } from '../../../utils/pluralize.js';
import { headingMatchesSection } from '../../../core/pipeline-spec/planner-documents.js';
import { TASK_BRIEF_HEADINGS } from '../headings.js';
import { closesOpenFence, fenceMarkerLength } from './fence-marker.js';
import { isScopePlaceholder } from '../../../core/scope/declared-set.js';

export type ParsedTaskSections = {
  description: string;
  signature: string;
  tests: string[];
  constraints: string[];
  pattern: string;
  currentCode: string;
  typeDefs: string;
  implementationSteps: string[];
  scopeInBounds: string[];
  scopeOutOfBounds: string[];
  scopeApprovedOutOfBounds: string[];
  escalation: string[];
  evidence: string[];
};

function readSection(sectionMap: Record<string, string>, ...headers: readonly string[]): string {
  for (const header of headers) {
    const exact = sectionMap[header];
    if (exact !== undefined) return exact;

    const qualified = Object.entries(sectionMap).find(([key]) =>
      headingMatchesSection(key, header),
    );
    if (qualified) return qualified[1];
  }

  return '';
}

const KNOWN_SECTION_KEYS: readonly string[] = Object.values(TASK_BRIEF_HEADINGS).flatMap(
  (h) => h.keys,
);

function isKnownSectionKey(header: string): boolean {
  return KNOWN_SECTION_KEYS.some((key) => headingMatchesSection(header, key));
}

/**
 * The section a heading line opens, lowercased with its number and bold stripped. `###` is the
 * grammar's level and always opens a section; planners also write `##` and `####`, which open one
 * only when they name a known section, so a `## Phase 2` rule between briefs or a `#### Parser`
 * sub-heading inside a section stays body text.
 */
function sectionHeader(line: string): string | undefined {
  const match = /^(#{2,4})\s+(.+)/.exec(line);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const header = match[2]
    .trim()
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .trim();
  if (match[1] === '###' || isKnownSectionKey(header.toLowerCase())) return header;
  return undefined;
}

export function unknownSectionHeaders(block: string): string[] {
  const { body } = extractFrontmatter(block);
  const unknown: string[] = [];
  let fenceLength = 0;
  let fenceInfo = '';

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    const markerLength = fenceMarkerLength(trimmed);
    if (markerLength !== null) {
      const markerInfo = trimmed.slice(markerLength).trim();
      if (fenceLength === 0) {
        fenceLength = markerLength;
        fenceInfo = markerInfo;
      } else if (closesOpenFence({ fenceLength, fenceInfo, markerLength, markerInfo })) {
        fenceLength = 0;
        fenceInfo = '';
      }
    }

    const header = fenceLength > 0 ? undefined : sectionHeader(line);
    if (header !== undefined && !isKnownSectionKey(header.toLowerCase())) unknown.push(header);
  }

  return unknown;
}

export function warnUnknownSections(
  block: string,
  id: TaskId,
  onWarning: (message: string) => void,
): void {
  const unknown = unknownSectionHeaders(block);
  if (unknown.length === 0) return;
  onWarning(
    `Task ${id} has ${countNoun(unknown.length, 'section')} not in the Task Brief grammar; ${unknown.length === 1 ? 'it' : 'they'} will be dropped: ${unknown.join(', ')}`,
  );
}

export function extractSections(block: string): ParsedTaskSections {
  const { body } = extractFrontmatter(block);

  const sectionMap: Record<string, string> = {};
  let currentHeader = '';
  let fenceLength = 0;
  let fenceInfo = '';
  const lines = body.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    const markerLength = fenceMarkerLength(trimmed);
    if (markerLength !== null) {
      const markerInfo = trimmed.slice(markerLength).trim();
      if (fenceLength === 0) {
        fenceLength = markerLength;
        fenceInfo = markerInfo;
      } else if (closesOpenFence({ fenceLength, fenceInfo, markerLength, markerInfo })) {
        fenceLength = 0;
        fenceInfo = '';
      }
    }

    const header = fenceLength > 0 ? undefined : sectionHeader(line);
    if (header !== undefined) {
      currentHeader = header.toLowerCase();
    } else if (currentHeader) {
      sectionMap[currentHeader] = (sectionMap[currentHeader] ?? '') + line + '\n';
    }
  }

  const scopeText = readSection(sectionMap, ...TASK_BRIEF_HEADINGS.scope.keys);
  const { inBounds, outOfBounds, approvedOutOfBounds } = extractScopeBuckets(scopeText);

  return {
    description: readSection(sectionMap, ...TASK_BRIEF_HEADINGS.description.keys).trim(),
    signature: extractCodeBlock(readSection(sectionMap, ...TASK_BRIEF_HEADINGS.signature.keys)),
    tests: extractListItems(readSection(sectionMap, ...TASK_BRIEF_HEADINGS.tests.keys)),
    constraints: extractListItems(readSection(sectionMap, ...TASK_BRIEF_HEADINGS.constraints.keys)),
    pattern: readSection(sectionMap, ...TASK_BRIEF_HEADINGS.pattern.keys).trim(),
    currentCode: extractCodeBlock(
      readSection(sectionMap, ...TASK_BRIEF_HEADINGS.currentCode.keys),
    ).trim(),
    typeDefs: extractCodeBlock(readSection(sectionMap, ...TASK_BRIEF_HEADINGS.typeDefs.keys)),
    implementationSteps: extractNumberedItems(
      readSection(sectionMap, ...TASK_BRIEF_HEADINGS.implementationSteps.keys),
    ),
    scopeInBounds: inBounds,
    scopeOutOfBounds: outOfBounds,
    scopeApprovedOutOfBounds: approvedOutOfBounds,
    escalation: extractListItems(readSection(sectionMap, ...TASK_BRIEF_HEADINGS.escalation.keys)),
    evidence: extractListItems(readSection(sectionMap, ...TASK_BRIEF_HEADINGS.evidence.keys)),
  };
}

function extractScopeBuckets(text: string): {
  inBounds: string[];
  outOfBounds: string[];
  approvedOutOfBounds: string[];
} {
  if (!text.trim()) return { inBounds: [], outOfBounds: [], approvedOutOfBounds: [] };

  type Bucket = 'in' | 'out' | 'approved' | null;
  let bucket: Bucket = null;
  const buckets: Record<Exclude<Bucket, null>, string[]> = { in: [], out: [], approved: [] };
  for (const line of text.split('\n')) {
    const labelMatch = line.match(/^\s*\*\*(.+?)(?::\*\*|\*\*:)\s*(.*)$/);
    if (labelMatch?.[1] !== undefined) {
      const label = labelMatch[1].trim().toLowerCase();
      if (label === 'in bounds' || label === 'in-bounds' || label === 'in') bucket = 'in';
      else if (label === 'out of bounds' || label === 'out-of-bounds' || label === 'out')
        bucket = 'out';
      else if (
        label === 'approved out of bounds' ||
        label === 'approved-out-of-bounds' ||
        label === 'approved'
      )
        bucket = 'approved';
      else bucket = null;
      continue;
    }
    if (bucket) buckets[bucket].push(line);
  }

  const items = (lines: string[]) =>
    topLevelItems(lines.join('\n'), BULLET_RE).filter((item) => !isScopePlaceholder(item));
  return {
    inBounds: items(buckets.in),
    outOfBounds: items(buckets.out),
    approvedOutOfBounds: items(buckets.approved),
  };
}

function extractCodeBlock(text: string): string {
  const lines = text.split('\n');

  let openIndex = -1;
  let openLength = 0;
  for (let i = 0; i < lines.length; i++) {
    const marker = fenceMarkerLength((lines[i] ?? '').trim());
    if (marker !== null) {
      openIndex = i;
      openLength = marker;
      break;
    }
  }
  if (openIndex === -1) return text.trim();

  let closeIndex = -1;
  for (let i = lines.length - 1; i > openIndex; i--) {
    const marker = fenceMarkerLength((lines[i] ?? '').trim());
    if (marker !== null && marker >= openLength) {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) return text.trim();

  return lines
    .slice(openIndex + 1, closeIndex)
    .join('\n')
    .trim();
}

const BULLET_RE = /^(\s*)[-*]\s+(.*)/;
const NUMBERED_RE = /^(\s*)\d+[.)]\s+(.*)/;

function extractListItems(text: string): string[] {
  return topLevelItems(text, BULLET_RE);
}

function extractNumberedItems(text: string): string[] {
  const numbered = topLevelItems(text, NUMBERED_RE);
  return numbered.length > 0 ? numbered : topLevelItems(text, BULLET_RE);
}

/** The items at the list's own indent; bullets nested deeper belong to the item above them. */
function topLevelItems(text: string, item: RegExp): string[] {
  const matches = text
    .split('\n')
    .map((line) => item.exec(line))
    .filter((match) => match !== null);
  const indent = Math.min(...matches.map((match) => match[1]?.length ?? 0));
  return matches
    .filter((match) => (match[1]?.length ?? 0) === indent)
    .map((match) => (match[2] ?? '').trim());
}
