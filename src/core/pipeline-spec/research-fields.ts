import {
  isMarkdownFenceCloseLine,
  parseMarkdownFenceStart,
  parseMarkdownHeadingStart,
} from '../../utils/markdown/grammar.js';
import { headingMatchesSection } from './planner-documents.js';

/**
 * The body of the research document's Validation Tools section, under a heading of any level
 * that {@link headingMatchesSection} reads as it. It ends at the next heading of the same or a
 * higher level, or at a `---` rule.
 */
export function validationToolsSection(research: string): string | undefined {
  const lines = research.split(/\r?\n/);
  let fence: string | undefined;
  let level: number | undefined;
  const body: string[] = [];
  for (const line of lines) {
    if (fence !== undefined) {
      if (isMarkdownFenceCloseLine(line, fence)) fence = undefined;
      if (level !== undefined) body.push(line);
      continue;
    }
    const start = parseMarkdownFenceStart(line);
    if (start !== undefined) {
      fence = start.marker;
      if (level !== undefined) body.push(line);
      continue;
    }
    const heading = parseMarkdownHeadingStart(line);
    if (level === undefined) {
      if (heading !== undefined && headingMatchesSection(heading.text, 'Validation Tools')) {
        level = heading.marker.length;
      }
      continue;
    }
    if (heading !== undefined && heading.marker.length <= level) break;
    if (line.trim() === '---') break;
    body.push(line);
  }
  return level === undefined ? undefined : body.join('\n');
}

/**
 * The value of a `**Label**:` or `**Label:**` line: its leading code span, or the rest of the
 * line. A label with nothing after it takes the first bullet nested under it the same way.
 */
export function researchField(text: string, label: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const labelled = new RegExp(`\\*\\*${escapeRegExp(label)}(?::\\*\\*|\\*\\*:)[ \\t]*(.*)$`, 'i');
  for (let index = 0; index < lines.length; index++) {
    const rest = labelled.exec(lines[index] ?? '')?.[1]?.trim();
    if (rest === undefined) continue;
    if (rest !== '') return fieldValue(rest);
    const bullet = /^\s+[-*]\s+(.*)$/.exec(lines[index + 1] ?? '')?.[1]?.trim();
    return bullet === undefined || bullet === '' ? undefined : fieldValue(bullet);
  }
  return undefined;
}

function fieldValue(text: string): string | undefined {
  const value = (/^`([^`]+)`/.exec(text)?.[1] ?? text).trim();
  return value === '' ? undefined : value;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
