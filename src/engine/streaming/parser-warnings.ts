import { runnerCallUnknownUpstreamPreview } from '../calls/unknown-upstream.js';
import type { ParsedWarningInfo, ParsedTextChannel } from '../runners/types.js';
import { runnerCallWarningFingerprint } from '../calls/warning-fingerprint.js';
import { isRecord } from '../../utils/type-guards.js';

export function parsedMalformedRecordWarning(opts: {
  parser: string;
  line: string;
  message: string;
}): ParsedWarningInfo {
  return parsedRecordWarning({
    parser: opts.parser,
    code: `malformed_${opts.parser.replace(/-/g, '_')}`,
    label: `Malformed ${opts.parser} record`,
    value: opts.line,
    upstreamType: 'malformed_json',
    message: opts.message,
  });
}

export function parsedUnknownRecordWarning(opts: {
  parser: string;
  value: unknown;
  benign?: boolean | undefined;
}): ParsedWarningInfo | null {
  if (opts.benign === true) return null;
  const code = `unknown_${opts.parser.replace(/-/g, '_')}_record`;
  const upstreamType = upstreamTypeOf(opts.value);
  const warning = parsedRecordWarning({
    parser: opts.parser,
    code,
    label: `Unknown ${opts.parser} record`,
    value: opts.value,
    upstreamType,
    message: `Unknown ${opts.parser} record skipped`,
  });
  return warning;
}

export function parsedUpstreamFailureWarning(opts: {
  parser: string;
  upstreamType: string;
  message: string;
}): ParsedWarningInfo {
  return parsedRecordWarning({
    parser: opts.parser,
    code: `${opts.parser}_upstream_failure`,
    label: `${opts.parser} upstream failure`,
    value: opts.message,
    upstreamType: opts.upstreamType,
    message: opts.message,
  });
}

function parsedRecordWarning(opts: {
  parser: string;
  code: string;
  label: string;
  value: unknown;
  upstreamType: string;
  message: string;
  channel?: ParsedTextChannel | undefined;
}): ParsedWarningInfo {
  const message = runnerCallUnknownUpstreamPreview({
    label: opts.label,
    value: opts.value,
  });
  const source = opts.parser;
  return {
    code: opts.code,
    severity: 'warning',
    source,
    surface: 'activity',
    parser: opts.parser,
    upstreamType: opts.upstreamType,
    channel: opts.channel ?? 'stdout',
    message,
    fingerprint: runnerCallWarningFingerprint({
      code: opts.code,
      source,
      message: opts.message,
    }),
  };
}

function upstreamTypeOf(value: unknown): string {
  if (!isRecord(value)) return typeof value;
  const type = value.type;
  return typeof type === 'string' && type.length > 0 ? type : 'record';
}
