const PATH_BOUNDARY = String.raw`(?:^|[\s('\x22\x60=:[{?#&;,\u2500-\u257f])`;
const NETWORK_PATH_BOUNDARY = String.raw`(?:^|[\s('\x22\x60=[{?#&;])`;
const WINDOWS_DRIVE_PATH_PATTERN = new RegExp(
  String.raw`${PATH_BOUNDARY}[a-z]:[\\/][^\s'\x22\x60]+`,
  'iu',
);
const WINDOWS_UNC_PATH_PATTERN = new RegExp(
  String.raw`${PATH_BOUNDARY}\\\\(?:[?.]\\)?[^\\\s'\x22\x60]+\\[^\s'\x22\x60]+`,
  'u',
);
const WINDOWS_ROOT_RELATIVE_PATH_PATTERN = new RegExp(
  String.raw`${PATH_BOUNDARY}\\[A-Za-z0-9][^\\\s'\x22\x60]*\\[^\s'\x22\x60]+`,
  'u',
);
const HOME_PATH_PATTERN = new RegExp(
  String.raw`${PATH_BOUNDARY}~[A-Za-z0-9._-]*[\\/][^\s'\x22\x60]+`,
  'u',
);
const NETWORK_PATH_PATTERN = new RegExp(
  String.raw`${NETWORK_PATH_BOUNDARY}\/\/[^\s/]+\/[^\s'\x22\x60]+`,
  'u',
);
const POSIX_PATH_PATTERN = new RegExp(
  String.raw`${PATH_BOUNDARY}(\/(?!\/)[^\s'\x22\x60\u2500-\u257f]+)`,
  'gu',
);
// A command a narrow hint cuts short ends in an ellipsis.
const SLASH_COMMAND_PATTERN = /^\/[a-z][a-z0-9-]*[!),.:;?\]}…]*$/u;
const TRAILING_PROSE_PUNCTUATION_PATTERN = /[!),.:;?\]}]+$/u;
// These exact synthetic fixture paths identify no operator machine; other host paths remain forbidden.
const FIXTURE_HOST_PATHS = new Set([
  '/Users/dev/notes/brief.md',
  '/Users/me/notes/product-planning/archive/receiving-workflow/brief.md',
  '/Users/me/notes/product-planning/archive/',
  '/Users/me/notes/product-planning/archive/receiving-workflow/',
  '/Volumes/design/receiving-flow.png',
]);

export function containsHostPath(value: string): boolean {
  if (
    WINDOWS_DRIVE_PATH_PATTERN.test(value) ||
    WINDOWS_UNC_PATH_PATTERN.test(value) ||
    WINDOWS_ROOT_RELATIVE_PATH_PATTERN.test(value) ||
    HOME_PATH_PATTERN.test(value) ||
    NETWORK_PATH_PATTERN.test(value)
  ) {
    return true;
  }

  for (const match of value.matchAll(POSIX_PATH_PATTERN)) {
    const candidate = match[1];
    if (!candidate || SLASH_COMMAND_PATTERN.test(candidate)) continue;
    const path = candidate.replace(TRAILING_PROSE_PUNCTUATION_PATTERN, '');
    if (FIXTURE_HOST_PATHS.has(path)) continue;
    if (
      path.endsWith('…') &&
      [...FIXTURE_HOST_PATHS].some((fixture) => fixture.startsWith(path.slice(0, -1)))
    )
      continue;
    return true;
  }
  return false;
}
