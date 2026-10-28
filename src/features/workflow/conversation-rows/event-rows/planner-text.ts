import { readImplementerReport, type ImplementerReport } from '../../../../core/schemas/consult.js';
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
  if (
    event.role === 'implementer' &&
    (event.content === 'markdown' || event.content === undefined)
  ) {
    const handBack = splitImplementerHandBack(event.text);
    const narrationKey = handBack === undefined ? keyPrefix : `${keyPrefix}-narration-0`;
    const narrationText = handBack === undefined ? event.text : handBack.narration;
    const narration =
      handBack?.narration === ''
        ? null
        : event.content === 'markdown'
          ? markdownPlannerTextRowBlock({
              keyPrefix: narrationKey,
              text: narrationText,
              width: markdownWidth,
              proseTone: 'textDim',
            })
          : wrappedTextBlock({
              keyPrefix: narrationKey,
              text: narrationText,
              width,
              tone: 'textDim',
            });
    if (handBack === undefined) return narration;
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

/** A code-fence line: three or more backticks and an optional info string. */
const FENCE_LINE = /^[ \t]*`{3,}[^`\n]*$/gm;
const TRAILING_FENCE_LINE = /(^|\n)[ \t]*`{3,}[^`\n]*$/;

/**
 * The direct writer ends its reply with one `ImplementerReport` object. It is the last JSON object
 * in the streamed text; the narration before it stays, the object itself becomes one report row,
 * and so does the code fence that opens on it.
 */
function splitImplementerHandBack(
  text: string,
): { narration: string; report: ImplementerReport } | undefined {
  let start = text.lastIndexOf('{');
  while (start !== -1) {
    const extracted = extractLastJsonObject(text.slice(start));
    if (extracted.kind === 'ok') {
      const read = readImplementerReport(extracted.value);
      if (read !== undefined) {
        const narration = text.slice(0, start).trimEnd();
        // An odd count of fence lines leaves the last one open: it opens on the report.
        const opensOnReport = (narration.match(FENCE_LINE)?.length ?? 0) % 2 === 1;
        return {
          narration: opensOnReport
            ? narration.replace(TRAILING_FENCE_LINE, '').trimEnd()
            : narration,
          report: read.report,
        };
      }
    }
    start = start === 0 ? -1 : text.lastIndexOf('{', start - 1);
  }
  return undefined;
}

function reportSummaryLine(report: ImplementerReport): string {
  const head = `Report  ${report.status}`;
  if (report.status === 'blocked') {
    return `${head}${SOFT_SEP}${countNoun(report.filesNeeded.length, 'file')} needed`;
  }
  // The files the call changed are listed by its done row, measured from the workspace; a count
  // of the files the report claims would be a second, possibly different, list.
  return `${head}${SOFT_SEP}${countNoun(report.decisions.length, 'decision')}`;
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
