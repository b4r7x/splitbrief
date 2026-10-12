// Pure checks over an npm tarball listing, used by pack-install-smoke.mjs.
// `entries` are the paths `tar -tzf` prints; directory entries count for nothing.
// `files` is the packed package.json `files` array.

const PREFIX = 'package/';
const REQUIRED = ['package.json', 'dist/cli.js', 'README.md', 'LICENSE', 'CHANGELOG.md'];
const LEAKED_DIRS = ['src/', 'testing/', '.claude/'];
const TEST_FILE = /(^|\/)[^/]+\.test\.[^/]+$/;

/**
 * @param {readonly string[]} entries
 * @param {readonly string[]} files
 * @returns {string[]}
 */
export function tarballProblems(entries, files) {
  const problems = [];
  const paths = [];
  for (const entry of entries) {
    if (entry.endsWith('/')) continue;
    if (entry.startsWith(PREFIX)) paths.push(entry.slice(PREFIX.length));
    else problems.push(`entry outside ${PREFIX}: ${entry}`);
  }
  for (const required of REQUIRED) {
    if (!paths.includes(required)) problems.push(`missing ${PREFIX}${required}`);
  }
  for (const listed of files) {
    const path = listed.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!paths.some((p) => p === path || p.startsWith(`${path}/`))) {
      problems.push(`missing '${listed}' from package.json files`);
    }
  }
  for (const path of paths) {
    if (LEAKED_DIRS.some((dir) => path.startsWith(dir)) || TEST_FILE.test(path)) {
      problems.push(`leaked ${PREFIX}${path}`);
    }
  }
  return problems;
}
