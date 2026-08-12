import type {
  MarkdownHeadingDepth,
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
import { workflowMarkdownParts, type WorkflowMarkdownPart } from './workflow-markers.js';

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

export function workflowMarkdownConversationSegments(
  segment: MarkdownLayoutSegment,
  options: { projectDir: string | undefined; previousLineText?: string | undefined },
): ConversationRowSegment[] {
  return workflowMarkdownParts(segment, {
    statusMarkers: STATUS_MARKERS,
    previousLineText: options.previousLineText,
  }).map((part) => workflowMarkdownPartToConversationSegment(part, options.projectDir));
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

// Mirrors headingStyle in src/components/markdown.tsx: the review overlay and the transcript
// have to place a rank the same way, or the same document reads as two different outlines.
function headingSegment(text: string, depth: MarkdownHeadingDepth): ConversationRowSegment {
  switch (depth) {
    case 1:
    case 2:
      return { text, tone: 'markdownHeading', bold: true };
    case 3:
      return { text, tone: 'markdownHeading' };
    case 4:
      return { text, tone: 'text', bold: true };
    case 5:
      return { text, tone: 'textDim', bold: true };
    case 6:
      return { text, tone: 'textDim', italic: true };
    default:
      return assertNever(depth);
  }
}

function markdownSegment(
  segment: MarkdownLayoutSegment,
  projectDir: string | undefined,
): ConversationRowSegment {
  switch (segment.kind) {
    case 'heading':
      return headingSegment(segment.text, segment.depth ?? 1);
    case 'metadata':
      return { text: segment.text, tone: 'textDim' };
    case 'codeLanguage':
      return { text: segment.text, tone: 'markdownCodeGutter' };
    case 'rule':
      return { text: segment.text, tone: 'markdownRule' };
    case 'listMarker':
      return { text: segment.text, tone: 'markdownList' };
    case 'blockquoteMarker':
      return { text: segment.text, tone: 'markdownBlockquote' };
    case 'codeGutter':
      return { text: segment.text, tone: 'markdownCodeGutter' };
    case 'codeText':
      return { text: segment.text, tone: 'text' };
    case 'code':
      return segment.scope !== undefined
        ? { text: segment.text, tone: syntaxScopeTone(segment.scope) }
        : { text: segment.text, tone: 'markdownCode' };
    case 'bold':
      return { text: segment.text, tone: 'text', bold: true };
    case 'italic':
      return { text: segment.text, tone: 'markdownItalic', italic: true };
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
