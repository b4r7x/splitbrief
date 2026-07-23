import type {
  MarkdownRenderSegment,
  MarkdownSegmentDecorator,
} from '../../../../components/markdown.js';
import type { Theme } from '../../../../components/theme.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { filePathUrl, projectRelativePathLabel } from '../../../../utils/path-links.js';
import { workflowMarkdownParts, type WorkflowMarkdownPart } from './workflow-markers.js';

const PROSE_STATUS_MARKERS: readonly string[] = [
  'NOT VERIFIED',
  'INCONCLUSIVE',
  'VERIFIED',
  'BLOCKED',
  'FAILED',
];

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
