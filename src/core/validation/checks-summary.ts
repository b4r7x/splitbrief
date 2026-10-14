import type { CheckStatus } from '../schemas/task.js';

/**
 * A task's check results in the words the plain output and the review packet share. A check that
 * did not run is counted apart: it is neither a pass nor a failure.
 */
export function checksSummary(results: readonly { status: CheckStatus }[]): string {
  if (results.length === 0) return 'no checks';
  const count = (status: CheckStatus) =>
    results.filter((result) => result.status === status).length;
  const passed = count('pass');
  const ran = passed + count('fail');
  const refused = count('refused');
  const notRun = results.length - ran - refused;
  return [
    ...(ran > 0 ? [`${passed} of ${ran} checks passed`] : []),
    ...(refused > 0 ? [`${refused} refused`] : []),
    ...(notRun > 0 ? [`${notRun} not run`] : []),
  ].join(', ');
}
