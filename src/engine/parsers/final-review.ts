import { z } from 'zod';
import { ReviewFindingSeveritySchema, ReviewVerdictSchema } from '../../core/schemas/summary.js';
import { VERDICT_RULES } from '../../core/pipeline-spec/review.js';

export const ParsedFinalReviewSchema = z.object({
  verdict: ReviewVerdictSchema.nullable(),
  criteria: z.array(z.object({ passed: z.boolean(), text: z.string() })),
  findings: z.array(z.object({ severity: ReviewFindingSeveritySchema, text: z.string() })),
});

export type ParsedFinalReview = z.infer<typeof ParsedFinalReviewSchema>;

type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
type ReviewFindingSeverity = z.infer<typeof ReviewFindingSeveritySchema>;

const HEADING_RE = /^#{1,6}\s+\S/;
const VERDICT_HEADING_RE = /^#{1,6}\s+verdict\s*$/i;
const CRITERION_BULLET_RE = /^-\s+\*{0,2}\[(pass|fail)\]\*{0,2}\s+(.*)$/i;
const BULLET = String.raw`(?:[-*]|\d+[.)])\s+`;
// A label opens its line, behind a bullet (`-`, `*`, `1.`) or none: `- **Critical**: text`,
// `**Critical:** text`, `**Critical (1)**:`, or `**Critical**` alone. A bold word in prose is no
// label: text after the bold needs the colon.
const LABEL_RE = new RegExp(
  String.raw`^(\s*)(${BULLET})?\*\*(critical|warning|note)s?(?:\s+\(?\d+\)?)?(?:\*\*\s*:|:\*\*|\*\*(?=\s*$))(.*)$`,
  'i',
);
// `**Warning 1 — the title.**`, bulleted or not, is a finding of its own.
const TITLED_FINDING_RE = new RegExp(
  String.raw`^\s*(?:${BULLET})?\*\*(critical|warning|note)(?:\s+\d+)?\s+[—–-]\s+(.+?)\*\*$`,
  'i',
);
// `### Critical` heads the bullets under it; `### Critical: text` is a finding.
const SEVERITY_HEADING_RE = /^#{1,6}\s+(critical|warning|note)s?\b[^:]*(?::(.*))?$/i;
const LIST_ITEM_RE = new RegExp(String.raw`^(\s*)${BULLET}(.*)$`);
// The words a reviewer writes into an empty category, alone or with a reason after punctuation:
// `None`, `None found`, `None of note`, `N/A`, `Not applicable`, `Nothing to report`,
// `No critical issues found`, `0`, a dash, or nothing. "None of the error paths are tested",
// "None found except X", "No tests cover X" and "N/A values crash the parser" are findings.
const NO_FINDING_RE = new RegExp(
  [
    String.raw`^(?:[—–-]?|0|(?:none(?:\s+(?:of\s+note|found|identified|to report|noted))?`,
    String.raw`|n\/a|not applicable|nothing(?:\s+(?:to report|found|of note))?`,
    String.raw`|no\s+(?:\w+\s+)?(?:issues?|findings?|problems?|concerns?)`,
    String.raw`(?:\s+(?:were\s+)?(?:found|identified|to report))?)(?:\s*[.,;:!—–-].*)?)$`,
  ].join(''),
  'i',
);
// Longest first, so `pass_with_notes` is never read as a bare `pass`.
const VERDICT_WORD_RE = new RegExp(
  `\\b(${[...VERDICT_RULES.words].sort((a, b) => b.length - a.length).join('|')})\\b`,
  'g',
);

function extractSection(lines: string[], matchesHeading: (line: string) => boolean): string[] {
  const start = lines.findIndex((line) => matchesHeading(line.trim()));
  if (start === -1) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && HEADING_RE.test(line.trim())) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

function parseVerdict(section: string[]): ReviewVerdict | null {
  const words = section.join('\n').match(VERDICT_WORD_RE);
  if (words === null || words.length !== 1) return null;
  const result = ReviewVerdictSchema.safeParse(words[0]);
  return result.success ? result.data : null;
}

function parseCriterionLine(line: string): { passed: boolean; text: string } | null {
  const match = line.match(CRITERION_BULLET_RE);
  if (match === null) return null;
  const mark = match[1];
  const text = match[2];
  if (mark === undefined || text === undefined) return null;
  return { passed: mark.toLowerCase() === 'pass', text: text.trim() };
}

function severityOf(label: string | undefined): ReviewFindingSeverity {
  return ReviewFindingSeveritySchema.parse(label?.toLowerCase());
}

/**
 * A label with no text heads the bullets under it: an empty label bullet owns the sub-bullets
 * indented under it, and a label line or a `### Critical` heading owns the bullets below it.
 * The first bullet sets the depth of the category's findings; a deeper one is its detail.
 */
type OpenCategory = {
  severity: ReviewFindingSeverity;
  labelIndent: number;
  itemIndent: number | null;
};

export function parseFinalReview(markdown: string): ParsedFinalReview {
  const lines = markdown.split('\n');
  const verdictSection = extractSection(lines, (line) => VERDICT_HEADING_RE.test(line));
  const criteria: ParsedFinalReview['criteria'] = [];
  const findings: ParsedFinalReview['findings'] = [];
  // Emphasis, inline code and parentheses around the words change nothing: `_None._`, `(none)`.
  const addFinding = (severity: ReviewFindingSeverity, text: string): void => {
    if (!NO_FINDING_RE.test(text.replace(/[*_`()]/g, '').trim())) {
      findings.push({ severity, text });
    }
  };
  let category: OpenCategory | null = null;

  for (const line of lines) {
    const criterion = parseCriterionLine(line);
    if (criterion !== null) {
      criteria.push(criterion);
      category = null;
      continue;
    }
    const label = line.match(LABEL_RE);
    if (label !== null) {
      const severity = severityOf(label[3]);
      const text = label[4]?.trim() ?? '';
      const labelIndent = label[2] === undefined ? -1 : (label[1]?.length ?? 0);
      category = text === '' ? { severity, labelIndent, itemIndent: null } : null;
      addFinding(severity, text);
      continue;
    }
    const titled = line.match(TITLED_FINDING_RE);
    if (titled !== null) {
      addFinding(severityOf(titled[1]), titled[2]?.trim() ?? '');
      category = null;
      continue;
    }
    const heading = line.trim().match(SEVERITY_HEADING_RE);
    if (heading !== null) {
      const severity = severityOf(heading[1]);
      const text = heading[2]?.trim() ?? '';
      category = text === '' ? { severity, labelIndent: -1, itemIndent: null } : null;
      addFinding(severity, text);
      continue;
    }
    if (HEADING_RE.test(line.trim())) {
      category = null;
      continue;
    }
    if (category === null || line.trim() === '') continue;
    const item = line.match(LIST_ITEM_RE);
    const indent = item?.[1]?.length ?? 0;
    if (item !== null && indent > category.labelIndent) {
      category.itemIndent ??= indent;
      if (indent <= category.itemIndent) addFinding(category.severity, item[2]?.trim() ?? '');
      continue;
    }
    // A line at the label's depth ends the category; an indented one belongs to the finding above.
    if (item !== null || !/^\s/.test(line)) category = null;
  }

  return { verdict: parseVerdict(verdictSection), criteria, findings };
}
