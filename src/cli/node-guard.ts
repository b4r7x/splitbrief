import { cliError } from './errors.js';
import { SPLITBRIEF_IDENTITY } from '../core/identity.js';

const MINIMUM_NODE_MAJOR = 22;

export function assertSupportedNodeVersion(runtimeVersion = process.versions.node): void {
  const major = Number.parseInt(runtimeVersion, 10);
  // An unparseable version means a runtime that does not report a Node major
  // (a shim, a fork); refusing there would block runtimes that may well work.
  // The guard exists to reject a *known* too-old Node, not an unknown one.
  if (Number.isNaN(major) || major >= MINIMUM_NODE_MAJOR) return;

  throw cliError(
    `${SPLITBRIEF_IDENTITY.executable} requires Node.js ${MINIMUM_NODE_MAJOR} or newer; this process is Node.js ${runtimeVersion}. ` +
      `Install Node ${MINIMUM_NODE_MAJOR}+ (for example \`nvm install ${MINIMUM_NODE_MAJOR}\`) and run ${SPLITBRIEF_IDENTITY.executable} again.`,
    1,
  );
}
