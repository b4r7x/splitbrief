import type { ClarificationQuestion } from '../../core/schemas/question.js';
import { ClarificationQuestionSchema } from '../../core/schemas/question.js';
import { warnError } from '../../lib/warn.js';

const MARKER_PREFIX = '<!-- Q:';
const MARKER_SUFFIX = ' -->';

function narrowQuestion(raw: unknown): ClarificationQuestion | null {
  const result = ClarificationQuestionSchema.safeParse(raw);
  return result.success ? result.data : null;
}

function findBalancedBrace(text: string, start: number): number {
  if (text[start] !== '{') return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface ScanResult {
  questions: ClarificationQuestion[];
  consumed: number;
}

function scanQuestions(text: string): ScanResult {
  const questions: ClarificationQuestion[] = [];
  let searchFrom = 0;
  let consumed = 0;

  while (searchFrom < text.length) {
    const start = text.indexOf(MARKER_PREFIX, searchFrom);
    if (start === -1) break;

    const jsonStart = start + MARKER_PREFIX.length;
    if (jsonStart >= text.length || text[jsonStart] !== '{') {
      searchFrom = jsonStart;
      continue;
    }

    const jsonEnd = findBalancedBrace(text, jsonStart);
    if (jsonEnd === -1) {
      searchFrom = jsonStart + 1;
      continue;
    }

    const afterJson = jsonEnd + 1;
    if (text.substring(afterJson, afterJson + MARKER_SUFFIX.length) !== MARKER_SUFFIX) {
      searchFrom = jsonStart + 1;
      continue;
    }

    try {
      const parsed = JSON.parse(text.substring(jsonStart, afterJson));
      const narrowed = narrowQuestion(parsed);
      if (narrowed) questions.push(narrowed);
    } catch (err) {
      warnError('question: malformed marker', err);
    }

    searchFrom = afterJson + MARKER_SUFFIX.length;
    consumed = searchFrom;
  }

  return { questions, consumed };
}

export function extractQuestionsFromStream(text: string): ClarificationQuestion[] {
  return scanQuestions(text).questions;
}

export function createQuestionAccumulator() {
  let buffer = '';
  const seenIds = new Set<string>();
  const allQuestions: ClarificationQuestion[] = [];

  return {
    addChunk(chunk: string): ClarificationQuestion[] {
      buffer += chunk;
      const { questions, consumed } = scanQuestions(buffer);
      const newOnes = questions.filter((q) => !seenIds.has(q.id));
      for (const q of newOnes) {
        seenIds.add(q.id);
        allQuestions.push(q);
      }

      const tail = buffer.substring(consumed);
      const pendingPrefix = tail.lastIndexOf(MARKER_PREFIX);
      buffer = pendingPrefix === -1 ? '' : tail.substring(pendingPrefix);

      return newOnes;
    },
    getAll(): ClarificationQuestion[] {
      return [...allQuestions];
    },
  };
}
