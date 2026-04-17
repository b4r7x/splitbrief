// Order matters: specific prefixes before generic sk-, then keyword-contextual patterns.
const KEY_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[a-zA-Z0-9_-]{20,}/g, 'sk-ant-***REDACTED***'],
  [/sk-or-[a-zA-Z0-9_-]{20,}/g, 'sk-or-***REDACTED***'],
  [/gsk_[a-zA-Z0-9_-]{20,}/g, 'gsk_***REDACTED***'],
  [/xai-[a-zA-Z0-9_-]{20,}/g, 'xai-***REDACTED***'],
  [/glhf_[a-zA-Z0-9_-]{20,}/g, 'glhf_***REDACTED***'],
  [/AIza[a-zA-Z0-9_-]{20,}/g, 'AIza***REDACTED***'],
  [/github_pat_[A-Za-z0-9_]{22,}/g, 'github_pat_***REDACTED***'],
  [/ghp_[A-Za-z0-9]{36,}/g, 'ghp_***REDACTED***'],
  [/gho_[A-Za-z0-9]{36,}/g, 'gho_***REDACTED***'],
  [/AKIA[A-Z0-9]{16}/g, 'AKIA***REDACTED***'],
  [/sk-[a-zA-Z0-9_-]{20,}/g, 'sk-***REDACTED***'],
  [/Bearer\s+[a-zA-Z0-9._-]{20,}/g, 'Bearer ***REDACTED***'],
  [/(?<=(?:api[_-]?key|token|secret|credential|password|authorization|x-api-key)\s*[:=]\s*["']?)[a-zA-Z0-9+/=_-]{40,}/gi, '***REDACTED***'],
  [/((?:api[_-]?key|token|secret|credential|password|authorization)\s*[=:]\s*["']?)[a-zA-Z0-9+/=_-]{20,}/gi, '$1***REDACTED***'],
];

export function redactSecrets(msg: string): string {
  let result = msg;
  for (const [pattern, replacement] of KEY_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function maskApiKey(key: string | undefined): string {
  if (!key) return '';
  if (key.length < 8) return '••••••••';
  return '••••' + key.slice(-4);
}
