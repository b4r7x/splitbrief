import type {
  MarkdownRenderSegment,
  MarkdownSegmentDecorator,
} from '../../../../components/markdown.js';
import type { Theme } from '../../../../components/theme.js';
import { TaskIdSchema } from '../../../../core/schemas/task.js';
import { stripTerminalControls } from '../../../../utils/display-text.js';
import type {
  MarkdownHighlightScope,
  MarkdownLayoutSegment,
} from '../../../../utils/markdown/types.js';
import { assertNever } from '../../../../utils/type-guards.js';
import {
  filePathUrl,
  projectRelativePathLabel,
  resolveMarkdownLinkTarget,
} from '../../../../utils/path-links.js';
import type { ConversationRowSegment, ConversationRowTone } from '../types.js';

type WorkflowMarkdownMarkerKind = 'taskId' | 'filePath' | 'status' | 'risk';

type WorkflowMarkdownPart =
  | { kind: 'base'; segment: MarkdownLayoutSegment }
  | { kind: WorkflowMarkdownMarkerKind; text: string; suppressHref?: boolean };

interface WorkflowMarkerMatch {
  kind: WorkflowMarkdownMarkerKind;
  text: string;
}

const STATUS_MARKERS: readonly string[] = [
  'NOT VERIFIED',
  'INCONCLUSIVE',
  'VERIFIED',
  'BLOCKED',
  'FAILED',
  'FAIL',
  'ERROR',
  'WARN',
  'WARNING',
  'DONE',
  'PASS',
  'OK',
];

const PROSE_STATUS_MARKERS: readonly string[] = [
  'NOT VERIFIED',
  'INCONCLUSIVE',
  'VERIFIED',
  'BLOCKED',
  'FAILED',
];

const RISK_MARKERS: readonly string[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const TASK_ID_PATTERN = /^T\d{3}/;
const FILE_PATH_PATTERN =
  /^(?:\.{1,2}\/|\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.[A-Za-z0-9]+(?::\d+)?/;

export function workflowMarkdownConversationSegments(
  segment: MarkdownLayoutSegment,
  options: { projectDir: string | undefined; previousLineText?: string | undefined },
): ConversationRowSegment[] {
  return workflowMarkdownParts(segment, {
    statusMarkers: STATUS_MARKERS,
    previousLineText: options.previousLineText,
  }).map((part) => workflowMarkdownPartToConversationSegment(part, options.projectDir));
}

export const workflowMarkdownRenderSegments: MarkdownSegmentDecorator = ({
  segment,
  theme,
  projectDir,
  previousLineText,
}) =>
  workflowMarkdownParts(segment, {
    statusMarkers: PROSE_STATUS_MARKERS,
    previousLineText,
  }).map((part) => workflowMarkdownPartToRenderSegment(part, theme, projectDir));

function workflowMarkdownParts(
  segment: MarkdownLayoutSegment,
  options: { statusMarkers: readonly string[]; previousLineText: string | undefined },
): WorkflowMarkdownPart[] {
  const cleanSegment = cloneSegmentWithText(segment, stripTerminalControls(segment.text));
  if (!isWorkflowScannableSegment(cleanSegment)) return [{ kind: 'base', segment: cleanSegment }];

  // A column-0 match continuing a hard-wrapped word is a fragment of a longer path; minting an
  // href for it would target a fabricated file, so it keeps the dim label only.
  const suppressLeadingFilePathHref =
    options.previousLineText !== undefined && /[A-Za-z0-9_./-]$/.test(options.previousLineText);
  const parts: WorkflowMarkdownPart[] = [];
  let buffer = '';
  let index = 0;

  while (index < cleanSegment.text.length) {
    const marker = matchWorkflowMarkerAt(cleanSegment.text, index, options.statusMarkers);
    if (!marker) {
      buffer += cleanSegment.text[index] ?? '';
      index += 1;
      continue;
    }

    if (buffer.length > 0) {
      parts.push({ kind: 'base', segment: cloneSegmentWithText(cleanSegment, buffer) });
      buffer = '';
    }

    parts.push(
      marker.kind === 'filePath' && index === 0 && suppressLeadingFilePathHref
        ? { ...marker, suppressHref: true }
        : marker,
    );
    index += marker.text.length;
  }

  if (buffer.length > 0) {
    parts.push({ kind: 'base', segment: cloneSegmentWithText(cleanSegment, buffer) });
  }

  return parts;
}

function cloneSegmentWithText(segment: MarkdownLayoutSegment, text: string): MarkdownLayoutSegment {
  return { ...segment, text };
}

function isWorkflowScannableSegment(segment: MarkdownLayoutSegment): boolean {
  switch (segment.kind) {
    case 'text':
    case 'heading':
    case 'metadata':
    case 'bold':
    case 'italic':
    case 'boldItalic':
    case 'strikethrough':
    case 'tableHeader':
      return true;
    case 'code':
    case 'rule':
    case 'listMarker':
    case 'blockquoteMarker':
    case 'link':
    case 'tableBorder':
      return false;
    default:
      return assertNever(segment.kind);
  }
}

function matchWorkflowMarkerAt(
  text: string,
  index: number,
  statusMarkers: readonly string[],
): WorkflowMarkerMatch | undefined {
  const task = matchPatternAt(text, index, TASK_ID_PATTERN);
  if (task && hasWordBoundary(text, index, task.length) && TaskIdSchema.safeParse(task).success) {
    return { kind: 'taskId', text: task };
  }

  const path = matchPatternAt(text, index, FILE_PATH_PATTERN);
  if (path && hasWordBoundary(text, index, path.length)) {
    return { kind: 'filePath', text: path };
  }

  const status = matchKeywordAt(text, index, statusMarkers);
  if (status) return { kind: 'status', text: status };

  const risk = matchKeywordAt(text, index, RISK_MARKERS);
  if (risk) return { kind: 'risk', text: risk };

  return undefined;
}

function matchKeywordAt(
  text: string,
  index: number,
  markers: readonly string[],
): string | undefined {
  const rest = text.slice(index);
  for (const marker of markers) {
    if (rest.startsWith(marker) && hasWordBoundary(text, index, marker.length)) {
      return marker;
    }
  }
  return undefined;
}

function matchPatternAt(text: string, index: number, pattern: RegExp): string | undefined {
  const match = pattern.exec(text.slice(index));
  const value = match?.[0];
  return value && value.length > 0 ? value : undefined;
}

function hasWordBoundary(text: string, index: number, length: number): boolean {
  return !isWordChar(text[index - 1]) && !isWordChar(text[index + length]);
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_-]/.test(char);
}

function workflowMarkdownPartToConversationSegment(
  part: WorkflowMarkdownPart,
  projectDir: string | undefined,
): ConversationRowSegment {
  switch (part.kind) {
    case 'base':
      return markdownSegment(part.segment, projectDir);
    case 'taskId':
      return { text: part.text, tone: 'text', bold: true };
    case 'filePath':
      return filePathConversationSegment(part, projectDir);
    case 'status':
      return { text: part.text, tone: 'textDim' };
    case 'risk':
      return { text: part.text, tone: 'textDim' };
    default:
      return assertNever(part);
  }
}

function workflowMarkdownPartToRenderSegment(
  part: WorkflowMarkdownPart,
  theme: Theme,
  projectDir: string | undefined,
): MarkdownRenderSegment {
  switch (part.kind) {
    case 'base':
      return { text: part.segment.text };
    case 'taskId':
      return { text: part.text };
    case 'filePath':
      return filePathRenderSegment(part, theme, projectDir);
    case 'status':
      return { text: part.text, style: { color: statusColor(part.text, theme), bold: false } };
    case 'risk':
      return { text: part.text };
    default:
      return assertNever(part);
  }
}

function filePathConversationSegment(
  part: { text: string; suppressHref?: boolean },
  projectDir: string | undefined,
): ConversationRowSegment {
  if (projectDir === undefined || part.suppressHref === true) {
    return { text: part.text, tone: 'textDim' };
  }
  return {
    text: projectRelativePathLabel({ path: part.text, rootDir: projectDir }),
    tone: 'markdownLink',
    href: filePathUrl({ path: part.text, rootDir: projectDir }),
  };
}

function filePathRenderSegment(
  part: { text: string; suppressHref?: boolean },
  theme: Theme,
  projectDir: string | undefined,
): MarkdownRenderSegment {
  if (projectDir === undefined || part.suppressHref === true) {
    return { text: part.text, style: { color: theme.textDim } };
  }
  return {
    text: projectRelativePathLabel({ path: part.text, rootDir: projectDir }),
    style: { color: theme.markdown.link, underline: true },
    href: filePathUrl({ path: part.text, rootDir: projectDir }),
  };
}

function markdownSegment(
  segment: MarkdownLayoutSegment,
  projectDir: string | undefined,
): ConversationRowSegment {
  switch (segment.kind) {
    case 'heading':
      return { text: segment.text, tone: 'markdownHeading', bold: (segment.depth ?? 1) <= 3 };
    case 'metadata':
      return { text: segment.text, tone: 'textDim' };
    case 'rule':
      return { text: segment.text, tone: 'textDim' };
    case 'listMarker':
      return { text: segment.text, tone: 'text' };
    case 'blockquoteMarker':
      return { text: segment.text, tone: 'textDim' };
    case 'code':
      return segment.scope !== undefined
        ? { text: segment.text, tone: syntaxScopeTone(segment.scope) }
        : { text: segment.text, tone: 'textDim' };
    case 'bold':
      return { text: segment.text, tone: 'text', bold: true };
    case 'italic':
      return { text: segment.text, tone: 'textDim', italic: true };
    case 'boldItalic':
      return { text: segment.text, tone: 'text', bold: true, italic: true };
    case 'strikethrough':
      return { text: segment.text, tone: 'markdownStrike', strikethrough: true };
    case 'link': {
      const resolved = resolveMarkdownLinkTarget({
        label: segment.text,
        href: segment.href,
        rootDir: projectDir,
      });
      return {
        text: resolved.label,
        tone: 'markdownLink',
        ...(resolved.href === undefined ? {} : { href: resolved.href }),
      };
    }
    case 'tableBorder':
      return { text: segment.text, tone: 'markdownTableBorder' };
    case 'tableHeader':
      return { text: segment.text, tone: 'markdownHeading', bold: true };
    case 'text':
      return { text: segment.text, tone: 'text' };
    default:
      return assertNever(segment.kind);
  }
}

function syntaxScopeTone(scope: MarkdownHighlightScope): ConversationRowTone {
  switch (scope) {
    case 'keyword':
      return 'syntaxKeyword';
    case 'string':
      return 'syntaxString';
    case 'comment':
      return 'syntaxComment';
    case 'number':
      return 'syntaxNumber';
    case 'literal':
      return 'syntaxLiteral';
    case 'type':
      return 'syntaxType';
    case 'function':
      return 'syntaxFunction';
    case 'punctuation':
      return 'syntaxPunctuation';
    default:
      return assertNever(scope);
  }
}

function statusColor(text: string, theme: Theme): string {
  const value = text.toUpperCase();
  if (
    value.includes('FAIL') ||
    value.includes('ERROR') ||
    value.includes('BLOCKED') ||
    value.includes('NOT VERIFIED')
  ) {
    return theme.dimError;
  }
  if (value.includes('WARN') || value.includes('INCONCLUSIVE')) return theme.textDim;
  return theme.dimSuccess;
}
