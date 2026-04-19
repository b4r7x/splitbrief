export type AppError<K extends string = string, D = unknown> =
  Error & { readonly kind: K; readonly data: D };

export function error<K extends string, D = undefined>(
  kind: K,
  message: string,
  data?: D,
  cause?: unknown,
): AppError<K, D> {
  const err = (cause !== undefined
    ? new Error(message, { cause })
    : new Error(message)) as AppError<K, D>;
  Object.assign(err, { kind, data: data as D });
  return err;
}

export const matches = <K extends string>(kind: K) =>
  (err: unknown): err is AppError<K> =>
    err instanceof Error && (err as { kind?: unknown }).kind === kind;
