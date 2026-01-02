import { match } from 'ts-pattern';

import { env } from '../../utils/env';
import type { JobDefinition, SimpleTriggerJobOptions, TriggerJobOptions } from './_internal/job';
import type { BaseJobProvider as JobClientProvider } from './base';
import { InngestJobProvider } from './inngest';
import { LocalJobProvider } from './local';

export class JobClient<T extends ReadonlyArray<JobDefinition> = []> {
  private _provider: JobClientProvider;

  public constructor(definitions: T) {
    this._provider = match(env('NEXT_PRIVATE_JOBS_PROVIDER'))
      .with('inngest', () => InngestJobProvider.getInstance())
      .otherwise(() => LocalJobProvider.getInstance());

    definitions.forEach((definition) => {
      this._provider.defineJob(definition);
    });
  }

  public async triggerJob(options: TriggerJobOptions<T>) {
    return this._provider.triggerJob(options);
  }

  public async retryExistingJob(options: {
    jobId: string;
    jobDefinitionId: string;
    data: SimpleTriggerJobOptions;
    /** Optional retry source for log gating (e.g. admin UI button). */
    retrySource?: 'admin';
  }) {
    return this._provider.retryExistingJob({
      jobId: options.jobId,
      jobDefinitionId: options.jobDefinitionId,
      data: options.data,
      retrySource: options.retrySource,
    });
  }

  public getApiHandler() {
    return this._provider.getApiHandler();
  }
}
