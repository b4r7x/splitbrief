import { sanitizeTerminalDiagnosticText } from '../../utils/display-text/diagnostic.js';
import { RUNNER_CALL_STDERR_MAX_BYTES } from './output-limit.js';
import type { RunnerCallWarningInput } from './types.js';

export function stderrLooksWarningLike(text: string): boolean {
  return /\b(error|failed|failure|fatal|exception|warning|warn|deprecated)\b/i.test(text);
}

export function stderrDiagnosticWarning(code: string, message: string): RunnerCallWarningInput {
  return {
    code,
    severity: 'warning',
    source: 'stderr',
    surface: 'status',
    channel: 'stderr',
    message: sanitizeTerminalDiagnosticText(message),
  };
}

export function appendStderrPreview(preview: string, text: string): string {
  return sanitizeTerminalDiagnosticText(`${preview}${text}\n`, {
    maxChars: RUNNER_CALL_STDERR_MAX_BYTES,
  });
}
