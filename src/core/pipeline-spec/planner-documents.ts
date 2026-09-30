import {
  isMarkdownFenceCloseLine,
  parseMarkdownFenceStart,
  parseMarkdownHeadingStart,
  parseMarkdownSetextHeadingStart,
} from '../../utils/markdown/grammar.js';

export const PLANNER_DOCUMENT_SECTIONS = {
  research: [
    'Project Overview',
    'Architecture',
    'Relevant Code',
    'Patterns to Follow',
    'Dependencies & Constraints',
    'Implementation Considerations',
    'Validation Tools',
  ],
  spec: [
    'Overview',
    'User Scenarios',
    'Acceptance Criteria',
    'Functional Requirements',
    'Non-Functional Requirements',
    'Out of Scope',
  ],
  plan: [
    'Summary',
    'Architecture Decisions',
    'File Structure',
    'Dependencies',
    'Data Model',
    'Key Implementation Details',
    'Testing Strategy',
  ],
} as const;

type PlannerDocumentCall = keyof typeof PLANNER_DOCUMENT_SECTIONS;

const QUALIFIER_SEPARATORS = [' (', ':', ' —', ' –', ' - '] as const;

/** `## Architecture (the parts P01 touches)` names Architecture; `## Architecture Decisions` does not. */
export function headingMatchesSection(heading: string, section: string): boolean {
  const name = section.trim().toLowerCase();
  const text = heading
    .trim()
    .toLowerCase()
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^(\*\*|__)(.*)\1$/, '$2')
    .trim();
  if (text === name) return true;
  if (!text.startsWith(name)) return false;
  const rest = text.slice(name.length);
  return QUALIFIER_SEPARATORS.some((separator) => rest.startsWith(separator));
}

/** A conversational reply, including a heading titled Questions, is not a completed document. */
export function isPlannerDocument(call: PlannerDocumentCall, text: string): boolean {
  return missingPlannerDocumentSections(call, text).length === 0;
}

/**
 * The required sections no heading with a body names. A reply whose document sits inside one
 * top-level md fence is read as that document, the way {@link plannerDocumentText} persists it.
 */
export function missingPlannerDocumentSections(call: PlannerDocumentCall, text: string): string[] {
  const missing = missingSections(call, text);
  if (missing.length === 0) return missing;
  const unwrapped = unwrapMarkdownFence(text);
  if (unwrapped !== undefined && missingSections(call, unwrapped).length === 0) return [];
  return missing;
}

/** The document to persist: the reply itself, or the inside of the md fence that wraps it. */
export function plannerDocumentText(call: PlannerDocumentCall, text: string): string | undefined {
  if (missingSections(call, text).length === 0) return text;
  const unwrapped = unwrapMarkdownFence(text);
  if (unwrapped !== undefined && missingSections(call, unwrapped).length === 0) return unwrapped;
  return undefined;
}

/** What an empty ⏎ on a planner reply sends: continue, and return the step's whole artifact. */
export function emptyReplyContinuation(call: string, pendingText: string): string {
  if (!isDocumentCall(call)) {
    const artifact = call === 'tasks' ? 'tasks.md' : call;
    return `No further input: proceed with your best judgement and return the complete ${artifact} content as your whole reply.`;
  }
  const base = `No further input: proceed with your best judgement. Return the complete ${call} document as your whole reply, with these exact section headings: ${PLANNER_DOCUMENT_SECTIONS[call].join(', ')}.`;
  const missing = missingPlannerDocumentSections(call, pendingText);
  return missing.length === 0 ? base : `${base} Missing or unrecognised: ${missing.join(', ')}.`;
}

function isDocumentCall(call: string): call is PlannerDocumentCall {
  return Object.hasOwn(PLANNER_DOCUMENT_SECTIONS, call);
}

function missingSections(call: PlannerDocumentCall, text: string): string[] {
  const headings: string[] = [];
  let current: Array<{ heading: string; level: number }> = [];
  let fence: string | undefined;
  const lines = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (fence !== undefined) {
      if (isMarkdownFenceCloseLine(line, fence)) fence = undefined;
      else if (line.trim() !== '') for (const section of current) headings.push(section.heading);
      continue;
    }
    const start = parseMarkdownFenceStart(line);
    if (start !== undefined) {
      fence = start.marker;
      continue;
    }
    const atx = parseMarkdownHeadingStart(line);
    const setext =
      atx === undefined ? parseMarkdownSetextHeadingStart(line, lines[index + 1]) : undefined;
    const heading = atx?.text ?? setext?.text;
    if (heading !== undefined) {
      const level = atx?.marker.length ?? (setext?.marker === '=' ? 1 : 2);
      current = current.filter((section) => section.level < level);
      current.push({ heading, level });
      if (setext !== undefined) index++;
    } else if (line.trim() !== '') {
      for (const section of current) headings.push(section.heading);
    }
  }
  return PLANNER_DOCUMENT_SECTIONS[call].filter(
    (section) => !headings.some((heading) => headingMatchesSection(heading, section)),
  );
}

/**
 * The inside of the first top-level ```md or ```markdown fence, narration around it dropped.
 * The rules that keep the document's own fences from closing it mirror
 * `unwrapFencedTaskDocument` (`src/engine/spec/tasks/blocks.ts`): a closer is at least as long
 * as the opener and carries no info string, and the fences passed inside must pair up.
 */
function unwrapMarkdownFence(text: string): string | undefined {
  const lines = text.split('\n');
  let open: { index: number; marker: string } | undefined;
  let innerFences = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const start = parseMarkdownFenceStart(line);
    if (open === undefined) {
      if (start !== undefined && /^(?:md|markdown)$/i.test(start.language ?? '')) {
        open = { index, marker: start.marker };
      }
      continue;
    }
    if (isMarkdownFenceCloseLine(line, open.marker) && innerFences % 2 === 0) {
      return lines.slice(open.index + 1, index).join('\n');
    }
    if (start !== undefined) innerFences++;
  }
  return open === undefined ? undefined : lines.slice(open.index + 1).join('\n');
}
