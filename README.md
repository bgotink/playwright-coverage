# `@bgotink/playwright-coverage` [![Latest published version on NPM](https://img.shields.io/npm/v/@bgotink/playwright-coverage)](https://npm.im/@bgotink/playwright-coverage)

Report coverage on playwright tests using v8 coverage, without requiring any instrumentation.

## Usage

Install this package

```bash
yarn add -D @bgotink/playwright-coverage
```

Then add the reporter to your playwright configuration:

```ts
import {defineCoverageReporterConfig} from '@bgotink/playwright-coverage';
import {defineConfig} from '@playwright/test';

export default defineConfig({
  // ...

  reporter: [
    ['list'],
    [
      '@bgotink/playwright-coverage',
      defineCoverageReporterConfig({
        /* Path to the root files should be resolved from, most likely your repository root */
        sourceRoot: __dirname,
        /* Files to ignore in coverage, useful
           - if you're testing the demo app of a component library and want to exclude the demo sources
           - or part of the code is generated
           - or if you're running into any of the other many reasons people have for excluding files */
        exclude: ['path/to/ignored/code/**'],
        /* Directory in which to write coverage reports */
        resultDir: path.join(__dirname, 'results/e2e-coverage'),
        /* Configure the reports to generate.
           The value is an array of istanbul reports, with optional configuration attached. */
        reports: [
          /* Create an HTML view at <resultDir>/index.html */
          ['html'],
          /* Create <resultDir>/coverage.lcov for consumption by tooling */
          [
            'lcovonly',
            {
              file: 'coverage.lcov',
            },
          ],
          /* Log a coverage summary at the end of the test run */
          [
            'text-summary',
            {
              file: null,
            },
          ],
        ],
        /* Configure watermarks, see https://github.com/istanbuljs/nyc#high-and-low-watermarks */
        // watermarks: {},
      }),
    ],
  ],
});
```

Now replace all calls to `@playwright/test`'s `test` variable with a variant that tracks coverage.
The easiest way to do this is by importing `test` from `@bgotink/playwright-coverage` instead.

```diff
-import {expect, test} from '@playwright/test';
+import {expect, test} from '@bgotink/playwright-coverage';
```

If you're already using a different `test` function, e.g. if you're using [`@ngx-playwright/test`](https://github.com/bgotink/ngx-playwright), you can add coverage tracking using the `mixinFixtures` function:

```ts
import {test as base} from '@ngx-playwright/test'; // or wherever your test function comes from
import {mixinFixtures as mixinCoverage} from '@bgotink/playwright-coverage';

export const test = mixinCoverage(base);
```

or you can use `mergeTests` if you're using playwright ≥ 1.40.0:

```ts
import {mergeTests} from '@playwright/test';
import {test as testWithCoverage} from '@bgotink/playwright/coverage';
import {test as otherTest} from '@ngx-playwright/test'; // or wherever your test function comes from

export const test = mergeTests(
  testWithCoverage,
  otherTest,
);
```

Now replace all usage of `test` with the function export defined there, and coverage will be tracked.

## How does it work?

The fixtures registered in `test` or via `mixinFixtures` hook into created [`Page`s](https://playwright.dev/docs/api/class-page) to track javascript coverage with v8. The coverage data is added as attachment to every test.

Upon completion of all tests, the reporter merges all generated coverage files into one and then converts the v8 coverage format into the coverage format used by istanbul. The istanbul data is then passed into the reports of `istanbul-reports`.

## Common issues

**The HTML report shows errors saying the source files couldn't be read**

This means the reporter is looking in the wrong place because playwright and the server process are using paths relative to a different working folder.

Try setting the `sourceRoot` folder. If you need more control over the actual path of the files, pass a `rewritePath` property in the options:

```ts
{
  sourceRoot: __dirname,

  /**
   * Modify the paths of files on which coverage is reported
   *
   * The input is an object with two properties:
   * - absolutePath
   * - relativePath
   * both are strings and they represent the absoslute and relative
   * path of the file as computed based on the source map.
   *
   * Return the rewritten path. If nothing is returned, `absolutePath`
   * is used instead.
   */
  rewritePath: ({absolutePath, relativePath}) => {
    return absolutePath;
  },
}
```

**Coverage is empty**

Did you perhaps use `@playwright/test`'s own `test` function?
If you don't use a `test` function created using `mixinCoverage`, coverage won't be tracked and the reporter won't have anything to report on.

## Status

This project is very experimental. It has been proven to work on one angular application, i.e. with webpack with the unmodified configuration angular applies to it.

## License

Licensed under the MIT license, see `LICENSE.md`.
