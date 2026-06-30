import type {
  MarkdownRenderSegment,
  MarkdownSegmentDecorator,
} from '../../../../components/markdown.js';
import type { Theme } from '../../../../components/theme.js';
import { TaskIdSchema } from '../../../../core/schemas/task.js';
import { stripTerminalControls } from '../../../../utils/display-text.js';
import type { MarkdownLayoutSegment } from '../../../../utils/markdown/types.js';
import { assertNever } from '../../../../utils/type-guards.js';
import type { ConversationRowSegment } from '../types.js';

type WorkflowMarkdownMarkerKind = 'taskId' | 'filePath' | 'status' | 'risk';

type WorkflowMarkdownPart =
  | { kind: 'base'; segment: MarkdownLayoutSegment }
  | { kind: WorkflowMarkdownMarkerKind; text: string };

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
export const STATUS_DIM_ERROR = '#a85561';
const STATUS_DIM_SUCCESS = '#6e8f4a';
const TASK_ID_PATTERN = /^T\d{3}/;
const FILE_PATH_PATTERN =
  /^(?:\.{1,2}\/|\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.[A-Za-z0-9]+(?::\d+)?/;

export function workflowMarkdownConversationSegments(
  segment: MarkdownLayoutSegment,
): ConversationRowSegment[] {
  return workflowMarkdownParts(segment).map(workflowMarkdownPartToConversationSegment);
}

export const workflowMarkdownRenderSegments: MarkdownSegmentDecorator = ({
  segment,
  theme,
}: {
  segment: MarkdownLayoutSegment;
  theme: Theme;
}) =>
  workflowMarkdownParts(segment, PROSE_STATUS_MARKERS).map((part) =>
    workflowMarkdownPartToRenderSegment(part, theme),
  );

function workflowMarkdownParts(
  segment: MarkdownLayoutSegment,
  statusMarkers: readonly string[] = STATUS_MARKERS,
): WorkflowMarkdownPart[] {
  const cleanSegment = cloneSegmentWithText(segment, stripTerminalControls(segment.text));
  if (!isWorkflowScannableSegment(cleanSegment)) return [{ kind: 'base', segment: cleanSegment }];

  const parts: WorkflowMarkdownPart[] = [];
  let buffer = '';
  let index = 0;

  while (index < cleanSegment.text.length) {
    const marker = matchWorkflowMarkerAt(cleanSegment.text, index, statusMarkers);
    if (!marker) {
      buffer += cleanSegment.text[index] ?? '';
      index += 1;
      continue;
    }

    if (buffer.length > 0) {
      parts.push({ kind: 'base', segment: cloneSegmentWithText(cleanSegment, buffer) });
      buffer = '';
    }

    parts.push(marker);
    index += marker.text.length;
  }

  if (buffer.length > 0) {
    parts.push({ kind: 'base', segment: cloneSegmentWithText(cleanSegment, buffer) });
  }

  return parts;
}

function cloneSegmentWithText(segment: MarkdownLayoutSegment, text: string): MarkdownLayoutSegment {
  return { kind: segment.kind, text };
}

function isWorkflowScannableSegment(segment: MarkdownLayoutSegment): boolean {
  switch (segment.kind) {
    case 'text':
    case 'heading':
    case 'metadata':
    case 'bold':
    case 'italic':
    case 'boldItalic':
      return true;
    case 'code':
    case 'rule':
    case 'listMarker':
    case 'blockquoteMarker':
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
): ConversationRowSegment {
  switch (part.kind) {
    case 'base':
      return markdownSegment(part.segment);
    case 'taskId':
      return { text: part.text, tone: 'text', bold: true };
    case 'filePath':
      return { text: part.text, tone: 'textDim' };
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
): MarkdownRenderSegment {
  switch (part.kind) {
    case 'base':
      return { text: part.segment.text };
    case 'taskId':
      return { text: part.text };
    case 'filePath':
      return { text: part.text, style: { color: theme.textDim } };
    case 'status':
      return { text: part.text, style: { color: statusColor(part.text, theme), bold: false } };
    case 'risk':
      return { text: part.text };
    default:
      return assertNever(part);
  }
}

function markdownSegment(segment: MarkdownLayoutSegment): ConversationRowSegment {
  switch (segment.kind) {
    case 'heading':
      return { text: segment.text, tone: 'text', bold: true };
    case 'metadata':
      return { text: segment.text, tone: 'textDim' };
    case 'rule':
      return { text: segment.text, tone: 'textDim' };
    case 'listMarker':
      return { text: segment.text, tone: 'text' };
    case 'blockquoteMarker':
      return { text: segment.text, tone: 'textDim' };
    case 'code':
      return { text: segment.text, tone: 'textDim' };
    case 'bold':
      return { text: segment.text, tone: 'text', bold: true };
    case 'italic':
      return { text: segment.text, tone: 'textDim', italic: true };
    case 'boldItalic':
      return { text: segment.text, tone: 'text', bold: true, italic: true };
    case 'text':
      return { text: segment.text, tone: 'text' };
    default:
      return assertNever(segment.kind);
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
    return STATUS_DIM_ERROR;
  }
  if (value.includes('WARN') || value.includes('INCONCLUSIVE')) return theme.textDim;
  return STATUS_DIM_SUCCESS;
}
