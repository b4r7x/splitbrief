import { TaskIdSchema } from '../../../../core/schemas/task.js';
import { stripTerminalControls } from '../../../../utils/display-text.js';
import type { MarkdownLayoutSegment } from '../../../../utils/markdown/types.js';
import { assertNever } from '../../../../utils/type-guards.js';

export type WorkflowMarkdownMarkerKind = 'taskId' | 'filePath' | 'status' | 'risk';

export type WorkflowMarkdownPart =
  | { kind: 'base'; segment: MarkdownLayoutSegment }
  | { kind: WorkflowMarkdownMarkerKind; text: string; suppressHref?: boolean };

interface WorkflowMarkerMatch {
  kind: WorkflowMarkdownMarkerKind;
  text: string;
}

const TASK_ID_PATTERN = /^T\d{3}/;
const FILE_PATH_PATTERN =
  /^(?:\.{1,2}\/|\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.[A-Za-z0-9]+(?::\d+)?/;

const RISK_MARKERS: readonly string[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

export function workflowMarkdownParts(
  segment: MarkdownLayoutSegment,
  options: { statusMarkers: readonly string[]; previousLineText: string | undefined },
): WorkflowMarkdownPart[] {
  const cleanSegment = cloneSegmentWithText(segment, stripTerminalControls(segment.text));
  if (!isWorkflowScannableSegment(cleanSegment)) return [{ kind: 'base', segment: cleanSegment }];

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
    case 'codeGutter':
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
