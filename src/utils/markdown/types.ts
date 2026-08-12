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
  // 'document' is the delimited header a generator stamps on top of a file — generated_by,
  // created_at and the like. It says nothing a reader wants and never renders. 'task' is Task
  // Brief metadata, and undelimited YAML in a planner stream, both of which are content.
  role: 'document' | 'task';
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

export interface MarkdownListItemContinuation {
  text: string;
  inlines: readonly MarkdownInlineToken[];
}

export type MarkdownListItem =
  | {
      kind: 'unordered';
      indent: number;
      marker: '-' | '*' | '+';
      text: string;
      inlines: readonly MarkdownInlineToken[];
      continuation?: MarkdownListItemContinuation;
    }
  | {
      kind: 'ordered';
      indent: number;
      marker: string;
      start: number;
      text: string;
      inlines: readonly MarkdownInlineToken[];
      continuation?: MarkdownListItemContinuation;
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
  | 'codeLanguage' // the fence info string, set apart from the body it labels
  | 'codeText' // fence body the highlighter left unscoped; 'code' is an inline span
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

// The characters the layout draws with. src/utils is the leaf of the import graph and cannot
// reach the glyph table in src/lib, so the resolved tier arrives from the caller instead — which
// also lets either tier be laid out in a test without touching global state.
export interface MarkdownLayoutGlyphs {
  codeRail: string;
  wrapContinuation: string;
  divider: string;
  listBullet: string;
  listBulletNested: string;
  tableColumn: string;
}

// What a preceding stretch of layout left behind, so a later block can decide its own
// leading air. The chunked transcript path carries this across chunk boundaries to reach
// the same rhythm as the review path, which lays the document out in one call.
export interface MarkdownLayoutTail {
  kind: MarkdownBlock['kind'];
  endsWithBlankLine: boolean;
}
