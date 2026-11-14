export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

export function hasErrnoCode(err: unknown, ...codes: string[]): boolean {
  return isNodeError(err) && err.code !== undefined && codes.includes(err.code);
}

export function isENOENT(err: unknown): boolean {
  return hasErrnoCode(err, 'ENOENT');
}
