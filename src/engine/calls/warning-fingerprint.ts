import { sha256Hex } from '../../utils/sha256.js';

const ISO_TIMESTAMP_PATTERN =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})\b/g;
const SESSION_ID_PATTERN =
  /\b(session|thread|conversation|resume|run)[ _-]?(?:id)?\s*[:=#-]?\s*[a-z0-9][a-z0-9._:-]{7,}\b/gi;
const ATTEMPT_PATTERN = /\b(?:attempt|retry)(?:\s+|[:=#-])\d+\b/gi;
const PID_PATTERN = /\bpid(?:\s+|[:=#-])\d+\b/gi;
const DURATION_PATTERN = /\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|second|seconds|m|min|mins)\b/gi;
const TEMP_PATH_PATTERN = /(?:\/private)?\/(?:var\/folders|tmp)\/[^\s'"`]+/g;
const PROJECT_PATH_PATTERN = /\/Users\/[^/\s]+\/Projects\/[^\s'"`]+/g;

export function runnerCallWarningFingerprint(opts: {
  code: string;
  source: string;
  message: string;
}): string {
  const normalized = normalizeRunnerCallWarningFingerprintText(opts.message);
  return `rw:${sha256Hex(`${opts.source}\0${opts.code}\0${normalized}`).slice(0, 24)}`;
}

export function normalizeRunnerCallWarningFingerprintText(message: string): string {
  return message
    .replace(ISO_TIMESTAMP_PATTERN, '<timestamp>')
    .replace(SESSION_ID_PATTERN, '$1 <id>')
    .replace(ATTEMPT_PATTERN, 'attempt <n>')
    .replace(PID_PATTERN, 'pid <n>')
    .replace(DURATION_PATTERN, '<duration>')
    .replace(TEMP_PATH_PATTERN, '<temp-path>')
    .replace(PROJECT_PATH_PATTERN, '<project-path>')
    .replace(/\s+/g, ' ')
    .trim();
}
