import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { mutateApprovalsStore } from '../../../src/core/approval/store.js';

const [projectDir, syncDir] = process.argv.slice(2);
if (!projectDir || !syncDir) process.exit(2);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const grant = {
  pattern: 'a',
  class: 'package_change',
  scope: 'session',
  sessionId: 'sess-1',
  grantedAt: '2026-01-01T00:00:00.000Z',
};

mutateApprovalsStore(projectDir, (store) => {
  writeFileSync(join(syncDir, 'a-entered'), '');
  const releasePath = join(syncDir, 'release-a');
  const deadline = Date.now() + 5000;
  while (!existsSync(releasePath)) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for release-a');
    }
    sleepSync(10);
  }
  return { version: 1, grants: [...store.grants, grant] };
});
