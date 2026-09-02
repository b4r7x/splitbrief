import { describe, expect, it } from 'vitest';
import {
  deriveModelCatalogCapability,
  type ModelCatalogCapability,
  type PickerModelPolicy,
} from './posture.js';

describe('model policy capability', () => {
  const cases: Array<{
    policy: PickerModelPolicy;
    automatic: boolean;
    capability: ModelCatalogCapability;
  }> = [
    {
      policy: 'required',
      automatic: true,
      capability: {
        policy: 'required',
        requiresModel: true,
        allowsOmit: false,
        allowsCustom: true,
        showsDiscovered: true,
        allowsAutomatic: false,
      },
    },
    {
      policy: 'optional',
      automatic: true,
      capability: {
        policy: 'optional',
        requiresModel: false,
        allowsOmit: true,
        allowsCustom: true,
        showsDiscovered: true,
        allowsAutomatic: true,
      },
    },
    {
      policy: 'backend-default',
      automatic: true,
      capability: {
        policy: 'backend-default',
        requiresModel: false,
        allowsOmit: true,
        allowsCustom: false,
        showsDiscovered: false,
        allowsAutomatic: true,
      },
    },
    {
      policy: 'auto-only',
      automatic: true,
      capability: {
        policy: 'auto-only',
        requiresModel: false,
        allowsOmit: true,
        allowsCustom: false,
        showsDiscovered: false,
        allowsAutomatic: true,
      },
    },
    {
      policy: 'per-call',
      automatic: true,
      capability: {
        policy: 'per-call',
        requiresModel: true,
        allowsOmit: false,
        allowsCustom: true,
        showsDiscovered: true,
        allowsAutomatic: true,
      },
    },
    {
      policy: 'none',
      automatic: true,
      capability: {
        policy: 'none',
        requiresModel: false,
        allowsOmit: true,
        allowsCustom: false,
        showsDiscovered: false,
        allowsAutomatic: false,
      },
    },
  ];

  it.each(cases)('derives canonical actions for $policy', ({ policy, automatic, capability }) => {
    expect(deriveModelCatalogCapability(policy, automatic)).toEqual(capability);
  });

  it.each(cases)('defaults $policy to no automatic row', ({ policy, capability }) => {
    expect(deriveModelCatalogCapability(policy)).toEqual({ ...capability, allowsAutomatic: false });
  });
});
