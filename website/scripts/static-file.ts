import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export type StaticFile = {
  readonly path: string;
  readonly size: number;
};

export async function findExistingStaticFile(options: {
  readonly candidatePath: string;
  readonly rootDirectory: string;
}): Promise<StaticFile | undefined> {
  try {
    const fileStats = await stat(options.candidatePath);
    if (!fileStats.isFile()) {
      return undefined;
    }

    const canonicalPath = await realpath(options.candidatePath);
    const isInsideRoot =
      canonicalPath === options.rootDirectory ||
      canonicalPath.startsWith(`${options.rootDirectory}${sep}`);
    return isInsideRoot ? { path: canonicalPath, size: fileStats.size } : undefined;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return undefined;
    }
    throw error;
  }
}

export async function findStaticFile(options: {
  readonly pathname: string;
  readonly rootDirectory: string;
}): Promise<StaticFile | undefined> {
  const exactPath = resolve(options.rootDirectory, `.${options.pathname}`);
  const candidates = options.pathname.endsWith('/')
    ? [resolve(exactPath, 'index.html')]
    : [exactPath, resolve(exactPath, 'index.html'), `${exactPath}.html`];

  for (const candidatePath of candidates) {
    const isInsideRoot =
      candidatePath === options.rootDirectory ||
      candidatePath.startsWith(`${options.rootDirectory}${sep}`);
    if (!isInsideRoot) {
      continue;
    }

    const file = await findExistingStaticFile({
      candidatePath,
      rootDirectory: options.rootDirectory,
    });
    if (file) {
      return file;
    }
  }

  return undefined;
}
