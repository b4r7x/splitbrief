import { configError } from '../errors.js';
import {
  ImplementerConfigSchema,
  ImplementerProfileConfigSchema,
  defaultImplementerWriteMode,
} from '../../schemas/implementer-config.js';
import type { Config } from '../../schemas/config.js';
import type {
  ImplementerCapabilities,
  ImplementerConfig,
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
  capabilities: ResolvedImplementerCapabilities;
  config: ImplementerConfig;
  isDefault: boolean;
}

export interface ResolvedImplementerProfiles {
  defaultProfile: ResolvedImplementerProfile;
  profiles: ResolvedImplementerProfile[];
}

export function stripProfileMetadata(profile: ImplementerProfileConfig): ImplementerConfig {
  const { label: _label, capabilities: _capabilities, ...config } = profile;
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
    capabilities: resolveProfileCapabilities(config.implementer),
    config: config.implementer,
    isDefault: true,
  };
  return { defaultProfile, profiles: [defaultProfile] };
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
        capabilities: resolveProfileCapabilities(profileConfig, profile.capabilities),
        config: profileConfig,
        isDefault: name === defaultName,
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

/**
 * Updates one named profile of the table; the `implementer` mirror follows only
 * when that profile is the default. A config without a profile table has only
 * the single implementer, which is updated whatever the name. `null` when the
 * table has no profile of that name.
 */
export function updateNamedImplementerConfig(
  config: Config,
  profileName: string,
  updater: (existing: ImplementerConfig) => ImplementerConfig,
): Config | null {
  const profiles = config.implementerProfiles;
  const defaultName = profiles === undefined ? undefined : pickDefaultProfileName(profiles);
  if (profiles === undefined || defaultName === undefined) {
    return { ...config, implementer: updater(config.implementer) };
  }

  const profile = Object.hasOwn(profiles.profiles, profileName)
    ? profiles.profiles[profileName]
    : undefined;
  if (profile === undefined) return null;

  const updated = updater(stripProfileMetadata(profile));
  return {
    ...config,
    ...(profileName === defaultName && { implementer: updated }),
    implementerProfiles: {
      ...profiles,
      profiles: {
        ...profiles.profiles,
        [profileName]: mergeImplementerProfileMetadata(profile, updated),
      },
    },
  };
}
