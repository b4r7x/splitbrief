import { writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { mutateApprovalsStore } from '../../../src/core/approval/store.js';
import { approvalsFile } from '../../../src/core/paths.js';
import { lockSibling } from '../../../src/lib/file-lock.js';

const [projectDir, syncDir] = process.argv.slice(2);
if (!projectDir || !syncDir) process.exit(2);

const grant = {
  pattern: 'b',
  class: 'package_change',
  scope: 'session',
  sessionId: 'sess-1',
  grantedAt: '2026-01-01T00:00:00.000Z',
};

const lockPath = lockSibling(approvalsFile(projectDir));
try {
  const fd = openSync(lockPath, 'wx');
  closeSync(fd);
  unlinkSync(lockPath);
} catch (err) {
  const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
  if (code !== 'EEXIST') throw err;
  writeFileSync(join(syncDir, 'b-starting'), '');
}

mutateApprovalsStore(projectDir, (store) => ({
  version: 1,
  grants: [...store.grants, grant],
}));
