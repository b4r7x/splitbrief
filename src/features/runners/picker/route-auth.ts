import type { CliProviderAuthFact } from '../../../core/discovery/detection/auth.js';
import {
  type RouteAuthState,
  ROUTE_NEEDS_SIGN_IN,
  routeSignInCommand,
} from '../../../core/runners/route-auth.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { assertNever } from '../../../utils/type-guards.js';

/** The route's own sign-in fact: words only, and whether it reads as a dim state. */
export function formatRouteAuth(input: { auth: RouteAuthState }): {
  word: string | undefined;
  dim: boolean;
} {
  const { auth } = input;
  switch (auth.kind) {
    case 'unchecked':
      return { word: undefined, dim: false };
    case 'configured':
      return auth.source === 'listed'
        ? { word: 'available', dim: false }
        : {
            word: `signed in${SOFT_SEP}${credentialSourceWord(auth.source, auth.envVar)}`,
            dim: false,
          };
    case 'needs-sign-in':
      return { word: ROUTE_NEEDS_SIGN_IN, dim: true };
    case 'unknown':
      return auth.reason === 'empty'
        ? { word: ROUTE_NEEDS_SIGN_IN, dim: true }
        : { word: 'sign-in unknown', dim: true };
    default:
      return assertNever(auth);
  }
}

function credentialSourceWord(
  source: CliProviderAuthFact['source'],
  envVar: string | undefined,
): string {
  switch (source) {
    case 'oauth':
      return 'oauth';
    case 'api':
      return 'api key';
    case 'stored':
      return 'stored credential';
    case 'env':
      return envVar === undefined ? 'env' : `$${envVar}`;
    default:
      return assertNever(source);
  }
}

/**
 * The preview truncates right, so the command that fixes the route leads —
 * except a parse failure, where no command helps and saying so is the remedy.
 */
export function formatRouteRemedy(input: {
  auth: RouteAuthState;
  toolName: string;
  oracleCommand: string;
  versions: { observed: string; required: string } | undefined;
}): string | undefined {
  const { auth } = input;
  if (auth.kind === 'configured') return undefined;
  if (auth.kind === 'unchecked') {
    return `sign-in state is not readable for ${input.toolName}${SOFT_SEP}pick the route you have set up`;
  }
  const [binary = input.oracleCommand] = input.oracleCommand.split(' ');
  if (auth.kind === 'needs-sign-in') {
    return `sign in: ${routeSignInCommand(auth.tool, auth.provider)}${SOFT_SEP}then ctrl+r`;
  }
  switch (auth.reason) {
    case 'empty':
      return `signed in to no providers yet: ${routeSignInCommand(auth.tool, auth.provider)}${SOFT_SEP}then ctrl+r`;
    case 'catalog-not-read':
      return `ctrl+r to read the model list${SOFT_SEP}no credential listed for this provider`;
    case 'timeout':
      return `ctrl+r to re-check${SOFT_SEP}${binary} took too long listing providers`;
    case 'exit-failure':
      return `ctrl+r to re-check${SOFT_SEP}${input.oracleCommand} exited with an error`;
    case 'parse-failure':
      return 'Unreadable provider list. ctrl+r will not help; report the output';
    case 'version-mismatch': {
      const { versions } = input;
      const gap = versions === undefined ? '' : ` (${versions.observed} < ${versions.required})`;
      return `upgrade ${binary}${gap}${SOFT_SEP}sign-in state not read`;
    }
    case 'not-probed':
      return 'ctrl+r to check provider sign-in';
    default:
      return assertNever(auth);
  }
}
