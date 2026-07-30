import { readFileSync } from 'node:fs';
import { createProcessor } from '@mdx-js/mdx';
import type { Root } from 'mdast';
import { parseDocument } from 'yaml';
import type { SourceDiagnostic } from './source-diagnostic.js';

type ParsedDocument = {
  readonly body: string;
  readonly bodyStartLine: number;
  readonly file: string;
  readonly frontmatter: unknown;
  readonly source: string;
  readonly tree: Root;
};

type DocumentResult =
  | { readonly kind: 'invalid'; readonly issues: readonly SourceDiagnostic[] }
  | { readonly kind: 'valid'; readonly document: ParsedDocument };

const MDX_PROCESSOR = createProcessor({ format: 'mdx' });
const MARKDOWN_PROCESSOR = createProcessor({ format: 'md' });
const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseTree(options: {
  readonly body: string;
  readonly file: string;
  readonly format: 'md' | 'mdx';
}): Root | SourceDiagnostic {
  try {
    const processor = options.format === 'mdx' ? MDX_PROCESSOR : MARKDOWN_PROCESSOR;
    return processor.parse({ path: options.file, value: options.body });
  } catch (error) {
    return {
      file: options.file,
      message: `cannot parse ${options.format === 'mdx' ? 'MDX' : 'Markdown'}: ${errorMessage(error)}`,
    };
  }
}

export function readMdxDocument(options: { readonly file: string }): DocumentResult {
  let source: string;
  try {
    source = readFileSync(options.file, 'utf8')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n');
  } catch (error) {
    return {
      kind: 'invalid',
      issues: [{ file: options.file, message: `cannot read file: ${errorMessage(error)}` }],
    };
  }

  const match = FRONTMATTER.exec(source);
  if (!match) {
    return {
      kind: 'invalid',
      issues: [{ file: options.file, message: 'missing or malformed YAML frontmatter' }],
    };
  }

  const yaml = parseDocument(match[1] ?? '', { prettyErrors: false, uniqueKeys: true });
  if (yaml.errors.length > 0) {
    return {
      kind: 'invalid',
      issues: [
        {
          file: options.file,
          message: `invalid YAML frontmatter: ${yaml.errors.map((error) => error.message).join('; ')}`,
        },
      ],
    };
  }

  let frontmatter: unknown;
  try {
    frontmatter = yaml.toJS();
  } catch (error) {
    return {
      kind: 'invalid',
      issues: [{ file: options.file, message: `invalid YAML frontmatter: ${errorMessage(error)}` }],
    };
  }

  const body = source.slice(match[0].length);
  const tree = parseTree({ body, file: options.file, format: 'mdx' });
  if ('message' in tree) {
    return { kind: 'invalid', issues: [tree] };
  }

  return {
    kind: 'valid',
    document: {
      body,
      bodyStartLine: match[0].split('\n').length,
      file: options.file,
      frontmatter,
      source,
      tree,
    },
  };
}

export function readMarkdownTree(options: {
  readonly file: string;
}): { readonly source: string; readonly tree: Root } | SourceDiagnostic {
  let source: string;
  try {
    source = readFileSync(options.file, 'utf8').replace(/\r\n?/g, '\n');
  } catch (error) {
    return { file: options.file, message: `cannot read file: ${errorMessage(error)}` };
  }

  const tree = parseTree({ body: source, file: options.file, format: 'md' });
  return 'message' in tree ? tree : { source, tree };
}
