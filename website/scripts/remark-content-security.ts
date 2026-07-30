import type { Root } from 'mdast';
import { validateDocumentSecurity } from './content-security.js';

type ProcessorFile = {
  readonly value: unknown;
  fail(
    reason: string,
    place: { readonly column: number; readonly line: number },
    origin: string,
  ): never;
};

const SECURITY_RULE = 'splitbrief:content-security';

export function remarkContentSecurity(): (tree: Root, file: ProcessorFile) => undefined {
  return (tree, file) => {
    const issue = validateDocumentSecurity({
      bodyStartLine: 1,
      source: String(file.value),
      tree,
    })[0];
    if (!issue) {
      return;
    }

    file.fail(issue.message, { column: 1, line: issue.line }, SECURITY_RULE);
  };
}
