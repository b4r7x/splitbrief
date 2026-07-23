import type { Config } from '../../../schemas/config.js';

export interface ConfigError {
  path: string;
  message: string;
}

export interface ConfigValidation {
  errors: ConfigError[];
  warnings: string[];
  data?: Config | undefined;
}
