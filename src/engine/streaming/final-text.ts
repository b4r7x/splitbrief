export type FinalTextReconciliation =
  | { kind: 'none' }
  | { kind: 'full'; text: string }
  | { kind: 'suffix'; text: string }
  | { kind: 'replace'; text: string };

export function reconcileFinalText(
  streamedText: string,
  finalText: string,
): FinalTextReconciliation {
  if (streamedText.length === 0) return { kind: 'full', text: finalText };
  if (streamedText === finalText) return { kind: 'none' };
  if (finalText.startsWith(streamedText)) {
    return { kind: 'suffix', text: finalText.slice(streamedText.length) };
  }
  return { kind: 'replace', text: finalText };
}
