import {
  hasTaskBriefMetadataKeys,
  isMarkdownYamlContinuationLine as isYamlContinuationLine,
  isMarkdownYamlLikeLine as isYamlLikeLine,
  parseMarkdownYamlKey as parseYamlKey,
} from './grammar.js';
import type { MarkdownBlock } from './types.js';

export interface MetadataCandidate {
  lines: string[];
  keys: ReadonlySet<string>;
  nextIndex: number;
}

export type FrontmatterParseResult = {
  block: Extract<MarkdownBlock, { kind: 'frontmatter' }>;
  nextIndex: number;
};

export interface FrontmatterLineState {
  lines: readonly string[];
  index: number;
}

export function parseFrontmatter(state: FrontmatterLineState): FrontmatterParseResult | undefined {
  const firstLine = state.lines[state.index];
  if (firstLine === undefined) return undefined;

  if (firstLine.trim() === '---') {
    const lines: string[] = [];
    let cursor = state.index + 1;
    while (cursor < state.lines.length) {
      const line = state.lines[cursor];
      if (line === undefined) break;
      if (line.trim() === '---') {
        return {
          block: { kind: 'frontmatter', role: 'document', lines },
          nextIndex: cursor + 1,
        };
      }
      lines.push(line);
      cursor += 1;
    }
    return undefined;
  }

  const yamlLines: string[] = [];
  let cursor = state.index;
  while (cursor < state.lines.length) {
    const line = state.lines[cursor];
    if (line === undefined || line.trim().length === 0) break;
    if (!isYamlLikeLine(line)) break;
    yamlLines.push(line);
    cursor += 1;
  }

  if (yamlLines.length >= 2) {
    // Undelimited YAML at the top of a planner stream is partial task metadata, not a stamped
    // document header, so it keeps rendering; only the delimited header block is hidden.
    return {
      block: { kind: 'frontmatter', role: 'task', lines: yamlLines },
      nextIndex: cursor,
    };
  }

  return undefined;
}

export function parseTaskBriefMetadata(
  state: FrontmatterLineState,
): FrontmatterParseResult | undefined {
  const delimited = collectDelimitedYamlMetadata(state);
  if (delimited && hasTaskBriefMetadataKeys(delimited.keys)) {
    return {
      block: { kind: 'frontmatter', role: 'task', lines: delimited.lines },
      nextIndex: delimited.nextIndex,
    };
  }

  const bare = collectBareYamlMetadata(state);
  if (!bare || !hasTaskBriefMetadataKeys(bare.keys)) return undefined;

  const closingLine = state.lines[bare.nextIndex];
  const nextIndex = closingLine?.trim() === '---' ? bare.nextIndex + 1 : bare.nextIndex;
  return {
    block: { kind: 'frontmatter', role: 'task', lines: bare.lines },
    nextIndex,
  };
}

function collectDelimitedYamlMetadata(state: FrontmatterLineState): MetadataCandidate | undefined {
  const firstLine = state.lines[state.index];
  if (firstLine?.trim() !== '---') return undefined;

  const lines: string[] = [];
  let cursor = state.index + 1;
  while (cursor < state.lines.length) {
    const line = state.lines[cursor];
    if (line === undefined) break;
    if (line.trim() === '---') {
      return createMetadataCandidate(lines, cursor + 1);
    }
    lines.push(line);
    cursor += 1;
  }

  return undefined;
}

function collectBareYamlMetadata(state: FrontmatterLineState): MetadataCandidate | undefined {
  const lines: string[] = [];
  let cursor = state.index;
  let hasTopLevelKey = false;

  while (cursor < state.lines.length) {
    const line = state.lines[cursor];
    if (line === undefined || line.trim().length === 0 || line.trim() === '---') break;

    const key = parseYamlKey(line);
    if (key !== undefined) {
      hasTopLevelKey = true;
      lines.push(line);
      cursor += 1;
      continue;
    }

    if (hasTopLevelKey && isYamlContinuationLine(line)) {
      lines.push(line);
      cursor += 1;
      continue;
    }

    break;
  }

  return createMetadataCandidate(lines, cursor);
}

function createMetadataCandidate(
  lines: readonly string[],
  nextIndex: number,
): MetadataCandidate | undefined {
  const keys = new Set<string>();
  let hasTopLevelKey = false;

  for (const line of lines) {
    const key = parseYamlKey(line);
    if (key !== undefined) {
      hasTopLevelKey = true;
      keys.add(key);
      continue;
    }

    if (hasTopLevelKey && isYamlContinuationLine(line)) continue;
    return undefined;
  }

  if (lines.length === 0) return undefined;
  return { lines: [...lines], keys, nextIndex };
}
