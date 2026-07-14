# ADR: Batch Re-Analysis Architecture

## Decision

Choose **Option B**: an external job queue with a separate worker process, rather than running the batch inside the existing API process. The worker runs on demand, spun up per batch run rather than kept alive continuously, since batches are infrequent (2 to 3 times per week per `ARCHITECTURE_PROMPT.md`) and an always-on worker would sit idle almost all the time.

The specific queue technology (pg-boss now, with Redis and BullMQ as a later upgrade path) is a separate, more tactical decision, covered in its own section below.

## Reasoning

**1. Fault isolation directly protects the endpoint we're required to preserve.** A worker crash cannot take down the API server, because they are separate processes with independent memory and independent failure. This matters specifically because the requirement is to preserve the live streaming single-trial endpoint even under failure, not just under normal load. Option A cannot offer this: batch logic and API logic share one process, so a crash in one takes down the other.

**2. Horizontal scalability, with an explicit accepted cost.** A separate worker process can scale to any number of instances independently of the API. Option A has no equivalent lever: its batch logic is permanently bound to the same process serving live traffic, so the only way to add batch capacity is to scale the whole process, API included.

Choosing an on-demand worker instead of an always-on one means accepting a cold start before the first job runs. For a job averaging 15 to 45 seconds, a few seconds of cold start is small relative to total batch time. This is a deliberate tradeoff: a small latency cost, in exchange for not paying for idle compute around the clock for a workload that runs a few times a week.

Although a speed advantage, higher concurrency is also a risk multiplier. If a retry loop or a misconfigured job runs away, the damage happens faster at 10 to 20 concurrent calls than at 5. However, this is mitigated by the inbuilt retry configuration provided by most external queue technologies, expanded upon below.

**3. Real functionality comes built in, not hand written.** A job queue library provides several primitives Option A would have to build from scratch. Retry attempts and backoff are configuration options: classifying which errors are retryable, tracking attempt counts, computing backoff delays, and capping the maximum number of attempts would otherwise be real code that has to be written and tested carefully. Job claiming is atomic by construction, so two workers can never pick up the same job at once, a race condition that is easy to get subtly wrong in a hand-rolled concurrency limiter. A job that stalls mid-processing, because a worker crashed or hung, is automatically detected and made available again rather than sitting lost in an ambiguous state forever, which otherwise requires a hand-built claim-with-lease pattern. Per-job status (pending, active, completed, failed) is also tracked natively, which is the foundation the batch-level progress counter in the implementation plan builds on, rather than needing to invent that underlying bookkeeping from scratch.

## Strongest argument for Option A

Option A's failure surface is smaller and simpler: one process, one datastore. Option B adds a second process to monitor, plus whatever queue technology backs it.

Correctness in Option B depends on a longer chain of things being true at once. Option A works if the one process is running and the database is up. Option B works only if the API is running, the worker is running, both can reach the database, and the on-demand trigger correctly started the worker when the batch was enqueued. A break in any one link, especially the trigger, can leave a batch silently unprocessed while every individual component reports healthy.

The on-demand trigger specifically is new coordination logic with no equivalent in Option A. Something has to decide when to start the worker and when to stop it. That is real logic to build and test, and a new source of bugs: a batch enqueued right as the previous worker is shutting down could get missed if the start and stop handoff is not handled carefully.

The extra complexity buys headroom this workload does not need. Option A's roughly 5 concurrent calls clear a full 500 trial batch in under an hour. For something run 2 to 3 times a week, that is already fine. Option B buys faster completion and independent scaling, but not because this workload is asking for it yet.

This is the real cost of choosing Option B: a new operational dependency and new coordination logic that this workload's current scale does not strictly require.

## What would change this decision

- If trial count stayed closer to its current size, well under 500, rather than growing toward it, Option A's five concurrent calls would already be sufficient, and Option B's coordination overhead would not be worth taking on at all.
- If the infrastructure budget shrank further, the added cost of running a second deployment would be harder to justify.
- If retry requirements grew complex enough that a queue library's built-in attempts and backoff could not express them, for example different backoff per error type, or retries that depend on the outcome of other jobs, custom retry logic would need to be written on top of Option B anyway. That would erode its main advantage over Option A.

## Queue technology: pg-boss now, Redis and BullMQ as an upgrade path

Within Option B, choose **pg-boss**, using the same Postgres this app already needs for `analysis_results`, over BullMQ with Redis.

The reasoning is scale-specific, not a rejection of Redis and BullMQ on technical merit. Redis and BullMQ are generally the right tool for larger, higher-throughput workloads: they offer a true time-window rate limiter, push-based progress updates over Pub/Sub instead of polling, and isolate queue traffic from the primary database entirely. Those are real advantages. But they come with a genuinely new piece of infrastructure to provision, secure, and keep durable, and at this workload's scale (500 trials, a few batches a week) none of those advantages are load-bearing. pg-boss gets equivalent correctness (atomic job claiming, retry with backoff, stalled-job detection) from the database this system needs regardless of which queue technology is chosen.

Revisit this choice if job volume or batch frequency grows enough that concurrency alone can no longer approximate the OpenAI rate limit safely, if the UI requires genuinely push-based progress rather than a short polling interval, or if queue activity starts measurably competing with live traffic for database resources.

## Implementation plan

**First: prove the plumbing end to end with a minimal skeleton.** Wire up pg-boss against the existing Postgres. Create the results table and a batch-tracking table for progress. Build a minimal, separate worker entrypoint with a stub job handler that writes a placeholder result. Add `POST /batch/analyze`, enqueueing one job per trial and returning a batch ID, and confirm the worker actually picks jobs up and completes them end to end. This validates the riskiest new piece, the queue and worker split actually working, before any real analysis logic is built on top of it.

**Second: configure concurrency and retry limits, and prove them against the stub.** Set concurrency limits and retry attempts and backoff as job options. Extend the stub handler from the first step to deliberately fail some jobs, so retry and backoff behavior can be verified before any real, billed OpenAI call is possible. This puts the safety rails in place while mistakes are still free, rather than configuring them after real spending is already possible.

**Third: wire in real analysis logic.** Move the actual analysis logic into the job handler, reusing the existing logic in `analysis-service.ts`, replacing the stub now that concurrency and retry behavior are already proven. Classify errors as retryable or not: retryable errors get retried automatically, non-retryable errors are marked failed without stopping the rest of the batch.

**Fourth: build the batch orchestration API surface.** Add `GET /batch/:id/progress`, reading the batch-tracking table updated by each completed job. Add the on-demand worker trigger.

**Fifth: add live progress updates.** Wrap `GET /batch/:id/progress` in Server-Sent Events, reusing the same pattern already used by the single-trial `POST /trials/:id/analyze` endpoint, so the UI gets incremental updates without a full page reload.

**Sixth: add querying and operational visibility.** Add `GET /analysis-results`, supporting query params like focus and risk level so results are queryable across batches, not just within one run. Add basic monitoring for queue depth and worker health, and revisit the Redis and BullMQ upgrade path if the triggers for it start to apply.