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
  // A tool that splits a long reply across messages reports only the last one as
  // its final text; the streamed text already holds the whole document.
  if (streamedText.endsWith(finalText)) return { kind: 'none' };
  if (finalText.startsWith(streamedText)) {
    return { kind: 'suffix', text: finalText.slice(streamedText.length) };
  }
  return { kind: 'replace', text: finalText };
}

/**
 * Appends one whole message so it starts on its own line after a blank one: a
 * verdict line or a heading a parser anchors on never lands mid-line behind the
 * message before it.
 */
export function appendMessage(text: string, message: string): string {
  if (text.length === 0) return message;
  if (message.length === 0 || text.endsWith('\n\n')) return text + message;
  return `${text}${text.endsWith('\n') ? '\n' : '\n\n'}${message}`;
}

/**
 * The final text is the tail of the streamed text with only line breaks put in:
 * the separators `appendMessage` starts each message with. It says nothing the
 * stream did not already show.
 */
export function onlyAddsLineBreaks(streamedText: string, finalText: string): boolean {
  let streamed = streamedText.length - 1;
  for (let index = finalText.length - 1; index >= 0; index -= 1) {
    if (streamed >= 0 && finalText[index] === streamedText[streamed]) streamed -= 1;
    else if (finalText[index] !== '\n') return false;
  }
  return true;
}
