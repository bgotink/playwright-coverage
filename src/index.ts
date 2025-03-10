import {test as base} from '@playwright/test';

import {mixinFixtures} from './fixtures';
import type { CoverageReporterOptions } from './reporter';

export const test = mixinFixtures(base);

export {expect} from '@playwright/test';
export {type PlaywrightCoverageOptions, mixinFixtures} from './fixtures';
export {
  CoverageReporter,
  CoverageReporter as default,
  type CoverageReporterOptions,
} from './reporter';

export function defineCoverageReporterConfig(config: CoverageReporterOptions): CoverageReporterOptions {
  return config;
}
