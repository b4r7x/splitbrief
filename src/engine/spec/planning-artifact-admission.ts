import { error } from '../../utils/error.js';
import { parseFrontmatter, parseTaskBriefMetadata } from '../../utils/markdown/frontmatter.js';
import {
  isMarkdownFenceCloseLine,
  isMarkdownHeadingLine,
  isMarkdownHtmlCommentStartLine,
  isMarkdownSetextHeadingLine,
  parseMarkdownFenceStart,
} from '../../utils/markdown/grammar.js';

export type PlanningArtifactPhase = 'specifying' | 'planning';

type MissingShape = 'non-empty Markdown' | 'Markdown heading';

type PlanningArtifactErrorData = {
  phase: PlanningArtifactPhase;
  filename: string;
  missingShape: MissingShape;
};

export const planningArtifactError = {
  invalid: (data: PlanningArtifactErrorData) =>
    error(
      'planning-invalid-artifact',
      `Invalid ${data.phase} artifact ${data.filename}: missing ${data.missingShape}`,
      data,
    ),
} as const;

export function admitPlanningArtifact(opts: {
  phase: PlanningArtifactPhase;
  filename: string;
  text: string;
}): string {
  if (opts.text.trim() === '') {
    throw planningArtifactError.invalid({
      phase: opts.phase,
      filename: opts.filename,
      missingShape: 'non-empty Markdown',
    });
  }
  if (!hasMarkdownHeading(opts.text)) {
    throw planningArtifactError.invalid({
      phase: opts.phase,
      filename: opts.filename,
      missingShape: 'Markdown heading',
    });
  }
  return opts.text;
}

function hasMarkdownHeading(markdown: string): boolean {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let fenceMarker: string | undefined;
  let htmlComment = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    if (fenceMarker !== undefined) {
      if (isMarkdownFenceCloseLine(line, fenceMarker)) fenceMarker = undefined;
      continue;
    }

    let visibleLine = line;
    if (htmlComment) {
      const closeIndex = visibleLine.indexOf('-->');
      if (closeIndex === -1) continue;
      htmlComment = false;
      visibleLine = visibleLine.slice(closeIndex + '-->'.length);
    }

    while (isMarkdownHtmlCommentStartLine(visibleLine)) {
      const closeIndex = visibleLine.indexOf('-->');
      if (closeIndex === -1) {
        htmlComment = true;
        visibleLine = '';
        break;
      }
      visibleLine = visibleLine.slice(closeIndex + '-->'.length);
    }

    if (htmlComment) continue;

    const fence = parseMarkdownFenceStart(visibleLine);
    if (fence !== undefined) {
      fenceMarker = fence.marker;
      continue;
    }

    const metadata = parseTaskBriefMetadata({ lines, index });
    if (metadata !== undefined) {
      index = metadata.nextIndex - 1;
      continue;
    }

    if (index === 0) {
      const frontmatter = parseFrontmatter({ lines, index });
      if (frontmatter !== undefined) {
        index = frontmatter.nextIndex - 1;
        continue;
      }
    }

    if (isMarkdownHeadingLine(visibleLine)) return true;
    if (isMarkdownSetextHeadingLine(visibleLine, lines[index + 1])) return true;
  }

  return false;
}
