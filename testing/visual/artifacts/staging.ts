import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RelativeArtifactPath } from '../contracts/identifiers.js';
import { resolveWritableContainedArtifactPath } from './confinement.js';

export interface StagedArtifactFile {
  readonly root: string;
  readonly relativePath: RelativeArtifactPath;
  readonly data: string | Uint8Array;
}

export type ArtifactFileWriter = (file: StagedArtifactFile) => Promise<void>;

export async function writeStagedArtifactFile(file: StagedArtifactFile): Promise<void> {
  const path = await prepareWritableArtifactPath(file);
  await writeFile(path, file.data, { flag: 'wx', mode: 0o600 });
}

export async function prepareWritableArtifactPath(file: StagedArtifactFile): Promise<string> {
  const uncheckedPath = await resolveWritableContainedArtifactPath({
    root: file.root,
    relativePath: file.relativePath,
  });
  await mkdir(dirname(uncheckedPath), { recursive: true, mode: 0o700 });
  return resolveWritableContainedArtifactPath({
    root: file.root,
    relativePath: file.relativePath,
  });
}

export async function verifyStagedArtifact(options: {
  readonly root: string;
  readonly files: readonly Omit<StagedArtifactFile, 'root'>[];
}): Promise<void> {
  for (const file of options.files) {
    const path = await resolveWritableContainedArtifactPath({
      root: options.root,
      relativePath: file.relativePath,
    });
    const actual = await readFile(path);
    const expected =
      typeof file.data === 'string' ? new TextEncoder().encode(file.data) : file.data;
    if (!actual.equals(expected)) {
      throw new Error('Staged artifact bytes do not match their validated serializer output');
    }
  }
}
