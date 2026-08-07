import { z } from 'zod';
import { ReviewFindingSeveritySchema, ReviewVerdictSchema } from '../../core/schemas/summary.js';

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
const FINDING_BULLET_RE = /^-\s+\*\*(critical|warning|note)\*\*\s*:\s+(.*)$/i;
const VERDICT_WORD_RE = /\b(pass_with_notes|fail|pass)\b/g;

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

function parseFindingLine(line: string): { severity: ReviewFindingSeverity; text: string } | null {
  const match = line.match(FINDING_BULLET_RE);
  if (match === null) return null;
  const severity = ReviewFindingSeveritySchema.safeParse(match[1]?.toLowerCase());
  const text = match[2];
  if (!severity.success || text === undefined) return null;
  return { severity: severity.data, text: text.trim() };
}

export function parseFinalReview(markdown: string): ParsedFinalReview {
  const lines = markdown.split('\n');
  const verdictSection = extractSection(lines, (line) => VERDICT_HEADING_RE.test(line));
  const criteria: ParsedFinalReview['criteria'] = [];
  const findings: ParsedFinalReview['findings'] = [];

  for (const line of lines) {
    const criterion = parseCriterionLine(line);
    if (criterion !== null) {
      criteria.push(criterion);
      continue;
    }
    const finding = parseFindingLine(line);
    if (finding !== null) findings.push(finding);
  }

  return { verdict: parseVerdict(verdictSection), criteria, findings };
}
