import { configError } from '../errors.js';
import {
  ImplementerConfigSchema,
  ImplementerProfileConfigSchema,
  defaultImplementerWriteMode,
} from '../../schemas/implementer-config.js';
import { isAutoCheapestModel } from '../../providers/automatic-model.js';
import type { Config } from '../../schemas/config.js';
import type {
  ImplementerCapabilities,
  ImplementerConfig,
  ImplementerCostTier,
  ImplementerProfileConfig,
  ImplementerProfilesConfig,
  ImplementerWriteMode,
} from '../../schemas/implementer-config.js';

export function pickDefaultProfileName(
  profileConfig: ImplementerProfilesConfig,
): string | undefined {
  return profileConfig.default ?? Object.keys(profileConfig.profiles).sort()[0];
}

export interface ResolvedImplementerCapabilities {
  writesFiles: ImplementerWriteMode;
}

export interface ResolvedImplementerProfile {
  name: string;
  label?: string | undefined;
  costTier: ImplementerCostTier;
  capabilities: ResolvedImplementerCapabilities;
  config: ImplementerConfig;
  isDefault: boolean;
  pricePer1M?: number | undefined;
}

export interface ResolvedImplementerProfiles {
  defaultProfile: ResolvedImplementerProfile;
  profiles: ResolvedImplementerProfile[];
}

/** Output tokens dominate an implementation call, so the blended rank weights them. */
const BLENDED_OUTPUT_WEIGHT = 4;

/**
 * The scalar every auto-route ranking sorts on, and the figure the derived
 * profile publishes as `pricePer1M`: one formula, so the candidate ranking and
 * the profile table can never disagree about which row is cheapest.
 */
export function blendedPricePer1M(pricingInput: number, pricingOutput: number): number {
  return pricingInput + BLENDED_OUTPUT_WEIGHT * pricingOutput;
}

export interface AutoRouteCandidateRow {
  readonly config: ImplementerConfig;
  readonly pricingInput?: number | undefined;
  readonly pricingOutput?: number | undefined;
}

export function stripProfileMetadata(profile: ImplementerProfileConfig): ImplementerConfig {
  const {
    label: _label,
    costTier: _costTier,
    capabilities: _capabilities,
    pricePer1M: _pricePer1M,
    ...config
  } = profile;
  return ImplementerConfigSchema.parse(config);
}

function resolveProfileCapabilities(
  config: ImplementerConfig,
  metadata?: ImplementerCapabilities | undefined,
): ResolvedImplementerCapabilities {
  return {
    writesFiles: metadata?.writesFiles ?? defaultImplementerWriteMode(config.kind),
  };
}

function singleImplementerProfile(config: Config): ResolvedImplementerProfiles {
  const defaultProfile: ResolvedImplementerProfile = {
    name: 'default',
    label: 'Default implementer',
    costTier: 'unknown',
    capabilities: resolveProfileCapabilities(config.implementer),
    config: config.implementer,
    isDefault: true,
  };
  return { defaultProfile, profiles: [defaultProfile] };
}

function autoRouteProfileName(config: ImplementerConfig): string {
  const seatWord =
    config.kind === 'cli' ? config.tool : config.kind === 'api' ? config.provider : config.kind;
  return `auto-${seatWord}-${config.model}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function deriveProfilesFromCandidates(
  candidates: readonly AutoRouteCandidateRow[],
): ResolvedImplementerProfile[] | null {
  const priced = candidates.flatMap((row) => {
    if (row.config.kind !== 'cli' && row.config.kind !== 'api') return [];
    if (
      row.pricingInput === undefined ||
      !Number.isFinite(row.pricingInput) ||
      row.pricingInput < 0 ||
      row.pricingOutput === undefined ||
      !Number.isFinite(row.pricingOutput) ||
      row.pricingOutput < 0
    ) {
      return [];
    }
    return [
      {
        config: row.config,
        seatWord: row.config.kind === 'cli' ? row.config.tool : row.config.provider,
        name: autoRouteProfileName(row.config),
        blended: blendedPricePer1M(row.pricingInput, row.pricingOutput),
      },
    ];
  });
  if (priced.length === 0) return null;

  const ranked = priced.sort(
    (left, right) => left.blended - right.blended || left.name.localeCompare(right.name),
  );

  const usedNames = new Set<string>();
  const profiles: ResolvedImplementerProfile[] = ranked.map((candidate, index) => {
    let name = candidate.name;
    for (let suffix = 2; usedNames.has(name); suffix += 1) {
      const tail = `-${suffix}`;
      name = `${candidate.name.slice(0, 64 - tail.length)}${tail}`;
    }
    usedNames.add(name);
    return {
      name,
      label: `${candidate.seatWord} · ${candidate.config.model} · $${candidate.blended.toFixed(2)}/1M`,
      costTier: 'unknown',
      capabilities: resolveProfileCapabilities(candidate.config),
      config: candidate.config,
      isDefault: index === 0,
      pricePer1M: candidate.blended,
    };
  });
  return profiles;
}

function deriveAutoCheapestProfiles(
  config: Config,
  candidates: readonly AutoRouteCandidateRow[],
): ResolvedImplementerProfiles | null {
  if (!isAutoCheapestModel(config.implementer.model)) return null;
  const profiles = deriveProfilesFromCandidates(candidates);
  if (profiles === null) return null;
  const [defaultProfile] = profiles;
  if (defaultProfile === undefined) return null;
  return { defaultProfile, profiles };
}

/**
 * `auto:cheapest` names a policy, not a model, and the seat alone cannot be
 * routed: runner admission, the implementer factory, the router and the cost
 * estimate all read the profile table out of the config and nothing else. So the
 * derived rows are written into that table once, at the preparation boundary,
 * and every reader downstream sees the same routable set. The marker stays on
 * the seat, so every identity surface keeps spelling the policy; a config that
 * already declares its own profiles is left untouched.
 */
export function withAutoRouteProfiles(
  config: Config,
  candidates: readonly AutoRouteCandidateRow[],
): Config {
  if (config.implementerProfiles !== undefined) return config;
  const derived = deriveAutoCheapestProfiles(config, candidates);
  if (derived === null) return config;

  const profiles: Record<string, ImplementerProfileConfig> = {};
  let cheapestName: string | undefined;
  for (const profile of derived.profiles) {
    const parsed = ImplementerProfileConfigSchema.safeParse({
      ...profile.config,
      ...(profile.label === undefined ? {} : { label: profile.label }),
      ...(profile.pricePer1M === undefined ? {} : { pricePer1M: profile.pricePer1M }),
    });
    if (!parsed.success) continue;
    profiles[profile.name] = parsed.data;
    cheapestName ??= profile.name;
  }
  if (cheapestName === undefined) return config;

  return { ...config, implementerProfiles: { default: cheapestName, profiles } };
}

/**
 * Drops named profiles from the table and re-points `default` at the cheapest
 * row that survives — a derived table is written in rank order, so the first
 * surviving key is that row. A table that would lose every profile is returned
 * untouched: the caller decides what a seat with no usable row means.
 */
export function withoutImplementerProfiles(config: Config, names: ReadonlySet<string>): Config {
  const table = config.implementerProfiles;
  if (table === undefined || names.size === 0) return config;
  const kept = Object.entries(table.profiles).filter(([name]) => !names.has(name));
  const [survivor] = kept;
  if (survivor === undefined || kept.length === Object.keys(table.profiles).length) return config;
  const [survivorName] = survivor;
  const defaultName =
    table.default !== undefined && !names.has(table.default) ? table.default : survivorName;
  return {
    ...config,
    implementerProfiles: { default: defaultName, profiles: Object.fromEntries(kept) },
  };
}

export function resolveImplementerProfiles(config: Config): ResolvedImplementerProfiles {
  const profileConfig = config.implementerProfiles;
  if (!profileConfig) return singleImplementerProfile(config);

  const defaultName = pickDefaultProfileName(profileConfig);
  if (!defaultName) return singleImplementerProfile(config);

  const profiles = Object.entries(profileConfig.profiles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, profile]) => {
      const profileConfig = stripProfileMetadata(profile);
      return {
        name,
        label: profile.label,
        costTier: profile.costTier ?? 'unknown',
        capabilities: resolveProfileCapabilities(profileConfig, profile.capabilities),
        config: profileConfig,
        isDefault: name === defaultName,
        ...(profile.pricePer1M === undefined ? {} : { pricePer1M: profile.pricePer1M }),
      };
    });

  const defaultProfile = profiles.find((profile) => profile.isDefault);
  if (!defaultProfile) {
    throw configError.profileNotFound(defaultName);
  }

  return { defaultProfile, profiles };
}

export function mergeImplementerProfileMetadata(
  existing: ImplementerProfileConfig,
  updated: ImplementerConfig,
): ImplementerProfileConfig {
  return ImplementerProfileConfigSchema.parse({
    ...updated,
    ...(existing.label !== undefined && { label: existing.label }),
    ...(existing.costTier !== undefined && { costTier: existing.costTier }),
    ...(existing.pricePer1M !== undefined && { pricePer1M: existing.pricePer1M }),
    ...(existing.capabilities !== undefined &&
      existing.kind === updated.kind && { capabilities: existing.capabilities }),
  });
}

export function updateDefaultImplementerConfig(
  config: Config,
  updater: (existing: ImplementerConfig) => ImplementerConfig,
): Config {
  const profiles = config.implementerProfiles;
  if (!profiles) {
    return { ...config, implementer: updater(config.implementer) };
  }

  const defaultName = pickDefaultProfileName(profiles);
  const defaultProfile = defaultName === undefined ? undefined : profiles.profiles[defaultName];
  if (defaultName === undefined || defaultProfile === undefined) {
    return { ...config, implementer: updater(config.implementer) };
  }

  const existing = stripProfileMetadata(defaultProfile);
  const updated = updater(existing);
  return {
    ...config,
    implementer: updated,
    implementerProfiles: {
      ...profiles,
      profiles: {
        ...profiles.profiles,
        [defaultName]: mergeImplementerProfileMetadata(defaultProfile, updated),
      },
    },
  };
}
