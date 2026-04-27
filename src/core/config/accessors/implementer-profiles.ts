import { ImplementerConfigSchema, defaultImplementerWriteMode } from '../../schemas/implementer-config.js';
import type { Config } from '../../schemas/config.js';
import type { ImplementerCapabilities, ImplementerConfig, ImplementerCostTier, ImplementerProfileConfig, ImplementerWriteMode } from '../../schemas/implementer-config.js';

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
}

export interface ResolvedImplementerProfiles {
  defaultProfile: ResolvedImplementerProfile;
  profiles: ResolvedImplementerProfile[];
}

function stripProfileMetadata(profile: ImplementerProfileConfig): ImplementerConfig {
  const { label: _label, costTier: _costTier, capabilities: _capabilities, ...config } = profile;
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

export function resolveImplementerProfiles(config: Config): ResolvedImplementerProfiles {
  const profileConfig = config.implementerProfiles;
  if (!profileConfig) return singleImplementerProfile(config);

  const defaultName = profileConfig.default ?? Object.keys(profileConfig.profiles).sort()[0];
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
      };
    });

  const defaultProfile = profiles.find(profile => profile.isDefault);
  if (!defaultProfile) {
    throw new Error(`Default implementer profile "${defaultName}" is not defined`);
  }

  return { defaultProfile, profiles };
}
