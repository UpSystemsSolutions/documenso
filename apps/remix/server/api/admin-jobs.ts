import { sValidator } from '@hono/standard-validator';
import { BackgroundJobStatus, BackgroundJobTaskStatus } from '@prisma/client';
import { Hono } from 'hono';
import { z } from 'zod';

import { getSession } from '@documenso/auth/server/lib/utils/get-session';
import { jobsClient } from '@documenso/lib/jobs/client';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import { prisma } from '@documenso/prisma';

import type { HonoEnv } from '../router';

const ZRetryJobsRequestSchema = z
  .object({
    /**
     * Which jobs should be retried.
     * - `failed`: only failed jobs, usually what you want.
     * - `pending`: pending jobs (stuck / never picked up).
     * - `processing`: processing jobs (stuck in processing).
     * - `all`: everything except completed.
     */
    scope: z.enum(['failed', 'pending', 'processing', 'all']).default('failed'),

    /**
     * Optional filter by job definition id (backgroundJob.jobId).
     */
    jobDefinitionId: z.string().min(1).optional(),

    /**
     * Optional filter by job name (backgroundJob.name).
     */
    name: z.string().min(1).optional(),

    /**
     * Max jobs to retry in one request. Hard-capped.
     */
    limit: z.number().int().positive().max(1000).default(200),

    /**
     * Whether to reset DB state before dispatching.
     */
    reset: z.boolean().default(true),

    /**
     * Whether to dispatch jobs to the internal /api/jobs handler.
     */
    dispatch: z.boolean().default(true),
  })
  .strict();

const DISPATCH_CONCURRENCY = 3;

export const adminJobsRoute = new Hono<HonoEnv>().post(
  '/jobs/retry',
  sValidator('json', ZRetryJobsRequestSchema),
  async (c) => {
    const { user } = await getSession(c);

    if (!isAdmin(user)) {
      return c.json({ error: 'Not authorized' }, 401);
    }

    const { scope, jobDefinitionId, name, limit, reset, dispatch } = c.req.valid('json');

    const statusFilter: BackgroundJobStatus[] =
      scope === 'failed'
        ? [BackgroundJobStatus.FAILED]
        : scope === 'pending'
          ? [BackgroundJobStatus.PENDING]
          : scope === 'processing'
            ? [BackgroundJobStatus.PROCESSING]
            : [
                BackgroundJobStatus.FAILED,
                BackgroundJobStatus.PENDING,
                BackgroundJobStatus.PROCESSING,
              ];

    const jobs = await prisma.backgroundJob.findMany({
      where: {
        status: { in: statusFilter },
        ...(jobDefinitionId ? { jobId: jobDefinitionId } : {}),
        ...(name ? { name } : {}),
      },
      orderBy: {
        submittedAt: 'asc',
      },
      take: Math.min(limit, 1000),
      select: {
        id: true,
        jobId: true,
        name: true,
        payload: true,
        version: true,
        status: true,
      },
    });

    const results: Array<PromiseSettledResult<any>> = [];

    // Process in small batches to avoid overwhelming the local /api/jobs endpoint.
    for (let i = 0; i < jobs.length; i += DISPATCH_CONCURRENCY) {
      const batch = jobs.slice(i, i + DISPATCH_CONCURRENCY);

      // eslint-disable-next-line no-await-in-loop
      const batchResults = await Promise.allSettled(
        batch.map(async (job) => {
          if (reset) {
            await prisma.$transaction([
              prisma.backgroundJob.update({
                where: { id: job.id },
                data: {
                  status: BackgroundJobStatus.PENDING,
                  completedAt: null,
                  lastRetriedAt: new Date(),
                },
              }),
              prisma.backgroundJobTask.updateMany({
                where: {
                  jobId: job.id,
                  status: { in: [BackgroundJobTaskStatus.PENDING, BackgroundJobTaskStatus.FAILED] },
                },
                data: {
                  status: BackgroundJobTaskStatus.PENDING,
                  completedAt: null,
                  retried: 0,
                },
              }),
            ]);
          }

          let dispatched = false;

          if (dispatch) {
            try {
              await jobsClient.retryExistingJob({
                jobId: job.id,
                jobDefinitionId: job.jobId,
                data: {
                  name: job.name,
                  payload: (job.payload ?? null) as unknown,
                },
                retrySource: 'admin',
              });

              dispatched = true;
            } catch (e) {
              // Do NOT revert the job to FAILED here.
              // A local dispatch can time out (AbortError) while the job is still executing.
              // Reverting to FAILED would cause confusing state flapping.
              throw e;
            }
          }

          return {
            id: job.id,
            jobDefinitionId: job.jobId,
            name: job.name,
            reset,
            dispatched,
          };
        }),
      );

      results.push(...batchResults);
    }

    const retried = results
      .filter((r) => r.status === 'fulfilled')
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      .map((r) => (r as PromiseFulfilledResult<{ id: string }>).value);

    const failed = results
      .map((r, idx) => ({ r, idx }))
      .filter(({ r }) => r.status === 'rejected')
      .map(({ r, idx }) => {
        const reason = (r as PromiseRejectedResult).reason;
        const job = jobs[idx];

        return {
          id: job?.id,
          jobDefinitionId: job?.jobId,
          name: job?.name,
          error: reason instanceof Error ? reason.message : 'Unknown error',
          // stack intentionally omitted in production
        };
      });

    return c.json({
      matched: jobs.length,
      retried: retried.length,
      failed: failed.length,
      retriedJobs: retried,
      errors: failed,
      debug: {
        jobsProvider: process.env.NEXT_PRIVATE_JOBS_PROVIDER ?? 'local',
        internalUrl: process.env.NEXT_PRIVATE_INTERNAL_WEBAPP_URL ?? null,
      },
    });
  },
);
