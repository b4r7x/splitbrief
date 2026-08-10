import type { MarkdownLayoutRow } from '../../../../utils/markdown/types.js';
import type { ConversationRow } from '../types.js';

export interface MarkdownConversationRowsInput {
  keyPrefix: string;
  text: string;
  width: number;
}

export interface MarkdownConversationRowsIdentityInput {
  keyPrefix: string;
  width: number;
}

export interface MarkdownConversationRowsProjection {
  rowCount: number;
  createRows: (windowStart: number, windowEnd: number) => ConversationRow[];
}

export interface MarkdownRowsProjectionEntry {
  sourceText: string;
  chunks: readonly MarkdownLayoutChunk[];
  projection: MarkdownConversationRowsProjection;
}

export interface MarkdownRowsCacheEntry extends MarkdownRowsProjectionEntry {
  rawText: string;
}

export interface ActiveMarkdownRowsProjectionKeys {
  ordered: readonly string[];
  set: ReadonlySet<string>;
  ranks: ReadonlyMap<string, number>;
}

export interface MarkdownSourceLine {
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface MarkdownSourceChunk {
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface MarkdownLayoutChunk {
  startOffset: number;
  endOffset: number;
  rows: readonly MarkdownLayoutRow[];
  height: number;
}

export interface MetadataCandidate {
  keys: ReadonlySet<string>;
  nextIndex: number;
  includeClosingLine: boolean;
  validYaml: boolean;
}
