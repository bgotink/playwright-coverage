import type {ProcessCov} from '@bcoe/v8-coverage';
import type {EncodedSourceMap} from '@jridgewell/trace-mapping';
import {promises as fs} from 'fs';
import {createCoverageMap} from 'istanbul-lib-coverage';
import {isMatch} from 'micromatch';
import {join, posix} from 'path';
import {pathToFileURL, URL} from 'url';
import v8ToIstanbul from 'v8-to-istanbul';
import * as convertSourceMap from 'convert-source-map';

export const attachmentName = '@bgotink/playwright-coverage';

const fetch = import('node-fetch');

export async function getSourceMap(
  url: string,
  source: string,
): Promise<EncodedSourceMap | undefined> {
  const inlineMap = convertSourceMap.fromSource(source);
  if (inlineMap != null) {
    return inlineMap.sourcemap;
  }

  try {
    const linkedMap = await convertSourceMap.fromMapFileSource(
      source,
      async (file: string): Promise<string> => {
        const resolved = new URL(file, url);

        switch (resolved.protocol) {
          case 'file:':
            return await fs.readFile(resolved, 'utf8');
          case 'data:': {
            const comma = resolved.pathname.indexOf(',');
            const rawData = resolved.pathname.slice(comma + 1);
            const between = resolved.pathname
              .slice('application/json;'.length, comma)
              .split(';');

            const dataString = between.includes('base64')
              ? Buffer.from(rawData, 'base64url').toString('utf8')
              : rawData;

            return dataString;
          }
          default: {
            const response = await (
              await fetch
            ).default(resolved.href, {
              method: 'GET',
            });

            return await response.text();
          }
        }
      },
    );

    if (linkedMap != null) {
      return linkedMap.sourcemap;
    }
  } catch {
    return null!;
  }

  // No source map comments, try to find an implicit sourcemap at `${url}.map`
  try {
    const response = await (
      await fetch
    ).default(`${url}.map`, {
      method: 'GET',
    });

    return (await response.json()) as EncodedSourceMap;
  } catch {
    return undefined;
  }
}

export async function getSourceMaps(
  sources: ReadonlyMap<string, string>,
): Promise<ReadonlyMap<string, EncodedSourceMap | undefined>> {
  return new Map<string, EncodedSourceMap | undefined>(
    await Promise.all(
      Array.from(
        sources,
        async ([url, source]) =>
          [url, await getSourceMap(url, source)] as const,
      ),
    ),
  );
}

export async function convertToIstanbulCoverage(
  v8Coverage: ProcessCov,
  sources: ReadonlyMap<string, string>,
  sourceMaps: ReadonlyMap<string, EncodedSourceMap | undefined>,
  exclude: readonly string[],
  sourceRoot: string,
) {
  const istanbulCoverage = createCoverageMap({});

  for (const script of v8Coverage.result) {
    const source = sources.get(script.url);
    const sourceMap = sourceMaps.get(script.url);

    if (source == null || !sourceMap?.mappings) {
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
      if (url.protocol.startsWith('webpack')) {
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
      // This path is used to resolve files, but the filename doesn't matter
      join(sourceRoot, 'unused.js'),
      0,
      sourceMap?.mappings
        ? {
            source,
            sourceMap: {sourcemap: sourceMap},
          }
        : {
            source: convertSourceMap.removeMapFileComments(
              convertSourceMap.removeComments(source),
            ),
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
          path.includes('/webpack:/webpack/') ||
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

    try {
      await convertor.load();
    } catch (error) {
      continue;
    }

    convertor.applyCoverage(script.functions);

    istanbulCoverage.merge(
      Object.fromEntries(
        Array.from(
          Object.entries(convertor.toIstanbul()),
          ([path, coverage]) => {
            path = sanitizePath(path);
            return [
              path,
              {
                ...coverage,
                path,
              },
            ] as const;
          },
        ),
      ),
    );
  }

  return istanbulCoverage;
}
