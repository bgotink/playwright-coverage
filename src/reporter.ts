import type {
  FullConfig,
  FullResult,
  Reporter,
  TestResult,
} from '@playwright/test/reporter';
import {Remote, wrap} from 'comlink';
import nodeEndpoint from 'comlink/dist/umd/node-adapter';
import {readFileSync} from 'fs';
import {createCoverageMap} from 'istanbul-lib-coverage';
import {createContext, Watermarks} from 'istanbul-lib-report';
import {create, ReportType, ReportOptions} from 'istanbul-reports';
import path from 'path';
import {Worker} from 'worker_threads';
import {attachmentName} from './data';
import type {CoverageWorker} from './worker';

export class CoverageReporter implements Reporter {
  private readonly exclude: readonly string[];
  private readonly resultDir: string;
  private readonly reports: (
    | ReportType
    | [ReportType, ReportOptions[ReportType] | undefined]
  )[];
  private readonly sourceRoot?: string;
  private readonly watermarks?: Partial<Watermarks>;

  private readonly workerInstance: Worker;
  private readonly worker: Remote<CoverageWorker>;

  private config!: FullConfig;

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

    this.workerInstance = new Worker(require.resolve('./worker.js'));
    this.worker = wrap<CoverageWorker>(nodeEndpoint(this.workerInstance));
  }

  onBegin(config: FullConfig): void {
    this.config = config;

    void this.worker.reset();
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
      JSON.parse(await this.worker.getTotalCoverage(sourceRoot, this.exclude)),
    );

    const context = createContext({
      coverageMap: coverage,
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
