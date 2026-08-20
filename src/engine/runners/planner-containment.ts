import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

export type ContainmentProfileName = 'seatbelt' | 'bubblewrap';

/**
 * The OS-level write-denial launcher available on this host. macOS ships
 * `/usr/bin/sandbox-exec` (Seatbelt); Linux requires a `bwrap` on PATH. Without
 * an admitted launcher the backend lacks compiler capability — the capability
 * registry refuses on a missing profile before any dispatch. Availability is
 * all this observes; nothing here launches or contains a child.
 */
export async function platformContainmentProfile(): Promise<
  ContainmentProfileName | 'unavailable'
> {
  if (process.platform === 'darwin') {
    return (await executableAvailable('/usr/bin/sandbox-exec')) ? 'seatbelt' : 'unavailable';
  }
  if (process.platform === 'linux') {
    const pathEntries = (process.env.PATH ?? '')
      .split(delimiter)
      .filter((entry) => entry.length > 0 && isAbsolute(entry));
    for (const entry of [...pathEntries, '/usr/bin', '/bin']) {
      if (await executableAvailable(join(entry, 'bwrap'))) return 'bubblewrap';
    }
    return 'unavailable';
  }
  return 'unavailable';
}

async function executableAvailable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
