# Agent Compute Gateway

**One compute capability for autonomous agents, backed by compute accounts the user already owns.**

An agent should be able to say:

```text
Run this workload.
Need >=24 GB VRAM.
Finish within 20 minutes.
Spend at most $1.
```

and call one capability:

```text
compute.execute()
```

The gateway handles provider credentials, policy, provider selection, execution, teardown, failure recovery, artifacts, and eventually cost/credit-aware routing.

The governing principle is:

> **Agents receive capabilities, not provider credentials.**

## Why this exists

The product began with a failed Hugging Face Jobs research run that returned `402 Payment Required`. The agent understood the research task and could continue the work, but it lacked an execution layer capable of saying:

> Hugging Face cannot run this right now. The user already has Modal. Continue there.

That exposed two walls for autonomous agents:

1. **Economic continuity**: a task can stop because one provider has no balance, quota, or capacity.
2. **Credential continuity**: even when another provider is available, the agent should not receive that provider's raw credentials.

The product is therefore not a wallet, secret manager, or static GPU-price table. It is an execution gateway over a user's connected compute estate.

## Current status

Gate 0 intentionally proves only this:

> An agent with zero Modal credentials can execute an authorized workload on the user's Modal account without receiving the Modal token pair.

Since then, the following gates are implemented and unit-tested (live provider proof still requires real credentials, see [`docs/ROADMAP.md`](docs/ROADMAP.md)):

- **Gate 1** — provider-neutral `compute.execute()` model, structured execution IDs, execution list/status/stop endpoints, output size limits.
- **Gate 2** — Hugging Face Jobs provider adapter with normalized failure classification (`402` → `billing_unavailable`, fallback-eligible; workload failure → `execution_error`, never retried elsewhere).
- **Gate 3** — deterministic fallback router. When Hugging Face cannot run a workload, the identical workload continues on Modal and the result returns to the agent with full failover provenance.

Current flow:

```text
Agent
  |
  v
Gateway API
  |
  +-- authorization / runtime policy
  |
  v
Modal provider adapter
  |
  v
credential broker
  |
  +-- GitHub CI: Infisical Cloud OIDC injects short-lived job secrets
  +-- local/dev fallback: Infisical Universal Auth
  |
  v
Modal SDK
  |
  v
Modal Sandbox
```

## Infisical Cloud + GitHub OIDC

CI does **not** store a long-lived `INFISICAL_CLIENT_SECRET`.

GitHub Actions requests a short-lived OIDC identity token, Infisical Cloud validates the workflow identity, then its official secrets action exposes only the requested `/providers/modal` secrets to the job runtime.

GitHub needs only two non-secret repository variables:

```text
INFISICAL_IDENTITY_ID
INFISICAL_PROJECT_SLUG
```

Infisical stores:

```text
/dev/providers/modal/MODAL_TOKEN_ID
/dev/providers/modal/MODAL_TOKEN_SECRET
```

## Run locally

Requirements:

- Node.js 22+
- a Modal account/token pair
- Infisical credentials for local Universal Auth, or `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` injected by a trusted secret runtime

```bash
npm install
npm test
npm start
```

CPU smoke:

```bash
npm run smoke:modal
```

GPU smoke:

```bash
npm run smoke:modal:gpu
```

Hugging Face Jobs smoke (requires `HF_NAMESPACE` and an HF token via env or Infisical):

```bash
npm run smoke:hf
```

Expected CPU proof:

```text
hello from credentialless Modal
```

## Public API

```http
GET  /health
GET  /v1/providers
POST /v1/providers/modal/test
POST /v1/providers/huggingface/test
POST /v1/compute/execute
GET  /v1/compute/executions
GET  /v1/compute/executions/:id
POST /v1/compute/executions/:id/stop
```

All endpoints except `/health` require `Authorization: Bearer $AGENT_API_KEY`.

`POST /v1/compute/execute` accepts the flat shape:

```json
{
  "image": "python:3.13-slim",
  "command": ["python", "-c", "print('hello from credentialless Modal')"],
  "timeoutMs": 60000
}
```

or the normalized intent shape:

```json
{
  "kind": "batch",
  "runtime": { "image": "ghcr.io/acme/asr-benchmark:sha", "command": ["python", "benchmark.py"] },
  "requirements": { "accelerator": "gpu", "gpuClass": "T4", "minVramGb": 16 },
  "constraints": { "maxRuntimeSeconds": 120, "network": "egress-only" },
  "economics": { "maxSpendUsd": 2, "optimizeFor": "effective_cost" }
}
```

Optionally pin a route with `"provider": "modal"` or `"provider": "huggingface"`. Without it, the router tries candidates in `ROUTE_ORDER` (default `huggingface,modal`), skipping unconfigured providers, and fails over only on fallback-eligible route failures (billing, auth, capacity). A workload that ran and failed is never retried on another provider.

The response carries routing provenance:

```json
{
  "provider": "modal",
  "status": "succeeded",
  "executionId": "exec_...",
  "providerExecutionId": "sb-...",
  "stdout": "hello\n",
  "stderr": "",
  "outputTruncated": false,
  "route": {
    "candidates": ["huggingface", "modal"],
    "attempts": [
      { "executionId": "exec_...", "provider": "huggingface", "status": "failed", "failureCode": "billing_unavailable", "fallbackEligible": true },
      { "executionId": "exec_...", "provider": "modal", "status": "succeeded" }
    ]
  }
}
```

## Product direction

The target architecture is:

```text
compute intent
    |
    v
policy
    |
    v
candidate providers
    |
    v
decision engine
    |
    v
execution adapter
    |
    +--> Modal
    +--> Hugging Face
    +--> RunPod
    +--> AWS
    +--> local GPU
    |
    v
artifacts / completion / recovery
```

The eventual optimizer should care about **effective cost to successful completion**, not only published GPU-hour price. Existing credits, startup latency, transfer cost, observed runtime, provider reliability, capacity, and failure probability all matter.

Example connected estate:

```text
Modal credits        $18
Hugging Face          $0
AWS startup credits $500
RunPod                 $4
local RTX 4090      available
```

A useful router reasons over that actual estate rather than pretending all providers begin from the same economic state.

## What is not the moat

These are important infrastructure, but not differentiators by themselves:

- encryption
- secret storage
- MCP wrappers
- BYOC
- static cloud/GPU price comparison
- generic agent wallets

The wedge being tested is:

> **Make a user's connected compute estate safely consumable by arbitrary authorized agents through one execution capability, then learn how to choose and recover routes using the user's real economics.**

## Roadmap

```text
Gate 0A  local/unit credentialless Modal path                 [done]
Gate 0B  real Infisical Cloud OIDC -> Modal CPU sandbox       [needs live credentials]
Gate 0C  real Modal GPU smoke                                 [needs live credentials]
Gate 1   provider-neutral compute.execute() model             [done, unit-tested]
Gate 2   Hugging Face provider                                [done, unit-tested; needs live HF proof]
Gate 3   HF 402/unavailable -> automatic Modal fallback       [done, unit-tested; needs live proof]
Gate 4   cost, credit, latency and reliability-aware routing
Gate 5   broader compute procurement and machine-payment adapters
```

The first genuinely important product milestone is Gate 3:

```text
HF execution fails
      |
      v
router understands failure
      |
      v
Modal is authorized + viable
      |
      v
workload continues
      |
      v
result delivered
```

## Documentation

- [`docs/PRODUCT_JOURNEY.md`](docs/PRODUCT_JOURNEY.md): full evolution from HF 402 through payments, compute routing, credential brokering, Composio, and Infisical
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): trust boundaries, provider abstractions, routing and execution model
- [`docs/SECURITY.md`](docs/SECURITY.md): security invariants and threat model
- [`docs/DECISIONS.md`](docs/DECISIONS.md): explicit architecture decisions and rejected paths
- [`docs/COMPETITIVE_LANDSCAPE.md`](docs/COMPETITIVE_LANDSCAPE.md): adjacent products and anti-moats
- [`docs/ROADMAP.md`](docs/ROADMAP.md): strict gates from proof to router

## Discipline

Do not turn this into a dashboard, generic secret manager, wallet, KYA clone, or giant cloud control plane before Gate 3 works.

The core test remains:

> **Can an agent reliably finish a compute task that would otherwise stop because its first execution path failed, without ever receiving provider credentials?**
