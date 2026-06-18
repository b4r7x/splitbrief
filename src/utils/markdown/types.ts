export type MarkdownHeadingDepth = 1 | 2 | 3;

export type MarkdownInlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'boldItalic'; text: string };

export interface MarkdownDocument {
  blocks: readonly MarkdownBlock[];
}

export type MarkdownBlock =
  | MarkdownFrontmatterBlock
  | MarkdownHeadingBlock
  | MarkdownThematicBreakBlock
  | MarkdownCodeBlock
  | MarkdownListBlock
  | MarkdownBlockquoteBlock
  | MarkdownParagraphBlock;

export interface MarkdownFrontmatterBlock {
  kind: 'frontmatter';
  lines: readonly string[];
}

export interface MarkdownHeadingBlock {
  kind: 'heading';
  depth: MarkdownHeadingDepth;
  text: string;
  inlines: readonly MarkdownInlineToken[];
}

export interface MarkdownThematicBreakBlock {
  kind: 'thematicBreak';
}

export interface MarkdownCodeBlock {
  kind: 'code';
  language?: string;
  lines: readonly string[];
}

export interface MarkdownListBlock {
  kind: 'list';
  items: readonly MarkdownListItem[];
}

export type MarkdownListItem =
  | {
      kind: 'unordered';
      indent: number;
      marker: '-' | '*' | '+';
      text: string;
      inlines: readonly MarkdownInlineToken[];
    }
  | {
      kind: 'ordered';
      indent: number;
      marker: string;
      start: number;
      text: string;
      inlines: readonly MarkdownInlineToken[];
    };

export interface MarkdownBlockquoteBlock {
  kind: 'blockquote';
  blocks: readonly MarkdownBlock[];
}

export interface MarkdownParagraphBlock {
  kind: 'paragraph';
  text: string;
  inlines: readonly MarkdownInlineToken[];
}

export type MarkdownLayoutSegmentKind =
  | MarkdownInlineToken['kind']
  | 'heading'
  | 'metadata'
  | 'rule'
  | 'listMarker'
  | 'blockquoteMarker';

export interface MarkdownLayoutSegment {
  kind: MarkdownLayoutSegmentKind;
  text: string;
}

export interface MarkdownLayoutLine {
  segments: readonly MarkdownLayoutSegment[];
}

export interface MarkdownLayoutRow {
  key: string;
  blockKind: MarkdownBlock['kind'];
  lines: readonly MarkdownLayoutLine[];
  height: number;
}

export interface MarkdownLayout {
  width: number;
  rows: readonly MarkdownLayoutRow[];
  height: number;
}
