export const REVIEWER_EXIT_CAUSE = 'ENOSPC: no space left on device';

export const REVIEWER_EXIT_TRACE = [
  'Failed to open workspace index.',
  ...Array.from(
    { length: 8 },
    (_, index) => `    at openIndex (workspace/package/index-reader.js:${130 + index}:24)`,
  ),
  `Caused by: ${REVIEWER_EXIT_CAUSE}`,
].join('\n');

export const REVIEWER_NODE_EXIT_TRACE = `node:fs:560
  return binding.open(
                 ^

Error: ENOENT: no such file or directory, open 'workspace-index.json'
    at Object.openSync (node:fs:560:18)
    at Object.readFileSync (node:fs:444:35)
    at [eval]:1:20
    at runScriptInThisContext (node:internal/vm:209:10)
    at node:internal/process/execution:446:12
    at [eval]-wrapper:6:24
    at runScriptInContext (node:internal/process/execution:444:60)
    at evalFunction (node:internal/process/execution:279:30)
    at evalTypeScript (node:internal/process/execution:291:3)
    at node:internal/main/eval_string:74:3 {
  errno: -2,
  code: 'ENOENT',
  syscall: 'open',
  path: 'workspace-index.json'
}

Node.js v22.22.2
`;

export const REVIEWER_NODE_EMOJI_EXIT_TRACE = REVIEWER_NODE_EXIT_TRACE.replaceAll(
  'workspace-index.json',
  'src/importers/integration/fixtures/international/localized-filenames/multilingual-workspaces/' +
    'expected-output/project-documents/technical-reference/published/assets/exports/📚-workspace-index.json',
);
