import { type Dirent, readdirSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceDiagnostic } from './source-diagnostic.js';

type FindFilesOptions = {
  readonly directory: string;
  readonly extension: string;
};

type FileDiscovery = {
  readonly files: readonly string[];
  readonly issues: readonly SourceDiagnostic[];
};

export const DOCS_CONTENT_DIRECTORY = fileURLToPath(new URL('../content/docs', import.meta.url));

export function discoverFiles(options: FindFilesOptions): FileDiscovery {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(options.directory, { withFileTypes: true });
  } catch (error) {
    return {
      files: [],
      issues: [
        {
          file: options.directory,
          message: `cannot read directory: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  const files: string[] = [];
  const issues: SourceDiagnostic[] = [];
  for (const entry of entries) {
    const path = join(options.directory, entry.name);
    if (entry.isDirectory()) {
      const nested = discoverFiles({ ...options, directory: path });
      files.push(...nested.files);
      issues.push(...nested.issues);
    } else if (extname(path) === options.extension) {
      files.push(path);
    }
  }

  return { files: files.sort(), issues };
}

export function findFiles(options: FindFilesOptions): string[] {
  return [...discoverFiles(options).files];
}

export function relativePosixPath(options: {
  readonly directory: string;
  readonly file: string;
}): string {
  return relative(options.directory, options.file).split(sep).join('/');
}

export function relativeFileStem(options: {
  readonly directory: string;
  readonly file: string;
}): string {
  const path = relativePosixPath(options);
  return path.slice(0, -extname(path).length);
}
