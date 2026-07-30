import { isAbsolute, relative, resolve, sep } from 'node:path';
import { GITHUB_REPOSITORY_URL } from '../shared/site-identity.js';

const repositoryUrl = new URL(GITHUB_REPOSITORY_URL);
const GITHUB_REPOSITORY_PREFIX = `${repositoryUrl.pathname}/`;

type RepositoryTarget =
  | {
      readonly kind: 'external';
    }
  | {
      readonly kind: 'invalid';
      readonly message: string;
      readonly resolvedPath: string;
    }
  | {
      readonly kind: 'target';
      readonly fragment: string;
      readonly path: string;
      readonly target: string;
      readonly targetKind: 'blob' | 'tree';
    };

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveRepositoryTarget(options: {
  readonly href: string;
  readonly repositoryRoot: string;
}): RepositoryTarget {
  let url: URL;
  try {
    url = new URL(options.href);
  } catch {
    return { kind: 'external' };
  }
  if (
    url.origin !== repositoryUrl.origin ||
    url.pathname === repositoryUrl.pathname ||
    url.pathname === GITHUB_REPOSITORY_PREFIX ||
    !url.pathname.startsWith(GITHUB_REPOSITORY_PREFIX)
  ) {
    return { kind: 'external' };
  }

  const repositoryPath = url.pathname.slice(GITHUB_REPOSITORY_PREFIX.length);
  if (!/^(?:blob|tree)\//.test(repositoryPath)) {
    return { kind: 'external' };
  }

  const match = /^(blob|tree)\/main\/(.+)$/.exec(repositoryPath);
  if (!match || (match[1] !== 'blob' && match[1] !== 'tree')) {
    return {
      kind: 'invalid',
      message: 'in-repository GitHub URL must use blob/main or tree/main with a target path',
      resolvedPath: url.pathname,
    };
  }

  const path = decoded(match[2] ?? '');
  const target = resolve(options.repositoryRoot, path);
  const targetRelativePath = relative(options.repositoryRoot, target);
  if (
    targetRelativePath === '' ||
    targetRelativePath.startsWith(`..${sep}`) ||
    targetRelativePath === '..' ||
    isAbsolute(targetRelativePath)
  ) {
    return {
      kind: 'invalid',
      message: 'in-repository GitHub target escapes the repository root',
      resolvedPath: path,
    };
  }

  return {
    fragment: decoded(url.hash.slice(1)),
    kind: 'target',
    path,
    target,
    targetKind: match[1],
  };
}
