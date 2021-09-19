import {mergeProcessCovs, ProcessCov, ScriptCov} from '@bcoe/v8-coverage';
import type {Suite, TestResult} from '@playwright/test/reporter';
import {promises as fs} from 'fs';
import {createCoverageMap} from 'istanbul-lib-coverage';
import {isMatch} from 'micromatch';
import fetch from 'node-fetch';
import {posix} from 'path';
import type {RawSourceMap} from 'source-map';
import {fileURLToPath, pathToFileURL, URL} from 'url';
import v8ToIstanbul from 'v8-to-istanbul';

export const attachmentName = '@bgotink/playwright-coverage';

export function collectV8CoverageFiles(suite: Suite) {
  const files = new Set<string>();

  for (const test of suite.allTests()) {
    for (const result of test.results) {
      const attachmentIndex = result.attachments.findIndex(
        ({name}) => name === attachmentName,
      );

      if (attachmentIndex === -1) {
        continue;
      }

      const [attachment] = result.attachments.splice(attachmentIndex, 1) as [
        TestResult['attachments'][number],
      ];

      if (attachment.path != null) {
        files.add(attachment.path);
      }
    }
  }

  return files;
}

function isProcessCov(obj: unknown): obj is ProcessCov {
  return (
    typeof obj === 'object' &&
    obj != null &&
    Array.isArray((obj as ProcessCov).result)
  );
}

export async function loadAndMergeCoverages(files: Iterable<string>) {
  let totalCoverage: ProcessCov = {result: []};
  const sources = new Map<string, string>();

  for (const file of files) {
    const coverage: unknown = JSON.parse(await fs.readFile(file, 'utf-8'));

    if (!isProcessCov(coverage)) {
      continue;
    }

    for (const script of coverage.result as (ScriptCov & {source?: string})[]) {
      if (typeof script.source === 'string') {
        sources.set(script.url, script.source);
        delete script.source;
      }
    }

    totalCoverage = mergeProcessCovs([totalCoverage, coverage]);
  }

  return {totalCoverage, sources};
}

export async function getSourceMaps(
  sources: ReadonlyMap<string, string>,
): Promise<ReadonlyMap<string, RawSourceMap | undefined>> {
  return new Map<string, RawSourceMap | undefined>(
    await Promise.all(
      Array.from(sources, async ([url, source]) => {
        const match = source.match(/\/\/# *sourceMappingURL=(.*)$/);

        if (match == null) {
          return [url, undefined] as const;
        }

        const resolved = new URL(match[1]!, url);

        if (resolved.protocol === 'file:') {
          return [
            url,
            JSON.parse(await fs.readFile(fileURLToPath(resolved), 'utf8')),
          ] as const;
        } else {
          const response = await fetch(resolved.href, {
            method: 'GET',
          });

          return [url, await response.json()] as const;
        }
      }),
    ),
  );
}

export async function convertToIstanbulCoverage(
  v8Coverage: ProcessCov,
  sources: ReadonlyMap<string, string>,
  sourceMaps: ReadonlyMap<string, RawSourceMap | undefined>,
  exclude: readonly string[],
  sourceRoot: string,
) {
  const istanbulCoverage = createCoverageMap({});

  for (const script of v8Coverage.result) {
    const source = sources.get(script.url);
    const sourceMap = sourceMaps.get(script.url);

    if (source == null || sourceMap == null) {
      continue;
    }

    function sanitizePath(path: string) {
      let url;

      try {
        url = new URL(path);
      } catch {
        url = pathToFileURL(path);
      }

      let relativePath;
      if (url.protocol === 'webpack:') {
        relativePath = url.pathname.slice(1); // webpack: URLs contain relative paths
      } else {
        relativePath = url.pathname;
      }

      if (relativePath.includes('/webpack:/')) {
        // v8ToIstanbul breaks when the source root in the source map is set to webpack:
        // It treats the URL as a path, leading to a confusing result.
        relativePath = relativePath.slice(
          relativePath.indexOf('/webpack:/') + '/webpack:/'.length,
        );
      } else if (posix.isAbsolute(relativePath)) {
        relativePath = posix.relative(pathToFileURL(sourceRoot).pathname, path);
      }

      return relativePath;
    }

    const isExcludedCache = new Map<string, boolean>();
    const convertor = v8ToIstanbul(
      '',
      0,
      {
        source,
        sourceMap: {sourcemap: sourceMap},
      },
      path => {
        let isExcluded = isExcludedCache.get(path);

        if (isExcluded != null) {
          return isExcluded;
        }

        const relativePath = sanitizePath(path);

        isExcluded =
          // ignore files outside of the root
          relativePath.startsWith('../') ||
          // ignore webpack files
          relativePath === 'webpack/bootstrap' ||
          relativePath.startsWith('webpack/runtime/') ||
          // ignore dependencies
          relativePath.startsWith('node_modules/') ||
          relativePath.includes('/node_modules/') ||
          // apply exclusions
          isMatch(relativePath, exclude);
        isExcludedCache.set(path, isExcluded);

        return isExcluded;
      },
    );

    await convertor.load();

    convertor.applyCoverage(script.functions);

    istanbulCoverage.merge(
      Object.fromEntries(
        Array.from(
          Object.entries(convertor.toIstanbul()),
          ([path, coverage]) => {
            return [
              sanitizePath(path),
              {
                ...coverage,
                path: sanitizePath(path),
              },
            ] as const;
          },
        ),
      ),
    );
  }

  return istanbulCoverage;
}
