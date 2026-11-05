import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type VersionedCli = Readonly<{
  /** The PATH entry: it holds only the `<command>` symlink. */
  binDir: string;
  executable: (version: string) => string;
  /** Writes the release's file with `writeFileSync`, so a second write keeps the path and the inode. */
  write: (version: string, script: string) => void;
  /** Points the PATH symlink at another release, the way a versioned updater does. */
  pointTo: (version: string) => void;
  /** Deletes a release, the way an updater prunes old versions. */
  prune: (version: string) => void;
}>;

/** A tool laid out as `versions/<release>/<command>` with `bin/<command>` a symlink to one release. */
export function versionedCli(input: Readonly<{ root: string; command: string }>): VersionedCli {
  const binDir = join(input.root, 'bin');
  const link = join(binDir, input.command);
  const executable = (version: string) => join(input.root, 'versions', version, input.command);
  mkdirSync(binDir, { recursive: true });
  return {
    binDir,
    executable,
    write: (version, script) => {
      mkdirSync(join(input.root, 'versions', version), { recursive: true });
      writeFileSync(executable(version), script, 'utf8');
      chmodSync(executable(version), 0o755);
    },
    pointTo: (version) => {
      rmSync(link, { force: true });
      symlinkSync(executable(version), link);
    },
    prune: (version) => {
      rmSync(join(input.root, 'versions', version), { recursive: true, force: true });
    },
  };
}
