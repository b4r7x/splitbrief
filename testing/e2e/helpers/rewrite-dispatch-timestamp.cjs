const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');

const { openSync, closeSync, fsyncSync } = fs;
const stateTemps = new Map();
const timestamp = 1_700_000_000;
let taskStart;

fs.openSync = (path, ...args) => {
  const fd = openSync(path, ...args);
  if (typeof path === 'string' && path.includes('/.state.json.tmp.')) stateTemps.set(fd, path);
  return fd;
};

fs.closeSync = (fd) => {
  stateTemps.delete(fd);
  return closeSync(fd);
};

fs.fsyncSync = (fd) => {
  const path = stateTemps.get(fd);
  if (path !== undefined) {
    const state = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (state.tasks?.[0]?.revision === 2 && state.changedFilesBaseline?.activeTaskSnapshot) {
      const dispatched = state.lineages?.T001?.dispatchedRevision.T001;
      if (dispatched === 1) {
        fs.futimesSync(fd, timestamp, timestamp);
        taskStart = publication(fd, state.stateRevision);
      } else if (dispatched === 2 && taskStart && state.stateRevision === taskStart.revision + 1) {
        fs.futimesSync(fd, timestamp, timestamp);
        fs.writeFileSync(
          process.env.SPLITBRIEF_TEST_REWRITE_DISPATCH,
          JSON.stringify({ taskStart, dispatch: publication(fd, state.stateRevision) }),
        );
      }
    }
  }
  return fsyncSync(fd);
};

function publication(fd, revision) {
  const { size, mtimeNs } = fs.fstatSync(fd, { bigint: true });
  return { revision, size: Number(size), mtimeNs: mtimeNs.toString() };
}

syncBuiltinESMExports();
