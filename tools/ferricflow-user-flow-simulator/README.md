# FerricFlow n8n User-Flow Simulator

This tool runs low-rate, long-duration n8n-shaped user journeys against the
FerricFlow/FerricStore integration in this fork. It is intentionally not a
throughput benchmark. It keeps going after request failures and writes enough
context to diagnose what failed and with which mock variables.

The simulator models:

- user/project/workflow setup in FerricStore KV
- workflow static-data cache writes and reads
- worker heartbeat / instance registry style state
- chat session state stored through FerricStore KV
- n8n queue-mode execution lifecycle through FerricFlow
- retry-once, retry-with-backoff, success, and expected business-failure execution outcomes
- execution completion signals as separate FerricFlow records

## Flow Under Test

Each journey is one mock n8n workflow execution. It intentionally uses normal
user-flow naming and payloads instead of synthetic benchmark commands.

Journey setup:

1. `seed_user_and_project` writes a mock user, project hash, and project-member
   set.
2. `cache_workflow_static_data` writes and reads workflow static data.
3. `register_worker_heartbeat` writes worker heartbeat and membership state.
4. `store_chat_session_state` writes chat state and buffered stream chunks.
5. `enqueue_execution_flow` creates a FerricFlow execution record.

FerricFlow execution lifecycle:

```text
queued
  -> loading_execution
  -> executing
  -> completed | failed
```

The mock worker claims `queued`, loads the execution envelope from FerricStore
KV during `loading_execution`, and then applies the scenario outcome from
`executing`.

Verification after each journey:

1. Read the final Flow with `full: true`.
2. Assert the terminal state matches the scenario.
3. Read Flow history and assert it is non-empty.
4. For retry scenarios, assert the expected retry history exists.
5. Read the original execution envelope from FerricStore KV.
6. Publish an execution-finished signal as a separate FerricFlow record.

Expected business failures are terminal workflow outcomes, not simulator
failures. Unexpected errors go to `errors.jsonl`.

### Retry Coverage

`checkout_retry_once` verifies the basic retry path:

```text
executing attempt 0
  -> retry(runAtMs + 100ms, payload.retried = true)
  -> executing attempt 1
  -> completed
```

Assertions:

- final state is `completed`
- Flow history reaches at least attempt `1`

`checkout_retry_backoff` verifies a more complicated retry path:

```text
executing attempt 0
  -> retry(runAtMs + 100ms, retryAttempt = 1)
executing attempt 1
  -> retry(runAtMs + 250ms, retryAttempt = 2)
executing attempt 2
  -> retry(runAtMs + 500ms, retryAttempt = 3)
executing attempt 3
  -> completed
```

Assertions:

- final state is `completed`
- Flow history reaches at least attempt `3`
- Flow history includes retry error references
- terminal Flow data has `retryAttempt: 3`
- terminal Flow data has three `retryHistory` entries with delay metadata

## Prerequisites

Install this n8n fork and start FerricStore:

```bash
pnpm install --frozen-lockfile

docker run -d --name ferricstore-n8n-sim \
  -p 6388:6388 \
  -e FERRICSTORE_PROTECTED_MODE=false \
  ghcr.io/ferricstore/ferricstore:0.5.7
```

By default the simulator imports the installed `@ferricstore/ferricstore`
package. To test a local TypeScript SDK checkout, set:

```bash
export FERRICFLOW_SDK_PATH=/path/to/ferricstore-typescript/dist/index.cjs
```

## Run Modes

Smoke run:

```bash
node tools/ferricflow-user-flow-simulator/n8n-user-flow-simulator.mjs \
  --mode smoke \
  --duration-seconds 300 \
  --journeys-per-minute 12
```

Long soak:

```bash
node tools/ferricflow-user-flow-simulator/n8n-user-flow-simulator.mjs \
  --mode soak \
  --duration-seconds 86400 \
  --journeys-per-minute 3 \
  --sample-interval-seconds 30
```

Single verbose journey:

```bash
node tools/ferricflow-user-flow-simulator/n8n-user-flow-simulator.mjs \
  --mode debug \
  --scenario checkout_retry_backoff
```

Supported scenarios:

- `checkout_success`
- `checkout_retry_once`
- `checkout_retry_backoff`
- `checkout_business_fail`
- `chat_checkout`
- `all`

## Logs

Each run writes a directory under:

```text
logs/ferricflow-user-flow-simulator/<run-id>/
```

Files:

- `events.jsonl` - normal journey, step, worker, and lifecycle events
- `errors.jsonl` - failed requests/steps with full mock inputs and variables
- `metrics.jsonl` - periodic process/FerricStore samples and counters
- `summary.json` - final aggregate counters, latency summary, and error totals

Failures are non-fatal by default. Use `--fail-fast true` only for strict
regression checks.

## n8n Execute Command

An n8n workflow can run this through an Execute Command node:

```bash
node tools/ferricflow-user-flow-simulator/n8n-user-flow-simulator.mjs \
  --mode smoke \
  --duration-seconds 60 \
  --journeys-per-minute 6
```

For a 24-hour n8n-controlled soak, prefer many short invocations from a Schedule
Trigger or Loop node. For example, run `--mode smoke --duration-seconds 60` once
per minute and collect the emitted `summary` JSON plus the log directory path.

## Useful Environment

```bash
export N8N_FERRICFLOW_URL=ferric://127.0.0.1:6388
export FERRICSTORE_URL=ferric://127.0.0.1:6388
export FERRICFLOW_SDK_PATH=/optional/local/sdk/dist/index.cjs
```

`FERRICSTORE_URL` wins over `N8N_FERRICFLOW_URL` when both are set.
