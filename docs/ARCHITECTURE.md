# Architecture

## Product boundary

The Agent Compute Gateway sits between autonomous agents and heterogeneous compute providers.

Its contract is not "give me a Modal token." Its contract is "execute this computation under these constraints."

```text
                  Agent / Agent Framework
                           |
                    compute.execute()
                           |
                           v
                 +--------------------+
                 |   Gateway API      |
                 | auth + validation  |
                 +---------+----------+
                           |
                           v
                 +--------------------+
                 | Policy / Mandate   |
                 +---------+----------+
                           |
                           v
                 +--------------------+
                 | Decision Engine    |
                 | requirements       |
                 | availability       |
                 | credits / price    |
                 | reliability        |
                 +---------+----------+
                           |
                           v
                 +--------------------+
                 | Execution Planner  |
                 +----+----------+----+
                      |          |
              provider adapters |
                 +----+----+     |
                 | Modal   |     | HF / RunPod / AWS...
                 +----+----+     |
                      |          |
                      +-----+----+
                            |
                  Credential Broker
                            |
                     Infisical / future
                            |
                            v
                    compute provider
```

Gate 0 implements only the boldest vertical slice:

```text
agent -> auth/policy -> Modal adapter -> Infisical -> Modal Sandbox -> result
```

## Trust boundaries

### 1. Agent boundary

Treat the agent as untrusted with respect to infrastructure credentials.

It may legitimately request compute, but it must not be able to retrieve provider secrets through any public tool or response.

Eventually an agent should receive a short-lived capability token describing allowed operations, not a standing infrastructure API key.

### 2. Gateway/decision boundary

The decision layer should not have direct access to provider secret values.

It should operate on metadata:

- provider connected / disconnected
- capabilities
- account/credit metadata where safe
- policy
- prices and estimates
- route health

Credential retrieval happens only after a route is selected and authorization succeeds.

### 3. Execution worker boundary

Gate 0's Modal adapter temporarily receives the Modal token pair because the Modal SDK requires it.

That worker is therefore trusted and must remain much smaller than the agent-facing application.

Future hardening can test Infisical Agent Proxy or provider-native short-lived credentials to shrink this trust boundary further.

### 4. Secret-manager boundary

Infisical is used for infrastructure credential storage and access control, not for product identity.

One execution-service machine identity can be tightly scoped to the secrets it needs. End-user agents should not become Infisical identities.

## Gate 0 request model

Current request:

```json
{
  "image": "python:3.13-slim",
  "command": ["python", "-c", "print('hello')"],
  "gpu": "T4",
  "timeoutMs": 120000
}
```

This is deliberately close to a container execution primitive.

The target contract becomes more semantic:

```json
{
  "kind": "batch",
  "runtime": {
    "image": "ghcr.io/acme/asr-benchmark:sha",
    "command": ["python", "benchmark.py"]
  },
  "requirements": {
    "accelerator": "gpu",
    "minVramGb": 24,
    "cpu": 4,
    "memoryGb": 16
  },
  "constraints": {
    "maxRuntimeSeconds": 1800,
    "network": "egress-only"
  },
  "economics": {
    "maxSpendUsd": 2,
    "optimizeFor": "effective_cost"
  },
  "artifacts": [
    "benchmark.json",
    "results.csv"
  ]
}
```

## Target internal model

### ProviderConnection

```ts
type ProviderConnection = {
  id: string;
  workspaceId: string;
  provider: "modal" | "huggingface" | "runpod" | string;
  credentialRef: string;
  status: "active" | "invalid" | "revoked";
  metadata: Record<string, unknown>;
};
```

`credentialRef` must be opaque to the decision engine.

### WorkloadIntent

```ts
type WorkloadIntent = {
  id: string;
  image?: string;
  command: string[];
  requirements: ResourceRequirements;
  constraints: ExecutionConstraints;
  economics?: EconomicConstraints;
};
```

### ProviderQuote

```ts
type ProviderQuote = {
  provider: string;
  feasible: boolean;
  estimatedCostUsd?: number;
  effectiveCostUsd?: number;
  estimatedStartupMs?: number;
  estimatedRuntimeMs?: number;
  confidence: number;
  rejectionReasons?: string[];
};
```

### ExecutionRecord

```ts
type ExecutionRecord = {
  id: string;
  workspaceId: string;
  agentId: string;
  workloadId: string;
  provider: string;
  providerExecutionId?: string;
  status: "queued" | "starting" | "running" | "succeeded" | "failed" | "stopped";
  startedAt?: string;
  finishedAt?: string;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  routeReason?: string;
  parentExecutionId?: string;
};
```

`parentExecutionId` becomes useful for failover provenance.

## Provider adapter contract

The router should never spread provider-specific code through the decision engine.

Target interface:

```ts
interface ComputeProvider {
  id: string;

  testConnection(context): Promise<ConnectionStatus>;
  capabilities(context): Promise<ProviderCapabilities>;
  estimate(workload, context): Promise<ProviderQuote>;
  execute(workload, context): Promise<ExecutionHandle>;
  status(handle, context): Promise<ExecutionStatus>;
  stop(handle, context): Promise<void>;
  collectArtifacts(handle, context): Promise<Artifact[]>;
}
```

Gate 0 only implements the equivalent of `execute()` for Modal.

## Credential broker contract

Infisical must be replaceable.

Target shape:

```ts
interface CredentialBroker {
  getProviderCredential({
    workspaceId,
    provider,
    executionId
  }): Promise<ProviderCredentialLease>;
}
```

A future lease object could include an expiry and disposal callback rather than returning a bare object.

```ts
type ProviderCredentialLease<T> = {
  value: T;
  expiresAt?: Date;
  dispose(): Promise<void>;
};
```

## Decision engine

The decision engine should optimize for **effective cost to successful completion**, not merely sticker price.

Candidate scoring inputs:

```text
hard feasibility
  GPU / VRAM / CPU / memory
  runtime/image compatibility
  policy
  region/data restrictions

soft objective
  price
  user's credits/prepaid balance
  startup latency
  historical runtime
  reliability
  failure/retry cost
  artifact/data transfer
  deadline
```

One possible early scoring model:

```text
effective_cost =
    billable_estimate
  - applicable_credits
  + startup_penalty
  + expected_failure_cost
  + data_transfer_estimate
  + deadline_penalty
```

The scoring formula itself is not sacred. The valuable asset becomes the observed data required to estimate it well.

## Routing and failover

The first routing behavior is intentionally simple:

```text
try Hugging Face
    |
   402 / unavailable
    |
    v
is Modal connected + feasible + within policy?
    |
   yes
    v
execute on Modal
```

Later routes should be planned from quotes rather than hard-coded exception branches.

```text
workload -> candidate set -> feasibility -> quotes -> score -> execute
                                            |
                                         failure
                                            |
                                 remaining candidate set
```

Failover must never silently relax:

- budget
- runtime limit
- required hardware
- security/network policy
- allowed providers

## Artifact model

Artifacts should be provider-neutral. Providers may produce local files, volumes, object-store URLs, or job outputs, but the agent should receive a consistent abstraction:

```ts
type Artifact = {
  name: string;
  mediaType?: string;
  sizeBytes?: number;
  digest?: string;
  uri: string;
};
```

Long-term, large artifacts should be referenced rather than pushed through the gateway body.

## Observability

Every execution should eventually answer:

- Who requested it?
- Under what policy?
- What workload fingerprint?
- Which providers were considered?
- Why was one selected?
- What credential connection was used, by opaque ID only?
- When did provisioning start?
- When did compute start?
- When did it finish?
- What did it cost?
- Was there a failover?
- Were resources torn down?

This telemetry is not only operational. It feeds the future routing model.
