import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
} from '@playwright/test/reporter';
import {readFileSync} from 'fs';
import {createContext, Watermarks} from 'istanbul-lib-report';
import {create, ReportType, ReportOptions} from 'istanbul-reports';
import path from 'path';

import {
  collectV8CoverageFiles,
  convertToIstanbulCoverage,
  getSourceMaps,
  loadAndMergeCoverages,
} from './data';

export class CoverageReporter implements Reporter {
  private readonly exclude: readonly string[];
  private readonly resultDir: string;
  private readonly reports: (
    | ReportType
    | [ReportType, ReportOptions[ReportType] | undefined]
  )[];
  private readonly sourceRoot?: string;
  private readonly watermarks?: Partial<Watermarks>;

  private config!: FullConfig;
  private suite!: Suite;

  constructor({
    exclude,
    sourceRoot,
    resultDir,
    reports = ['text-summary'],
    watermarks,
  }: {
    exclude?: string | string[];
    sourceRoot?: string;
    resultDir?: string;
    reports?: (
      | ReportType
      | [ReportType, ReportOptions[ReportType] | undefined]
    )[];
    watermarks?: Partial<Watermarks>;
  } = {}) {
    this.exclude = typeof exclude === 'string' ? [exclude] : exclude ?? [];
    this.resultDir = resultDir || 'coverage';
    this.reports = reports;
    this.sourceRoot = sourceRoot;
    this.watermarks = watermarks;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.config = config;
    this.suite = suite;
  }

  async onEnd(result: FullResult): Promise<void> {
    if (result.status !== 'passed' && result.status !== 'failed') {
      return;
    }

    const v8CoverageFiles = collectV8CoverageFiles(this.suite);

    const {totalCoverage: totalV8Coverage, sources} =
      await loadAndMergeCoverages(v8CoverageFiles);
    const sourceMaps = await getSourceMaps(sources);

    const sourceRoot = path.resolve(this.sourceRoot ?? this.config.rootDir);

    const istanbulCoverage = await convertToIstanbulCoverage(
      totalV8Coverage,
      sources,
      sourceMaps,
      this.exclude,
      sourceRoot,
    );

    const context = createContext({
      coverageMap: istanbulCoverage,
      dir: path.resolve(this.config.rootDir, this.resultDir),
      watermarks: this.watermarks,

      sourceFinder(file) {
        try {
          return readFileSync(path.resolve(sourceRoot, file), 'utf8');
        } catch (e) {
          throw new Error(`Failed to read ${file}: ${e}`);
        }
      },
    });

    for (const reporterConfig of this.reports) {
      let reporter;
      if (typeof reporterConfig === 'string') {
        reporter = create(reporterConfig);
      } else {
        reporter = create(...reporterConfig);
      }

      reporter.execute(context);
    }
  }
}
