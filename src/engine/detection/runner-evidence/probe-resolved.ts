import type { CliExecutableIdentity } from '../../../core/discovery/detection/executable.js';
import type { DetectedModel } from '../../../core/discovery/detection/model.js';
import type { RunnerEvidence, ProbeOutcome } from '../../../core/discovery/runner-evidence.js';
import {
  CLI_TOOL_CATALOG,
  signInOutranksUnreadVersion,
} from '../../../core/runners/cli-tool/catalog.js';
import { classifyCliAdmittedVersion } from '../../../core/runners/cli-tool/version.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { isDeclaredCliProbeContract } from '../../runners/cli-tools/probe/contract.js';
import { probeCliReadiness } from '../../runners/cli-tools/probe/readiness.js';
import {
  type AuthProbeRun,
  probeDeclaredCliReadinessEvidence,
} from '../../runners/cli-tools/probe/declared-readiness.js';
import {
  lookupCliReadinessProbe,
  isCanonicalCliDeclaredProbe,
} from '../../runners/cli-tools/registry.js';
import { probeContextCatalog } from '../catalog-probe/probe.js';
import type { CliRunnerDiscoveryContext } from '../cli-context.js';
import {
  evidenceFromLegacyReadiness,
  runnerEvidenceBase,
  credentialFromCliAuth,
  executableFactFromResolved,
  compatibilityFromVersion,
  modelRunFromCatalog,
} from './facts.js';
import { unsupportedCatalogEvidence, probeFailureEvidence } from './outcomes.js';
import type { DetectRunnerEvidenceOptions, ProbeDeclaredCliReadinessEvidence } from './types.js';

/**
 * The probe work behind one resolved executable: version, auth and — only when
 * asked — the catalog. Each call owns its cancellation boundary.
 */
export async function probeResolvedCliEvidence(
  options: DetectRunnerEvidenceOptions,
  input: Readonly<{
    context: CliRunnerDiscoveryContext;
    observedAt: number;
    executable: CliExecutableIdentity;
    signal: AbortSignal | undefined;
  }>,
): Promise<RunnerEvidence> {
  const { context, observedAt, executable, signal } = input;
  const now = options.now ?? Date.now;
  const catalogRequested = options.includeCatalog === true;

  const probe = (
    catalogRequested ? lookupCliReadinessProbe : (options.lookupProbe ?? lookupCliReadinessProbe)
  )({
    tool: context.id,
    role: context.role,
  });
  if (
    catalogRequested &&
    (!isDeclaredCliProbeContract(probe) ||
      !isCanonicalCliDeclaredProbe({
        tool: context.id,
        role: context.role,
        probe: probe.declared,
      }))
  ) {
    return unsupportedCatalogEvidence(context, observedAt, executable);
  }
  if (!isDeclaredCliProbeContract(probe)) {
    try {
      const readiness = await probeCliReadiness({
        tool: context.id,
        executable,
        probe,
        ...(signal !== undefined ? { signal } : {}),
        now: () => observedAt,
        classifyVersion: ({ installedVersion }) =>
          classifyCliAdmittedVersion({
            installedVersion,
            minimumAdmittedVersion:
              CLI_TOOL_CATALOG[context.id].compatibility.minimumAdmittedVersion,
            versionScheme: CLI_TOOL_CATALOG[context.id].compatibility.versionScheme,
          }),
      });
      return evidenceFromLegacyReadiness(context, observedAt, readiness);
    } catch {
      throwIfAborted(signal);
      return probeFailureEvidence(context, observedAt, executable);
    }
  }

  let authProbeRun: AuthProbeRun | undefined;
  const declaredProbeOptions = {
    tool: context.id,
    executable,
    probe: probe.declared,
    ...(signal !== undefined ? { signal } : {}),
    versionProbes: options.versionProbes,
    // A tool whose auth oracle is its model listing (`agy models`) is spawned once per pass.
    ...(catalogRequested
      ? {
          onAuthProbeRun: (run: AuthProbeRun) => {
            authProbeRun = run;
          },
        }
      : {}),
  };
  const declaredReadiness = catalogRequested
    ? probeDeclaredCliReadinessEvidence
    : (options.probeDeclaredReadiness ?? probeDeclaredCliReadinessEvidence);
  let declaredEvidence: Awaited<ReturnType<ProbeDeclaredCliReadinessEvidence>>;
  try {
    declaredEvidence = await declaredReadiness(declaredProbeOptions);
  } catch {
    throwIfAborted(signal);
    return probeFailureEvidence(context, observedAt, executable);
  }

  if (declaredEvidence.version.kind === 'cancelled' || declaredEvidence.auth === 'cancelled') {
    const base = runnerEvidenceBase(context, observedAt);
    return {
      ...base,
      installation: 'installed',
      executable: { kind: 'identity-drifted' },
      compatibility: {
        kind: 'unknown',
        installedVersion: null,
        testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
      },
      credential: credentialFromCliAuth(context, declaredEvidence.auth),
      auth: declaredEvidence.auth,
    };
  }

  const executableFact = executableFactFromResolved(executable);
  const compatibility = compatibilityFromVersion({
    version: declaredEvidence.version,
    compatibility: CLI_TOOL_CATALOG[context.id].compatibility,
  });
  const credential = credentialFromCliAuth(context, declaredEvidence.auth);
  let catalog: ProbeOutcome<readonly DetectedModel[]>;
  if (!catalogRequested) {
    catalog = { kind: 'not-run' };
  } else if (executableFact.kind !== 'trusted') {
    catalog = { kind: 'unsupported' };
  } else if (
    signInOutranksUnreadVersion({
      tool: context.id,
      installedVersion:
        declaredEvidence.version.kind === 'success' ? declaredEvidence.version.value : null,
      signedOut: credential === 'absent',
    })
  ) {
    catalog = { kind: 'missing-credential' };
  } else if (declaredEvidence.version.kind === 'timeout') {
    catalog = { kind: 'timeout' };
  } else if (compatibility.kind !== 'compatible') {
    catalog = { kind: 'not-run' };
  } else {
    try {
      catalog = await probeContextCatalog({
        context,
        executable,
        probe: probe.declared,
        version: declaredEvidence.version,
        refresh: options.catalogRefresh ?? 'automatic',
        projectDir: options.projectDir ?? process.cwd(),
        namesProject: options.catalogNamesProject === true,
        now,
        signal,
        authProbeRun,
      });
    } catch {
      throwIfAborted(signal);
      return probeFailureEvidence(context, observedAt, executable);
    }
  }
  const base = runnerEvidenceBase(context, observedAt);
  return {
    ...base,
    installation: 'installed',
    executable: executableFact,
    compatibility,
    credential,
    auth: declaredEvidence.auth,
    catalog,
    modelRun: modelRunFromCatalog(context, base, catalog),
    ...(declaredEvidence.providerAuth !== undefined && {
      providerAuth: declaredEvidence.providerAuth,
    }),
  };
}
