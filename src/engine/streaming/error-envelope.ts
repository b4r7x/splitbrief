import { isRecord, optionalString } from '../../utils/type-guards.js';

export function envelopeErrorDetail(value: Record<string, unknown>, fallback: string): string {
  const envelope = isRecord(value.error) ? value.error : undefined;
  const data = envelope !== undefined && isRecord(envelope.data) ? envelope.data : undefined;
  const message = optionalString(data?.message, { trim: true, nonEmpty: true });
  if (message === undefined) return fallback;
  const name = optionalString(envelope?.name, { trim: true, nonEmpty: true });
  return name === undefined ? message : `${name}: ${message}`;
}
