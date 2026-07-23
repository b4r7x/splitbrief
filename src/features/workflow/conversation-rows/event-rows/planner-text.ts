import type { EngineEventOf } from '../../../../engine/events/types.js';
import {
  hasTaskBriefMetadataKeys,
  parseMarkdownYamlKey,
} from '../../../../utils/markdown/grammar.js';
import { parseMarkdownBlocks } from '../../../../utils/markdown/block-parser.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { markdownPlannerTextRowBlock } from '../planner-markdown-row-block.js';
import type { ConversationRowBlock, ConversationRowTone } from '../types.js';
import { wrapWidthFor } from '../row-markers.js';
import { wrappedTextBlock } from '../row-block-compose.js';

export function plannerTextRowBlock(options: {
  event: EngineEventOf<'planner_text'>;
  keyPrefix: string;
  width: number;
  dedupTitle: string | undefined;
}): ConversationRowBlock | null {
  const { event, keyPrefix, width, dedupTitle } = options;
  const markdownWidth = wrapWidthFor('message', width);
  if (isPlannerTextRenderedAsMarkdown(event)) {
    return markdownPlannerTextRowBlock({
      keyPrefix,
      text: event.text,
      width: markdownWidth,
      phase: event.phase,
      dedupTitle,
    });
  }

  switch (event.content) {
    case 'markdown':
      return markdownPlannerTextRowBlock({
        keyPrefix,
        text: event.text,
        width: markdownWidth,
        phase: event.phase,
        dedupTitle,
      });
    case 'plain':
    case undefined:
      return wrappedTextBlock({
        keyPrefix,
        text: event.text,
        width,
        tone: plannerTextTone(event.role),
      });
    default:
      return assertNever(event.content);
  }
}

export function isPlannerTextRenderedAsMarkdown(event: EngineEventOf<'planner_text'>): boolean {
  return event.content === 'markdown' || isLiveTaskBriefMarkdown(event);
}

function isLiveTaskBriefMarkdown(event: EngineEventOf<'planner_text'>): boolean {
  if (event.phase !== 'researching') return false;
  if (event.role !== undefined && event.role !== 'planner') return false;
  return looksLikeTaskBriefMarkdown(event.text);
}

function looksLikeTaskBriefMarkdown(text: string): boolean {
  const document = parseMarkdownBlocks(text);
  let hasTaskBriefMetadata = false;
  let hasHeading = false;

  for (const block of document.blocks) {
    if (block.kind === 'frontmatter') {
      hasTaskBriefMetadata =
        hasTaskBriefMetadata || hasTaskBriefMetadataKeys(taskBriefMetadataKeys(block.lines));
    }
    if (block.kind === 'heading') hasHeading = true;
    if (hasTaskBriefMetadata && hasHeading) return true;
  }

  return false;
}

function taskBriefMetadataKeys(lines: readonly string[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const line of lines) {
    const key = parseMarkdownYamlKey(line);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

function plannerTextTone(role: EngineEventOf<'planner_text'>['role']): ConversationRowTone {
  return role === undefined ? 'text' : 'textDim';
}
