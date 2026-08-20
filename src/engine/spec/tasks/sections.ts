import type { TaskId } from '../../../core/schemas/task.js';
import { extractFrontmatter } from '../../../utils/frontmatter.js';
import { TASK_BRIEF_HEADINGS } from '../headings.js';
import { fenceMarkerLength } from './fence-marker.js';

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

    const prefixed = Object.entries(sectionMap).find(([key]) => key.startsWith(`${header} (`));
    if (prefixed) return prefixed[1];
  }

  return '';
}

const KNOWN_SECTION_KEYS: readonly string[] = Object.values(TASK_BRIEF_HEADINGS).flatMap(
  (h) => h.keys,
);

function isKnownSectionKey(header: string): boolean {
  return KNOWN_SECTION_KEYS.some((key) => header === key || header.startsWith(`${key} (`));
}

export function unknownSectionHeaders(block: string): string[] {
  const { body } = extractFrontmatter(block);
  const unknown: string[] = [];
  let fenceLength = 0;

  for (const line of body.split('\n')) {
    const marker = fenceMarkerLength(line.trim());
    if (marker !== null) {
      if (fenceLength === 0) fenceLength = marker;
      else if (marker >= fenceLength) fenceLength = 0;
    }

    const headerMatch = fenceLength > 0 ? null : line.match(/^###\s+(.+)/);
    if (headerMatch?.[1]) {
      const header = headerMatch[1].trim();
      if (!isKnownSectionKey(header.toLowerCase())) unknown.push(header);
    }
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
    `Task ${id} has section(s) not in the Task Brief grammar and will be dropped: ${unknown.join(', ')}`,
  );
}

export function extractSections(block: string): ParsedTaskSections {
  const { body } = extractFrontmatter(block);

  const sectionMap: Record<string, string> = {};
  let currentHeader = '';
  let fenceLength = 0;
  const lines = body.split('\n');

  for (const line of lines) {
    const marker = fenceMarkerLength(line.trim());
    if (marker !== null) {
      if (fenceLength === 0) fenceLength = marker;
      else if (marker >= fenceLength) fenceLength = 0;
    }

    const headerMatch = fenceLength > 0 ? null : line.match(/^###\s+(.+)/);
    if (headerMatch?.[1]) {
      currentHeader = headerMatch[1].trim().toLowerCase();
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
  const inBounds: string[] = [];
  const outOfBounds: string[] = [];
  const approvedOutOfBounds: string[] = [];

  for (const line of text.split('\n')) {
    const labelMatch = line.match(/^\s*\*\*(.+?):\*\*\s*(.*)$/);
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
    const itemMatch = line.match(/^-\s+(.*)/);
    if (itemMatch?.[1] !== undefined && bucket) {
      const value = itemMatch[1].trim();
      if (bucket === 'in') inBounds.push(value);
      else if (bucket === 'out') outOfBounds.push(value);
      else approvedOutOfBounds.push(value);
    }
  }

  return { inBounds, outOfBounds, approvedOutOfBounds };
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

function extractListItems(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^-\s+(.*)/);
    if (m?.[1] !== undefined) items.push(m[1].trim());
  }
  return items;
}

function extractNumberedItems(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\d+\.\s+(.*)/);
    if (m?.[1] !== undefined) items.push(m[1].trim());
  }
  return items;
}
