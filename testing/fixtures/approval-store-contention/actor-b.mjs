import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mutateApprovalsStore } from '../../../src/core/approval/store.js';

const [projectDir, syncDir] = process.argv.slice(2);
if (!projectDir || !syncDir) process.exit(2);

writeFileSync(join(syncDir, 'b-starting'), '');

const grant = {
  pattern: 'b',
  class: 'package_change',
  scope: 'session',
  sessionId: 'sess-1',
  grantedAt: '2026-01-01T00:00:00.000Z',
};

mutateApprovalsStore(projectDir, (store) => ({
  version: 1,
  grants: [...store.grants, grant],
}));
