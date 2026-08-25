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

## Current Gate 0

Gate 0 intentionally proves only this:

> An agent with zero Modal credentials can execute an authorized workload on the user's Modal account without receiving the Modal token pair.

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

Expected CPU proof:

```text
hello from credentialless Modal
```

## Public POC API

```http
POST /v1/providers/modal/test
POST /v1/compute/execute
```

Example:

```json
{
  "image": "python:3.13-slim",
  "command": ["python", "-c", "print('hello from credentialless Modal')"],
  "timeoutMs": 60000
}
```

Gate 0 always selects Modal. There is deliberately no fake decision engine yet.

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
Gate 0A  local/unit credentialless Modal path
Gate 0B  real Infisical Cloud OIDC -> Modal CPU sandbox
Gate 0C  real Modal GPU smoke
Gate 1   provider-neutral compute.execute() model
Gate 2   Hugging Face provider
Gate 3   HF 402/unavailable -> automatic Modal fallback
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
