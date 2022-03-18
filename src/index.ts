import {test as base} from '@playwright/test';

import {mixinFixtures} from './fixtures';

export const test = mixinFixtures(base);

export {expect} from '@playwright/test';
export {PlaywrightCoverageOptions, mixinFixtures} from './fixtures';
export {
  CoverageReporter,
  CoverageReporter as default,
  CoverageReporterOptions,
} from './reporter';
