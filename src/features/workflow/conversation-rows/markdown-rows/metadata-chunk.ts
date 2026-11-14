import {
  parseMarkdownYamlKey as parseYamlKey,
  isMarkdownYamlContinuationLine as isYamlContinuationLine,
  hasTaskBriefMetadataKeys,
} from '../../../../utils/markdown/grammar.js';
import type { MarkdownSourceLine, MetadataCandidate } from './types.js';

export function metadataCandidateAt(
  lines: readonly MarkdownSourceLine[],
  index: number,
): MetadataCandidate | undefined {
  return delimitedMetadataCandidateAt(lines, index) ?? bareMetadataCandidateAt(lines, index);
}

export function delimitedMetadataCandidateAt(
  lines: readonly MarkdownSourceLine[],
  index: number,
): MetadataCandidate | undefined {
  if (lines[index]?.text.trim() !== '---') return undefined;

  const metadataLines: string[] = [];
  let cursor = index + 1;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line === undefined) break;
    if (line.text.trim() === '---') {
      return delimitedMetadataCandidate(metadataLines, cursor);
    }
    metadataLines.push(line.text);
    cursor += 1;
  }

  return undefined;
}

function bareMetadataCandidateAt(
  lines: readonly MarkdownSourceLine[],
  index: number,
): MetadataCandidate | undefined {
  const metadataLines: string[] = [];
  let cursor = index;
  let hasTopLevelKey = false;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line === undefined || line.text.trim().length === 0 || line.text.trim() === '---') break;

    const key = parseYamlKey(line.text);
    if (key !== undefined) {
      hasTopLevelKey = true;
      metadataLines.push(line.text);
      cursor += 1;
      continue;
    }

    if (hasTopLevelKey && isYamlContinuationLine(line.text)) {
      metadataLines.push(line.text);
      cursor += 1;
      continue;
    }

    break;
  }

  const closingLine = lines[cursor];
  return metadataCandidate(metadataLines, cursor, closingLine?.text.trim() === '---');
}

function metadataCandidate(
  lines: readonly string[],
  nextIndex: number,
  includeClosingLine: boolean,
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
  return { keys, nextIndex, includeClosingLine, validYaml: true };
}

function delimitedMetadataCandidate(
  lines: readonly string[],
  nextIndex: number,
): MetadataCandidate | undefined {
  const yaml = metadataCandidate(lines, nextIndex, true);
  if (yaml) return yaml;

  const keys = new Set<string>();
  for (const line of lines) {
    const key = parseYamlKey(line);
    if (key !== undefined) keys.add(key);
  }

  return {
    keys,
    nextIndex,
    includeClosingLine: true,
    validYaml: false,
  };
}

export function canUseMetadataChunk(
  line: MarkdownSourceLine,
  metadata: MetadataCandidate,
): boolean {
  return line.startOffset === 0 || (metadata.validYaml && hasTaskBriefMetadataKeys(metadata.keys));
}
