export type MarkdownHeadingDepth = 1 | 2 | 3 | 4 | 5 | 6;

export type MarkdownInlineToken =
  | { kind: 'text' | 'code' | 'bold' | 'italic' | 'boldItalic' | 'strikethrough'; text: string }
  | { kind: 'link'; text: string; href: string };

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
  | MarkdownTableBlock
  | MarkdownHtmlCommentBlock
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

export type MarkdownTableAlignment = 'left' | 'center' | 'right';

export interface MarkdownTableCell {
  text: string;
  inlines: readonly MarkdownInlineToken[];
}

export interface MarkdownTableBlock {
  kind: 'table';
  alignments: readonly MarkdownTableAlignment[];
  header: readonly MarkdownTableCell[];
  rows: ReadonlyArray<readonly MarkdownTableCell[]>;
}

export interface MarkdownHtmlCommentBlock {
  kind: 'htmlComment';
  lines: readonly string[];
}

export interface MarkdownParagraphBlock {
  kind: 'paragraph';
  text: string;
  inlines: readonly MarkdownInlineToken[];
}

export type MarkdownHighlightScope =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'literal'
  | 'type'
  | 'function'
  | 'punctuation';

export type MarkdownLayoutSegmentKind =
  | MarkdownInlineToken['kind']
  | 'heading'
  | 'metadata'
  | 'rule'
  | 'listMarker'
  | 'blockquoteMarker'
  | 'codeGutter'
  | 'tableBorder'
  | 'tableHeader';

export interface MarkdownLayoutSegment {
  kind: MarkdownLayoutSegmentKind;
  text: string;
  href?: string; // 'link' segments only
  scope?: MarkdownHighlightScope; // 'code' segments only (highlighted fences)
  depth?: MarkdownHeadingDepth; // 'heading' segments only
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
