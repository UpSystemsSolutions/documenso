import { sha256 } from '@noble/hashes/sha256';
import { BackgroundJobStatus, BackgroundJobTaskStatus, Prisma } from '@prisma/client';
import type { Context as HonoContext } from 'hono';

import { prisma } from '@documenso/prisma';

import { NEXT_PRIVATE_INTERNAL_WEBAPP_URL } from '../../constants/app';
import { sign } from '../../server-only/crypto/sign';
import { verify } from '../../server-only/crypto/verify';
import {
  type JobDefinition,
  type JobRunIO,
  type SimpleTriggerJobOptions,
  ZSimpleTriggerJobOptionsSchema,
} from './_internal/job';
import type { Json } from './_internal/json';
import { BaseJobProvider } from './base';

export class LocalJobProvider extends BaseJobProvider {
  private static _instance: LocalJobProvider;

  private _jobDefinitions: Record<string, JobDefinition> = {};

  private constructor() {
    super();
  }

  static getInstance() {
    if (!this._instance) {
      this._instance = new LocalJobProvider();
    }

    return this._instance;
  }

  public defineJob<N extends string, T>(definition: JobDefinition<N, T>) {
    this._jobDefinitions[definition.id] = {
      ...definition,
      enabled: definition.enabled ?? true,
    };
  }

  public async triggerJob(options: SimpleTriggerJobOptions) {
    const eligibleJobs = Object.values(this._jobDefinitions).filter(
      (job) => job.trigger.name === options.name,
    );

    // Create jobs synchronously so they’re persisted, then dispatch execution in the background.
    // We intentionally do NOT await execution here.
    await Promise.all(
      eligibleJobs.map(async (job) => {
        const pendingJob = await prisma.backgroundJob.create({
          data: {
            jobId: job.id,
            name: job.name,
            version: job.version,
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            payload: options.payload as Prisma.InputJsonValue,
          },
        });

        void this.submitJobToEndpoint({
          jobId: pendingJob.id,
          jobDefinitionId: pendingJob.jobId,
          data: options,
        }).catch((err) => {
          console.error(
            `[JOBS]: Error dispatching job ${pendingJob.jobId}/${pendingJob.id} (${options.name})`,
            err,
          );
        });
      }),
    );
  }

  public getApiHandler(): (c: HonoContext) => Promise<Response | void> {
    return async (c: HonoContext) => {
      const req = c.req;

      if (req.method !== 'POST') {
        return c.text('Method not allowed', 405);
      }

      const jobIdHeader = req.header('x-job-id');
      const signature = req.header('x-job-signature');
      const isRetry = req.header('x-job-retry') !== undefined;
      const retrySource = req.header('x-job-retry-source');
      const isAdminRetry = isRetry && retrySource === 'admin';

      // The internal route is /api/jobs/:jobDefinitionId/:jobId
      const jobDefinitionId = req.param('jobDefinitionId');
      const jobIdParam = req.param('jobId');
      const jobId = jobIdHeader ?? jobIdParam;

      const options = await req
        .json()
        .then(async (data) => ZSimpleTriggerJobOptionsSchema.parseAsync(data))
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        .then((data) => data as SimpleTriggerJobOptions)
        .catch(() => null);

      if (!options) {
        return c.text('Bad request', 400);
      }

      const definition =
        typeof jobDefinitionId === 'string' ? this._jobDefinitions[jobDefinitionId] : undefined;

      if (typeof jobId !== 'string') {
        return c.text('Bad request', 400);
      }

      if (typeof signature !== 'string') {
        return c.text('Bad request', 400);
      }

      if (typeof jobDefinitionId !== 'string') {
        return c.text('Bad request', 400);
      }

      if (typeof options !== 'object') {
        return c.text('Bad request', 400);
      }

      if (!definition) {
        return c.text('Job not found', 404);
      }

      if (definition && !definition.enabled) {
        return c.text('Job not found', 404);
      }

      if (!signature || !verify(options, signature)) {
        return c.text('Unauthorized', 401);
      }

      if (definition.trigger.schema) {
        const result = definition.trigger.schema.safeParse(options.payload);

        if (!result.success) {
          return c.text('Bad request', 400);
        }
      }

      // Avoid dumping sensitive payloads in logs.
      if (isAdminRetry) {
        console.log(`[JOBS]: Triggering job ${definition.id} (${definition.name}) [admin retry]`);
      }

      const existingJob = await prisma.backgroundJob.findUnique({
        where: { id: jobId },
      });

      if (!existingJob) {
        return c.text('Job not found', 404);
      }

      // Transition to PROCESSING regardless of previous state (except COMPLETED).
      if (existingJob.status === BackgroundJobStatus.COMPLETED) {
        return c.text('OK', 200);
      }

      let backgroundJob = await prisma.backgroundJob.update({
        where: { id: jobId },
        data: {
          status: BackgroundJobStatus.PROCESSING,
          retried: {
            increment: isRetry ? 1 : 0,
          },
          lastRetriedAt: isRetry ? new Date() : undefined,
        },
      });

      try {
        await definition.handler({
          payload: options.payload,
          io: this.createJobRunIO(jobId),
        });

        backgroundJob = await prisma.backgroundJob.update({
          where: {
            id: jobId,
          },
          data: {
            status: BackgroundJobStatus.COMPLETED,
            completedAt: new Date(),
          },
        });
      } catch (error) {
        // Keep failure logs minimal; full stack traces can be noisy in production.
        console.warn(
          `[JOBS]: Job ${options.name} failed (jobId=${jobId})${isAdminRetry ? ' [admin retry]' : ''}`,
        );

        const taskHasExceededRetries = error instanceof BackgroundTaskExceededRetriesError;
        const jobHasExceededRetries =
          backgroundJob.retried >= backgroundJob.maxRetries &&
          !(error instanceof BackgroundTaskFailedError);

        if (taskHasExceededRetries || jobHasExceededRetries) {
          await prisma.backgroundJob.update({
            where: {
              id: jobId,
            },
            data: {
              status: BackgroundJobStatus.FAILED,
              completedAt: new Date(),
            },
          });

          return c.text('Task exceeded retries', 500);
        }

        // Reset job to pending before resubmitting.
        backgroundJob = await prisma.backgroundJob.update({
          where: {
            id: jobId,
          },
          data: {
            status: BackgroundJobStatus.PENDING,
          },
        });

        // Exponential backoff + jitter (local provider): helps avoid tight retry loops
        // and reduces the chance of repeated failures under load.
        //
        // Semantics:
        // - `backgroundJob.retried` is incremented at the start of processing when X-Job-Retry is set.
        // - In this catch block, we are *about to schedule the next retry*.
        // - Therefore, the next attempt number is `retried + 1`.
        const nextRetryAttempt = Math.max(0, backgroundJob.retried) + 1;
        const baseMs = 1000; // 1s
        const maxMs = 30000; // 30s cap
        const backoffMs = Math.min(maxMs, baseMs * Math.pow(2, nextRetryAttempt - 1));
        const jitterMs = Math.floor(Math.random() * 250);
        const delayMs = backoffMs + jitterMs;

        if (isAdminRetry) {
          console.log(
            `[JOBS]: Resubmitting job ${options.name} (${jobId}) retry=${nextRetryAttempt}/${backgroundJob.maxRetries} in ${delayMs}ms [admin retry]`,
          );
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs));

        await this.submitJobToEndpoint({
          jobId,
          jobDefinitionId: backgroundJob.jobId,
          data: options,
          isRetry: true,
          retrySource: retrySource === 'admin' ? 'admin' : undefined,
        });
      }

      return c.text('OK', 200);
    };
  }

  public async retryExistingJob(options: {
    jobId: string;
    jobDefinitionId: string;
    data: SimpleTriggerJobOptions;
    /** Optional retry source for log gating. */
    retrySource?: 'admin';
  }): Promise<void> {
    await this.submitJobToEndpoint({
      jobId: options.jobId,
      jobDefinitionId: options.jobDefinitionId,
      data: options.data,
      isRetry: true,
      retrySource: options.retrySource,
    });
  }

  private async submitJobToEndpoint(options: {
    jobId: string;
    jobDefinitionId: string;
    data: SimpleTriggerJobOptions;
    isRetry?: boolean;
    retrySource?: 'admin';
  }) {
    const { jobId, jobDefinitionId, data, isRetry, retrySource } = options;

    const endpoint = `${NEXT_PRIVATE_INTERNAL_WEBAPP_URL}/api/jobs/${jobDefinitionId}/${jobId}`;
    const signature = sign(data);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Job-Id': jobId,
      'X-Job-Signature': signature,
    };

    if (isRetry) {
      headers['X-Job-Retry'] = '1';
    }

    if (retrySource === 'admin') {
      headers['X-Job-Retry-Source'] = 'admin';
    }

    // Await the HTTP result with a timeout so callers (e.g. admin retries) can detect failures.
    const controller = new AbortController();
    const timeoutMs = 60_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: JSON.stringify(data),
        headers,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(
          `[JOBS]: Failed submitting job ${jobDefinitionId}/${jobId} (${data.name}) status=${res.status} body=${text}`,
        );
        throw new Error(`Job submit failed (${res.status}) ${text}`);
      }
    } catch (err) {
      console.error(
        `[JOBS]: Error submitting job ${jobDefinitionId}/${jobId} (${data.name}) to ${endpoint}`,
        err,
      );
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private createJobRunIO(jobId: string): JobRunIO {
    return {
      runTask: async <T extends void | Json>(cacheKey: string, callback: () => Promise<T>) => {
        const hashedKey = Buffer.from(sha256(cacheKey)).toString('hex');

        let task = await prisma.backgroundJobTask.findFirst({
          where: {
            id: `task-${hashedKey}--${jobId}`,
            jobId,
          },
        });

        if (!task) {
          task = await prisma.backgroundJobTask.create({
            data: {
              id: `task-${hashedKey}--${jobId}`,
              name: cacheKey,
              jobId,
              status: BackgroundJobTaskStatus.PENDING,
            },
          });
        }

        if (task.status === BackgroundJobTaskStatus.COMPLETED) {
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          return task.result as T;
        }

        if (task.retried >= task.maxRetries) {
          throw new BackgroundTaskExceededRetriesError('Task exceeded retries');
        }

        try {
          const result = await callback();

          task = await prisma.backgroundJobTask.update({
            where: {
              id: task.id,
              jobId,
            },
            data: {
              status: BackgroundJobTaskStatus.COMPLETED,
              result: result === null ? Prisma.JsonNull : result,
              completedAt: new Date(),
            },
          });

          return result;
        } catch (err) {
          task = await prisma.backgroundJobTask.update({
            where: {
              id: task.id,
              jobId,
            },
            data: {
              status: BackgroundJobTaskStatus.FAILED,
              retried: {
                increment: 1,
              },
            },
          });

          // Avoid dumping full error objects here; the job-level handler already records failure.
          console.warn(`[JOBS:${task.id}] Task failed`);

          throw new BackgroundTaskFailedError('Task failed');
        }
      },
      triggerJob: async (_cacheKey, payload) => await this.triggerJob(payload),
      logger: {
        debug: (...args) => console.debug(`[${jobId}]`, ...args),
        error: (...args) => console.error(`[${jobId}]`, ...args),
        info: (...args) => console.info(`[${jobId}]`, ...args),
        log: (...args) => console.log(`[${jobId}]`, ...args),
        warn: (...args) => console.warn(`[${jobId}]`, ...args),
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      wait: async (_cacheKey: string, ms: number) => {
        if (!Number.isFinite(ms) || ms < 0) {
          throw new Error('wait(ms) must be a non-negative finite number');
        }

        await new Promise((resolve) => setTimeout(resolve, ms));
      },
    };
  }
}

class BackgroundTaskFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackgroundTaskFailedError';
  }
}

class BackgroundTaskExceededRetriesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackgroundTaskExceededRetriesError';
  }
}
