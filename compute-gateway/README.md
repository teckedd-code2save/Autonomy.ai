# Agent Compute Gateway

> Working product name. Gate 0 prototype, August 2026.

**One compute capability for autonomous agents, backed by the compute accounts a user already owns.**

The long-term product goal is simple to say:

```text
Agent: "Run this workload. I need >=24 GB VRAM, finish within 20 minutes, spend at most $1."

                    compute.execute()
                            |
                            v
                 Agent Compute Gateway
                 /        |          \
            policy     decision     execution
               |           |           |
               +-----------+-----------+
                            |
                user's connected compute
                 /         |          \
              Modal       HF         RunPod ...
```

The agent gets a capability. It does **not** get `MODAL_TOKEN_SECRET`, `HF_TOKEN`, AWS keys, or other provider credentials.

Gate 0 intentionally implements only the smallest proof:

> An agent with zero Modal credentials can run an authorized workload on the user's Modal account, while the Modal token pair lives in Infisical and is retrieved only inside the Modal execution adapter.

## Why this exists

This product started from an unglamorous failure. A research benchmark was ready to run on Hugging Face Jobs, but Hugging Face returned `402 Payment Required` because the account did not have the required billing balance. The agent had enough intelligence to continue the research, but no economic or infrastructure execution layer capable of saying:

> "HF is unavailable. The user already has Modal. Move the workload there and continue."

That exposed two separate walls for autonomous agents:

1. **Economic wall** - the agent cannot satisfy or route around a payment requirement.
2. **Credential wall** - the agent may know another provider can do the work, but it does not have that provider's credentials and should not be handed them.

The first exploration went through ACP, MPP, x402, Paystack Index, Crossmint, Nevermined, Skyfire, Sapiom, AWS AgentCore Payments, and other agent-payment infrastructure. That research showed that generic "give the agent a wallet" infrastructure is already becoming crowded.

The more interesting product problem became **compute continuity**:

```text
intent -> capability matching -> connected-account awareness -> routing -> execution -> fallback -> artifacts
```

The credential wall then became the first concrete engineering gate.

## Gate 0 architecture

```text
AI Agent
   |
   | Bearer agent capability (POC: one API key)
   v
Compute Gateway API
   |
   | validate request + runtime policy
   v
ComputeService
   |
   | Gate 0 route = Modal
   v
ModalProvider
   |
   | late credential retrieval
   v
Infisical Free
   |  MODAL_TOKEN_ID
   |  MODAL_TOKEN_SECRET
   v
ModalClient
   |
   v
Modal Sandbox
   |
   +--> stdout / stderr / execution id
   |
   +--> terminate in finally
```

### Security invariant

**Agents receive capabilities, not provider credentials.**

Current Gate 0 invariants:

1. Agent-facing requests contain no Modal credentials.
2. Agent-facing responses contain no Modal credentials.
3. Modal credentials are retrieved only after request validation and policy checks.
4. Provider secrets are requested only inside the provider adapter.
5. Modal Sandboxes are terminated in `finally`.
6. Arbitrary provider error objects are never serialized back to the agent.
7. Runtime is capped at five minutes in the POC.
8. Modal credentials are not stored in this repository or in the service `.env` file.

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model and hardening roadmap.

## Why Infisical

We evaluated Composio first because it has already solved a polished version of connected-account onboarding and credential isolation. It is excellent when credentials can be injected into authenticated HTTP/tool calls. However, Modal's primary programmatic control path is its SDK/CLI and uses a `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` pair. Forcing that through Composio would have required a custom relay/auth shape that added complexity without removing our need for trusted execution code.

Infisical fits the immediate Modal problem directly:

- dedicated secret management rather than an agent-tool abstraction
- machine identities and Universal Auth
- on-demand SDK retrieval
- Agent Proxy available on the free plan for a later experiment
- five identities and unlimited projects on the current Free plan

Infisical is still hidden behind our own `CredentialBroker` boundary so it remains replaceable.

## Repository status

| Gate | Goal | Status |
|---|---|---|
| Gate 0A | Local policy and secret-isolation tests | **Passing** |
| Gate 0B | Real CPU Modal Sandbox through Infisical | Needs credential onboarding |
| Gate 0C | Real Modal GPU smoke test | After 0B |
| Gate 0.5 | Infisical Agent Proxy experiment | Planned |
| Gate 1 | Normalize `compute.execute()` | Planned |
| Gate 2 | Hugging Face provider | Planned |
| Gate 3 | `HF 402 -> Modal` fallback | Planned |
| Gate 4 | Multi-provider decision engine | Planned |
| Gate 5 | Actual-cost / credits / latency optimization | Planned |

The local tests use a fake Modal client and verify both successful execution and the policy boundary. A real Modal call has deliberately **not** been performed from this repository because provider credentials are not committed or pasted into an agent conversation.

## Requirements

- Node.js 22+
- Infisical Free account/project
- Modal account and API token pair

Pinned current SDKs at the time of this Gate 0 snapshot:

- `modal@0.9.0`
- `@infisical/sdk@5.0.2`

Modal's JS SDK supports Node 22+, `ModalClient({ tokenId, tokenSecret })`, registry images, Sandboxes, GPU selection, output streaming, and termination.

## Configure Infisical Free

Create an Infisical project, e.g. `compute-router`, with a `dev` environment.

Under `/providers/modal`, add:

```text
MODAL_TOKEN_ID
MODAL_TOKEN_SECRET
```

Create **one machine identity for the execution service**, enable Universal Auth, and give it only the access needed to read the Modal secret path. Do not create an Infisical machine identity per end-user agent. End-user and agent identity belong to the gateway, not the secret manager.

## Configure the gateway

Copy `.env.example` to `.env` and fill only gateway/Infisical values:

```bash
cp .env.example .env
```

Do **not** put Modal credentials in `.env`.

Export the variables before starting:

```bash
set -a
source .env
set +a
```

Install and test:

```bash
npm install
npm test
npm start
```

## CPU smoke test

```bash
curl -s http://localhost:4000/v1/compute/execute \
  -H "Authorization: Bearer $AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "image": "python:3.13-slim",
    "command": ["python", "-c", "print(\"hello from credentialless Modal\")"],
    "timeoutMs": 60000
  }'
```

Expected response shape:

```json
{
  "provider": "modal",
  "executionId": "sb-...",
  "stdout": "hello from credentialless Modal\n",
  "stderr": ""
}
```

## GPU smoke test

After CPU success:

```bash
curl -s http://localhost:4000/v1/compute/execute \
  -H "Authorization: Bearer $AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "image": "nvidia/cuda:12.4.1-base-ubuntu22.04",
    "command": ["nvidia-smi"],
    "gpu": "T4",
    "timeoutMs": 120000
  }'
```

## What Gate 0 intentionally does not do

- no AI model inside the service
- no provider ranking
- no automatic payments
- no MPP/x402
- no KYA
- no user-facing dashboard
- no persistent deployments
- no arbitrary networking policy
- no Hugging Face fallback yet
- no multi-tenant database yet

Those omissions are deliberate. The first proof is credentialless execution, not the whole cathedral.

## Documentation

- [Product journey](docs/PRODUCT_JOURNEY.md) - how a failed HF benchmark turned into this product thesis
- [Architecture](docs/ARCHITECTURE.md) - component boundaries and target data model
- [Security](docs/SECURITY.md) - invariants, threat model, and hardening plan
- [Decisions](docs/DECISIONS.md) - why ACP/MPP, KYA, Composio, and Infisical landed where they did
- [Competitive landscape](docs/COMPETITIVE_LANDSCAPE.md) - what is already built and where this product must be different
- [Roadmap](docs/ROADMAP.md) - gates from Modal proof to a real decision router

## North-star experience

The eventual UX should be boring in the best possible way:

```js
const result = await compute.execute({
  task: benchmark,
  requirements: { gpuMemoryGb: 24 },
  budget: { maxUsd: 2 },
  optimizeFor: "effective_cost"
});
```

Everything underneath that call - provider credentials, connected accounts, available credits, GPU compatibility, startup time, failure recovery, teardown, and eventually machine-native payments - becomes the router's problem.
