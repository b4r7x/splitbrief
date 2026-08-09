/**
 * The zero-task retry must not repeat the first attempt verbatim: an identical prompt in a
 * resumed session reproduces the same unparsable reply (a real run answered "the project is
 * unchanged since my earlier review" and re-emitted the same fenced document). The retry keeps
 * the session — its context is the work already done — but leads with what was wrong with the
 * previous reply, carrying the parse diagnostics the first attempt surfaced, and restates the
 * original request so planners without session resume still see the full task.
 */
export function zeroTaskRetryPrompt(originalPrompt: string, parseDiagnostics: string[]): string {
  const diagnostics =
    parseDiagnostics.length > 0
      ? `${parseDiagnostics.map((message) => `- ${message}`).join('\n')}\n`
      : '';
  return (
    'Your previous reply could not be used: no Task Brief was parsed from it.\n' +
    diagnostics +
    'Re-emit the complete tasks.md content now as plain top-level markdown. Do not wrap the document in a ``` code fence and do not add prose before or after it — start directly with the first task\u2019s --- frontmatter line. Code fences inside a brief\u2019s sections (Signature, Current Code, Type Definitions) are fine.\n\n' +
    'The original request follows.\n\n' +
    originalPrompt
  );
}
