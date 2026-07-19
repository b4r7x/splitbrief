const PATH_BOUNDARY = String.raw`(?:^|[\s('\x22\x60=:[{?#&;,])`;
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
const POSIX_PATH_PATTERN = new RegExp(String.raw`${PATH_BOUNDARY}(\/(?!\/)[^\s'\x22\x60]+)`, 'gu');
const SLASH_COMMAND_PATTERN = /^\/[a-z][a-z0-9-]*[!),.:;?\]}]*$/u;

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
    if (candidate && !SLASH_COMMAND_PATTERN.test(candidate)) return true;
  }
  return false;
}
