import {
  ImplementerReportSchema,
  type ImplementerReport,
} from '../../../../core/schemas/consult.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { extractLastJsonObject } from '../../../../engine/runners/typed-output.js';
import { countNoun } from '../../../../utils/pluralize.js';
import {
  hasTaskBriefMetadataKeys,
  parseMarkdownYamlKey,
} from '../../../../utils/markdown/grammar.js';
import { parseMarkdownBlocks } from '../../../../utils/markdown/block-parser.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { markdownPlannerTextRowBlock } from '../planner-markdown-row-block.js';
import type { ConversationRowBlock, ConversationRowTone } from '../types.js';
import { wrapWidthFor } from '../row-markers.js';
import { compositeBlock, wrappedTextBlock } from '../row-block-compose.js';

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
    case undefined: {
      if (event.role === 'implementer') {
        const handBack = splitImplementerHandBack(event.text);
        if (handBack !== undefined) {
          return implementerHandBackRowBlock(keyPrefix, handBack, width);
        }
      }
      return wrappedTextBlock({
        keyPrefix,
        text: event.text,
        width,
        tone: plannerTextTone(event.role),
      });
    }
    default:
      return assertNever(event.content);
  }
}

/**
 * The direct writer ends its reply with one `ImplementerReport` object. It is the last JSON object
 * in the streamed text; the narration before it stays, the object itself becomes one report row.
 */
function splitImplementerHandBack(
  text: string,
): { narration: string; report: ImplementerReport } | undefined {
  let start = text.lastIndexOf('{');
  while (start !== -1) {
    const extracted = extractLastJsonObject(text.slice(start));
    if (extracted.kind === 'ok') {
      const parsed = ImplementerReportSchema.safeParse(extracted.value);
      if (parsed.success) {
        return { narration: text.slice(0, start).trimEnd(), report: parsed.data };
      }
    }
    start = start === 0 ? -1 : text.lastIndexOf('{', start - 1);
  }
  return undefined;
}

function implementerHandBackRowBlock(
  keyPrefix: string,
  handBack: { narration: string; report: ImplementerReport },
  width: number,
): ConversationRowBlock | null {
  const narration =
    handBack.narration === ''
      ? null
      : wrappedTextBlock({
          keyPrefix: `${keyPrefix}-narration-0`,
          text: handBack.narration,
          width,
          tone: 'textDim',
        });
  return compositeBlock(keyPrefix, [
    narration,
    wrappedTextBlock({
      keyPrefix: `${keyPrefix}-report-1`,
      text: reportSummaryLine(handBack.report),
      width,
      tone: 'textDim',
    }),
  ]);
}

function reportSummaryLine(report: ImplementerReport): string {
  const head = `Report  ${report.status}`;
  if (report.status === 'blocked') {
    return `${head}${SOFT_SEP}${countNoun(report.filesNeeded.length, 'file')} needed`;
  }
  return [
    head,
    countNoun(report.filesChanged.length, 'file'),
    countNoun(report.decisions.length, 'decision'),
  ].join(SOFT_SEP);
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
