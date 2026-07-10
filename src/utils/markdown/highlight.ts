import { common, createLowlight } from 'lowlight';
import type { MarkdownHighlightScope } from './types.js';

export interface MarkdownHighlightSpan {
  text: string;
  scope?: MarkdownHighlightScope;
}

const MAX_HIGHLIGHT_LINES = 2000;
const MAX_HIGHLIGHT_CHARS = 200_000;
const HLJS_CLASS_PREFIX = 'hljs-';

const lowlight = createLowlight(common);

type HighlightTree = ReturnType<typeof lowlight.highlight>;
type HighlightNode = HighlightTree['children'][number];
type HighlightElement = Extract<HighlightNode, { type: 'element' }>;
type HighlightChild = HighlightNode | HighlightElement['children'][number];

const SCOPE_BY_HLJS_NAME: Readonly<Record<string, MarkdownHighlightScope>> = {
  keyword: 'keyword',
  built_in: 'keyword',
  string: 'string',
  regexp: 'string',
  comment: 'comment',
  number: 'number',
  literal: 'literal',
  type: 'type',
  class: 'type',
  'title.class': 'type',
  function: 'function',
  'title.function': 'function',
  punctuation: 'punctuation',
  operator: 'punctuation',
};

export function highlightMarkdownCode(input: {
  lines: readonly string[];
  language?: string | undefined;
}): readonly (readonly MarkdownHighlightSpan[])[] | null {
  const { lines, language } = input;
  if (language === undefined || !lowlight.registered(language)) return null;
  if (lines.length > MAX_HIGHLIGHT_LINES) return null;
  const source = lines.join('\n');
  if (source.length > MAX_HIGHLIGHT_CHARS) return null;
  if (lines.length === 0) return [];

  const spanLines: MarkdownHighlightSpan[][] = [];
  let current: MarkdownHighlightSpan[] = [];

  const visit = (
    nodes: readonly HighlightChild[],
    scope: MarkdownHighlightScope | undefined,
  ): void => {
    for (const node of nodes) {
      if (node.type === 'text') {
        node.value.split('\n').forEach((part, index) => {
          if (index > 0) {
            spanLines.push(current);
            current = [];
          }
          if (part.length > 0) {
            current.push(scope === undefined ? { text: part } : { text: part, scope });
          }
        });
      } else if (node.type === 'element') {
        visit(node.children, elementScope(node) ?? scope);
      }
    }
  };

  visit(lowlight.highlight(language, source).children, undefined);
  spanLines.push(current);
  return spanLines;
}

// lowlight encodes an hljs scope like `title.function` as ['hljs-title', 'function_']:
// the first className carries the `hljs-` prefix, sub-scope classNames carry a `_` suffix.
function elementScope(element: HighlightElement): MarkdownHighlightScope | undefined {
  const className = element.properties.className;
  if (!Array.isArray(className)) return undefined;
  return SCOPE_BY_HLJS_NAME[className.map(hljsScopeNamePart).join('.')];
}

function hljsScopeNamePart(part: string | number, index: number): string {
  const text = String(part);
  if (index === 0) {
    return text.startsWith(HLJS_CLASS_PREFIX) ? text.slice(HLJS_CLASS_PREFIX.length) : text;
  }
  return text.endsWith('_') ? text.slice(0, -1) : text;
}
