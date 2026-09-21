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

/** A conversational reply, including a heading titled Questions, is not a completed document. */
export function isPlannerDocument(
  call: keyof typeof PLANNER_DOCUMENT_SECTIONS,
  text: string,
): boolean {
  const sections = new Set<string>();
  let current: Array<{ heading: string; level: number }> = [];
  let fence: string | undefined;
  const lines = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (fence !== undefined) {
      if (isMarkdownFenceCloseLine(line, fence)) fence = undefined;
      else if (line.trim() !== '') for (const section of current) sections.add(section.heading);
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
      current.push({ heading: heading.toLowerCase(), level });
      if (setext !== undefined) index++;
    } else if (line.trim() !== '') {
      for (const section of current) sections.add(section.heading);
    }
  }
  return PLANNER_DOCUMENT_SECTIONS[call].every((heading) => sections.has(heading.toLowerCase()));
}
