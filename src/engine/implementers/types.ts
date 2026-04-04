import type { PricingInfo } from '../pricing.js';
import type { ImplementerOptions, RetryOptions } from './base.js';
import type { ImplementerResult } from '../../types.js';

export interface ImplementerBackend {
  readonly name: string;
  implement(opts: ImplementerOptions): Promise<ImplementerResult>;
  retry(opts: RetryOptions): Promise<ImplementerResult>;
  isAvailable(): Promise<boolean>;
  getPricing(): PricingInfo;
}
