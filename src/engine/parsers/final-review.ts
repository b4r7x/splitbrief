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
const BULLET = String.raw`(?:[-*]|\d+[.)])\s+`;
const CRITERION_BULLET_RE = new RegExp(
  String.raw`^\s*${BULLET}\*{0,2}\[(pass|fail)\]\*{0,2}\s+(.*)$`,
  'i',
);
const SEVERITY = '(critical|warning|note)s?';
// A label opens its line, behind a bullet (`-`, `*`, `1.`) or none: `- **Critical**: text`,
// `**Critical:** text`, `**Critical (1)**:`, `- **Critical** — text`, `**Critical**` alone,
// `- **[Critical]** text`, and behind a bullet `- Critical: text`. A bold word in prose is no
// label: text after the bold needs the colon or a spaced dash. Each form captures the indent, the
// bullet, the severity and the text.
const LABEL_FORMS = [
  new RegExp(
    String.raw`^(\s*)(${BULLET})?\*\*${SEVERITY}(?:\s+\(?\d+\)?)?(?:\*\*\s*:|:\*\*|\*\*\s*[—–-](?=\s)|\*\*(?=\s*$))(.*)$`,
    'i',
  ),
  new RegExp(String.raw`^(\s*)(${BULLET})?(?:\*\*)?\[${SEVERITY}\](?:\*\*)?:?(.*)$`, 'i'),
  new RegExp(String.raw`^(\s*)(${BULLET})${SEVERITY}:(.*)$`, 'i'),
];
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
// Longest first, so `pass_with_notes` is never read as a bare `pass`; its words may be spaced or
// hyphenated: `Pass with notes`, `pass-with-notes`.
const VERDICT_ALTERNATIVES = [...VERDICT_RULES.words]
  .sort((a, b) => b.length - a.length)
  .map((word) => word.replaceAll('_', '[ \\t_-]+'))
  .join('|');
const VERDICT_WORD_RE = new RegExp(`\\b(${VERDICT_ALTERNATIVES})\\b`, 'gi');
// A line led by its verdict, alone or before punctuation: `**PASS**`, `Pass — the reason`.
// `pass with minor notes` is no lead: prose follows the word.
const LEADING_VERDICT_RE = new RegExp(
  String.raw`^[\s*_\`>]*(${VERDICT_ALTERNATIVES})[*_\`]*\s*(?:$|[—–:.,;(]|-\s)`,
  'i',
);
// `### Verdict`, or the verdict on the heading line itself: `### Verdict: pass`.
const VERDICT_HEADING_RE = /^#{1,6}\s+[*_]*verdict[*_]*\s*[:—–-]?\s*(.*)$/i;

/** The text a verdict heading carries on its own line, or null for any other line. */
function verdictHeadingTail(line: string): string | null {
  const tail = line.match(VERDICT_HEADING_RE)?.[1]?.trim();
  if (tail === undefined) return null;
  return tail === '' || LEADING_VERDICT_RE.test(tail) ? tail : null;
}

/** The section under the first heading `headingTail` accepts, led by the text on that heading. */
function extractSection(lines: string[], headingTail: (line: string) => string | null): string[] {
  const start = lines.findIndex((line) => headingTail(line.trim()) !== null);
  if (start === -1) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && HEADING_RE.test(line.trim())) {
      end = i;
      break;
    }
  }
  return [headingTail(lines[start]?.trim() ?? '') ?? '', ...lines.slice(start + 1, end)];
}

/**
 * A section whose first line leads with a verdict is that verdict, whatever its reason names;
 * otherwise the section must carry exactly one verdict word.
 */
function parseVerdict(section: string[]): ReviewVerdict | null {
  const lead = section.find((line) => line.trim() !== '')?.match(LEADING_VERDICT_RE)?.[1];
  const words = section.join('\n').match(VERDICT_WORD_RE);
  const word = lead ?? (words?.length === 1 ? words[0] : undefined);
  if (word === undefined) return null;
  const result = ReviewVerdictSchema.safeParse(word.toLowerCase().replace(/[\s_-]+/g, '_'));
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

function matchLabel(line: string): RegExpMatchArray | null {
  for (const form of LABEL_FORMS) {
    const match = line.match(form);
    if (match !== null) return match;
  }
  return null;
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
  const lines = markdown.split(/\r?\n/);
  const verdictSection = extractSection(lines, verdictHeadingTail);
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
    const label = matchLabel(line);
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
