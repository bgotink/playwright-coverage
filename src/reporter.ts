import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
  TestStep,
} from '@playwright/test/reporter';
import {Remote, wrap} from 'comlink';
import nodeEndpoint from 'comlink/dist/umd/node-adapter';
import {readFileSync} from 'fs';
import {CoverageMapData, createCoverageMap} from 'istanbul-lib-coverage';
import {createContext, Watermarks} from 'istanbul-lib-report';
import {create, ReportType, ReportOptions} from 'istanbul-reports';
import path from 'path';
import {Worker} from 'worker_threads';

import {attachmentName} from './data.js';
import type {CoverageWorker} from './worker.js';

/**
 * Options to the coverage repoter
 */
export interface CoverageReporterOptions {
  /**
   * Glob(s) defining file(s) to exclude from coverage tracking
   */
  exclude?: string | string[];

  /**
   * Root folder for resolving source files, defaults to playwright's `rootDir`
   */
  sourceRoot?: string;

  /**
   * Folder to write coverage reports to
   *
   * Relative paths are resolved to playwright's `rootDir`. Default value is `'coverage'`.
   */
  resultDir?: string;

  /**
   * Istanbul reports to generate, defaults to generate a `'text-summary'`
   */
  reports?: (
    | ReportType
    | [ReportType, (ReportOptions[ReportType] | undefined)?]
  )[];

  /**
   * Watermarks for categorizing coverage results as low, medium or high
   */
  watermarks?: Partial<Watermarks>;

  /**
   * Function that yields the correct absolute path to a file
   *
   * This function can be used to get complete control over the paths to source files.
   * This can e.g. be used to remove a non-existing `/_N_E/` folder inserted by Next.js.
   *
   * If no function is passed, the absolute path passed into this function is used.
   */
  rewritePath?: (file: {relativePath: string; absolutePath: string}) => string;
}

export class CoverageReporter implements Reporter {
  private readonly exclude: readonly string[];
  private readonly resultDir: string;
  private readonly reports: (
    | ReportType
    | [ReportType, ReportOptions[ReportType]?]
  )[];
  private readonly sourceRoot?: string;
  private readonly watermarks?: Partial<Watermarks>;
  private readonly rewritePath?: CoverageReporterOptions['rewritePath'];

  private readonly workerInstance: Worker;
  private readonly worker: Remote<CoverageWorker>;

  private config!: FullConfig;

  constructor({
    exclude,
    sourceRoot,
    resultDir,
    reports = ['text-summary'],
    watermarks,
    rewritePath,
  }: CoverageReporterOptions = {}) {
    this.exclude = typeof exclude === 'string' ? [exclude] : exclude ?? [];
    this.resultDir = resultDir || 'coverage';
    this.reports = reports;
    this.sourceRoot = sourceRoot;
    this.watermarks = watermarks;
    this.rewritePath = rewritePath;

    this.workerInstance = new Worker(require.resolve('./worker.js'));
    this.worker = wrap<CoverageWorker>(nodeEndpoint(this.workerInstance));
  }

  onBegin(config: FullConfig): void {
    this.config = config;

    void this.worker.reset();
  }

  onStepEnd(_test: TestCase, _result: TestResult, step: TestStep): void {
    // Check for existence of the attachments property added in 1.50 to keep backwards compatibility
    if ('attachments' in step) {
      step.attachments = step.attachments.filter(
        ({name}) => name !== attachmentName,
      );
    }
  }

  onTestEnd(_: unknown, result: TestResult): void {
    const attachmentIndex = result.attachments.findIndex(
      ({name}) => name === attachmentName,
    );

    if (attachmentIndex !== -1) {
      const [attachment] = result.attachments.splice(attachmentIndex, 1);

      if (attachment?.path != null) {
        void this.worker.startConversion(attachment.path);
      }
    }
  }

  async onEnd(result: FullResult): Promise<void> {
    if (result.status !== 'passed' && result.status !== 'failed') {
      return;
    }

    const sourceRoot = this.sourceRoot ?? this.config.rootDir;

    const coverage = createCoverageMap(
      Object.fromEntries(
        Object.entries(
          JSON.parse(
            await this.worker.getTotalCoverage(sourceRoot, this.exclude),
          ) as CoverageMapData,
        ).map(([relativePath, data]) => {
          const absolutePath = path.resolve(sourceRoot, relativePath);
          const newPath =
            this.rewritePath?.({absolutePath, relativePath}) ?? absolutePath;

          return [newPath, {...data, path: newPath}];
        }),
      ),
    );

    const context = createContext({
      coverageMap: coverage,
      dir: path.resolve(this.config.rootDir, this.resultDir),
      watermarks: this.watermarks,

      sourceFinder: path => {
        try {
          return readFileSync(path, 'utf8');
        } catch (e) {
          throw new Error(`Failed to read ${path}: ${e}`);
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
