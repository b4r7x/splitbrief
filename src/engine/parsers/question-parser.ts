import type { ClarificationQuestion } from '../../core/types/events.js';

export type { ClarificationQuestion };

const MARKER_PREFIX = '<!-- Q:';
const MARKER_SUFFIX = ' -->';

function findBalancedBrace(text: string, start: number): number {
  if (text[start] !== '{') return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

export function extractQuestionsFromStream(text: string): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const start = text.indexOf(MARKER_PREFIX, searchFrom);
    if (start === -1) break;

    const jsonStart = start + MARKER_PREFIX.length;
    if (jsonStart >= text.length || text[jsonStart] !== '{') {
      searchFrom = jsonStart;
      continue;
    }

    const jsonEnd = findBalancedBrace(text, jsonStart);
    if (jsonEnd === -1) break;

    const afterJson = jsonEnd + 1;
    if (text.substring(afterJson, afterJson + MARKER_SUFFIX.length) !== MARKER_SUFFIX) {
      searchFrom = jsonStart + 1;
      continue;
    }

    try {
      const parsed = JSON.parse(text.substring(jsonStart, afterJson));
      if (
        typeof parsed.id === 'string' &&
        typeof parsed.type === 'string' &&
        typeof parsed.text === 'string'
      ) {
        questions.push(parsed as ClarificationQuestion);
      }
    } catch {}

    searchFrom = afterJson + MARKER_SUFFIX.length;
  }

  return questions;
}

export function createQuestionAccumulator() {
  let buffer = '';
  const seenIds = new Set<string>();
  const allQuestions: ClarificationQuestion[] = [];

  return {
    addChunk(chunk: string): ClarificationQuestion[] {
      buffer += chunk;
      const extracted = extractQuestionsFromStream(buffer);
      const newOnes = extracted.filter(q => !seenIds.has(q.id));
      for (const q of newOnes) {
        seenIds.add(q.id);
        allQuestions.push(q);
      }

      const lastSuffix = buffer.lastIndexOf(MARKER_SUFFIX);
      if (lastSuffix !== -1) {
        buffer = buffer.substring(lastSuffix + MARKER_SUFFIX.length);
      }

      return newOnes;
    },
    getAll(): ClarificationQuestion[] {
      return [...allQuestions];
    },
    reset() {
      buffer = '';
      seenIds.clear();
      allQuestions.length = 0;
    },
  };
}
