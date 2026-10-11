import type {
  MarkdownRenderSegment,
  MarkdownSegmentDecorator,
} from '../../../../components/markdown.js';
import type { Theme } from '../../../../core/theme/palette.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { filePathUrl, projectRelativePathLabel } from '../../../../utils/path-links.js';
import { workflowMarkdownParts, type WorkflowMarkdownPart } from './workflow-markers.js';
import { workflowStatusTone } from './conversation-segments.js';
import { colorForTone } from '../../../../core/theme/tone-color.js';

export const workflowMarkdownRenderSegments: MarkdownSegmentDecorator = ({
  segment,
  theme,
  projectDir,
  previousLineText,
}) =>
  workflowMarkdownParts(segment, {
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
      return {
        text: part.text,
        style: { color: colorForTone(workflowStatusTone(part.text), theme), bold: false },
      };
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
