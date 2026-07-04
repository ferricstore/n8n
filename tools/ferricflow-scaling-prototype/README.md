# FerricFlow Scaling Prototype

This fork is an example of FerricStore used as both a workflow engine and a KV
store inside a real product:

- FerricFlow workflow records replace n8n's Bull-backed queue orchestration.
- FerricStore KV replaces Redis-backed cache, instance registry, MCP queue-mode
  session state, and coordination data.

This directory contains a small executable prototype for the workflow-engine
side, replacing n8n's Bull-backed scaling queue with FerricFlow workflow
records.

This directory also documents the production adapter now added under
`packages/cli/src/scaling/ferricflow`. The prototype script still models the
current queue envelope from `packages/cli/src/scaling/scaling.types.ts` and the
execution handoff in:

- `packages/cli/src/workflow-runner.ts`
- `packages/cli/src/scaling/scaling.service.ts`
- `packages/cli/src/scaling/job-processor.ts`

Current upstream n8n scaling mode stores execution data in the n8n database,
enqueues a small `JobData` payload in Bull/Redis, and workers load the
execution by `executionId`. The FerricFlow mapping keeps that shape while
moving queue orchestration and Redis-style coordination onto FerricStore.

The local `ghcr.io/ferricstore/ferricstore:0.5.7` image used for this prototype
supports the core flow lifecycle shown here. It has a narrower priority range
than Bull, so the demo keeps n8n's queue priority in the payload instead of
using FerricFlow priority directly.

| n8n today | FerricFlow prototype |
| --- | --- |
| `queue.add(JOB_TYPE_NAME, jobData)` | `workflow.start(executionId, { payload: jobData })` |
| Bull waiting job | Flow state `queued` |
| Worker dequeues job | `FLOW.CLAIM_DUE type=n8n_execution_prototype state=queued` |
| `JobProcessor.processJob()` loads DB execution | Flow state `loading_execution` |
| n8n workflow execution runs | Flow state `executing` |
| Bull progress `job-finished` | Flow terminal `complete()` |
| Bull failed job | Flow terminal `fail()` |
| Bull retry/stalled handling | Flow `retry({ runAtMs })` plus lease expiry/reclaim |

## Run

Start FerricStore:

```bash
docker run -d --name ferricstore-n8n-prototype \
  -p 6388:6388 \
  -e FERRICSTORE_PROTECTED_MODE=false \
  ghcr.io/ferricstore/ferricstore:0.5.7
```

From the n8n repo:

```bash
node tools/ferricflow-scaling-prototype/n8n-ferricflow-prototype.mjs
node tools/ferricflow-scaling-prototype/n8n-ferricflow-prototype.mjs --mode retry-once
node tools/ferricflow-scaling-prototype/n8n-ferricflow-prototype.mjs --mode fail
```

By default the script imports the local FerricStore TypeScript SDK from
`../ferricstore-typescript/dist/index.js` relative to this repository. Override
with `FERRICFLOW_SDK_PATH=/path/to/dist/index.js` if needed.

The demo uses one partition per execution by default to avoid claiming stale
prototype records from previous runs. Pass `--partition-key workflow:<id>` if
you want to experiment with workflow-level partition affinity.

## Production Adapter

The production path defaults to FerricFlow. Use these settings for a local
FerricStore-backed queue:

```bash
N8N_FERRICFLOW_URL=ferric://127.0.0.1:6388
```

`N8N_FERRICFLOW_SDK_PATH` is optional and only needed when testing a local
FerricStore TypeScript SDK checkout instead of the installed npm package. Point
it at the SDK's CommonJS build, for example
`../ferricstore-typescript/dist/index.cjs`.

Set `N8N_SCALING_BACKEND=bull` only when intentionally using the legacy
Bull/Redis queue.

What is currently implemented:

- `ScalingService` can create a FerricFlow queue instead of Bull.
- `CacheService` can use FerricStore KV instead of Redis or memory.
- The instance registry can use FerricStore KV for member registration,
  heartbeats, stale cleanup, and lifecycle checks.
- n8n workers claim `queued` FerricFlow records and run the existing
  `JobProcessor` path.
- Job progress, completion, and failure notifications are FerricFlow execution
  signal records: type `${N8N_FERRICFLOW_TYPE}_signal`, state `recorded`.
- n8n scaling commands, worker responses, and MCP relay messages are separate
  FerricFlow delivery workflows in state `ready_to_deliver`:
  `n8n_scaling_command`, `n8n_scaling_worker_response`, and
  `n8n_scaling_mcp_relay`.
- The MCP queue-mode session store uses FerricStore KV through the same
  `Publisher` helper instead of Redis.
- Active job leases are renewed with `FLOW.EXTEND_LEASE`.

The adapter uses one shared FerricFlow partition per n8n queue prefix because
FerricStore 0.5.7 requires partition-scoped claims. A later version can shard
this by workflow or execution if FerricStore exposes a global due-claim index.

One important naming constraint: do not use a user workflow state named
`running`; FerricFlow reserves that internal running state for claimed leases.
The demo uses `executing` for n8n's workflow-execution phase.
