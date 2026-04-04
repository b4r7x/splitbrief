const enabled = process.env.TINY_SPEC_DEBUG === '1';

export function debug(area: string, msg: string, data?: Record<string, unknown>) {
  if (!enabled) return;
  const ts = new Date().toISOString().slice(11, 23);
  const suffix = data ? ' ' + JSON.stringify(data) : '';
  process.stderr.write(`[${ts}] ${area}: ${msg}${suffix}\n`);
}
