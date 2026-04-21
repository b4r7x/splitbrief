import type { WorkflowMode } from '../../../core/schemas/enums.js';

const TRIVIAL_KEYWORDS: readonly string[] = [
  'typo', 'rename', 'spelling',
  'null check', 'optional chaining',
  'add log', 'console.log', 'logger',
  'remove unused', 'delete dead code',
  'fix indent', 'format',
  'update comment', 'fix comment',
  'bump version',
  'import order',
  'add missing export',
];

const SHORT_PROMPT_WORDS = 12;

const DOWNGRADABLE_MODES: readonly WorkflowMode[] = ['standard', 'speckit'];

export type AdvisorReason = 'short-prompt-with-trivial-keyword';

export type AdvisorResult = {
  shouldAdvise: boolean;
  currentMode: WorkflowMode;
  suggestedMode: WorkflowMode;
  reason: AdvisorReason | null;
};

export function adviseMode(prompt: string, currentMode: WorkflowMode): AdvisorResult {
  if (!(DOWNGRADABLE_MODES as readonly string[]).includes(currentMode)) {
    return { shouldAdvise: false, currentMode, suggestedMode: currentMode, reason: null };
  }

  const lower = prompt.toLowerCase();
  const wordCount = prompt.trim().split(/\s+/).filter(Boolean).length;
  const hasTrivialKeyword = TRIVIAL_KEYWORDS.some(kw => lower.includes(kw));

  if (wordCount > 0 && wordCount < SHORT_PROMPT_WORDS && hasTrivialKeyword) {
    return {
      shouldAdvise: true,
      currentMode,
      suggestedMode: 'instant',
      reason: 'short-prompt-with-trivial-keyword',
    };
  }

  return { shouldAdvise: false, currentMode, suggestedMode: currentMode, reason: null };
}

export function formatAdvisoryText(result: AdvisorResult): string {
  return `This looks trivial. Consider --mode ${result.suggestedMode} instead of --mode ${result.currentMode}.`;
}

let currentAdvisory: AdvisorResult | null = null;
const listeners = new Set<() => void>();

export function setAdvisory(next: AdvisorResult | null): void {
  if (currentAdvisory === next) return;
  currentAdvisory = next;
  for (const listener of listeners) listener();
}

export function getAdvisory(): AdvisorResult | null {
  return currentAdvisory;
}

export function subscribeAdvisory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function __resetAdvisoryForTests(): void {
  currentAdvisory = null;
  listeners.clear();
}
