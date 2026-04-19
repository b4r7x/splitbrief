export type IdentifierValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function validateSafeIdentifier(id: string): IdentifierValidation {
  if (!id?.trim()) {
    return { ok: false, reason: 'must not be empty' };
  }
  if (id.includes('..') || id.includes('/') || id.includes('\\')) {
    return { ok: false, reason: "must not contain '..', '/' or '\\'" };
  }
  return { ok: true };
}
