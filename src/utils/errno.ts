export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

export function isENOENT(err: unknown): boolean {
  return isNodeError(err) && err.code === 'ENOENT';
}
