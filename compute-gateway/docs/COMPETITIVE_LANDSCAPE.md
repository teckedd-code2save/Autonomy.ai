# Competitive Landscape

Snapshot: August 2026.

The important conclusion from market research is **not** "nobody has thought of this." Several strong products own large pieces. The opportunity only makes sense if the gateway combines those pieces around an agent-first compute abstraction.

## Adjacent products

### Composio

**Owns:** connected accounts, credential storage/refresh, tool execution, authenticated API proxying.

Composio's proxy execution model injects connected-account credentials server-side so application code does not need raw secrets.

**Overlap:** the "connect once, agent uses a capability" credential UX.

**Difference:** general SaaS/API tool integration rather than compute requirements, provider selection, workload translation, GPU/CPU economics and compute failover.

Sources:
- https://docs.composio.dev/docs/auth-configuration/connected-accounts
- https://docs.composio.dev/docs/extending-sessions/proxy-execute

### Pipedream Connect

**Owns:** broad connected-account and API integration infrastructure.

**Overlap:** credential abstraction for user-connected services.

**Difference:** not a compute-specific planner/executor.

### SkyPilot

**Owns:** cross-cloud compute abstraction, "cheapest and available" selection, auto-failover, BYOC, centralized API server/team access.

SkyPilot is one of the closest technical adjacencies and should be treated seriously rather than hand-waved away.

**Difference in intended product UX:** SkyPilot is primarily an infrastructure control plane for developers/teams. Our intended public primitive is an agent capability that also understands user-specific connection state and eventually broader economic/payment context.

Source:
- https://docs.skypilot.co/en/ssm-docs/overview.html

### VaultLayer

**Owns:** BYOC GPU training across hyperscalers and GPU clouds, provisioning, checkpointing and resume-on-failure.

It explicitly supports AWS, Azure, GCP, Lambda Labs, RunPod and Vast.ai, and preserves the user's cloud pricing/credits.

**Overlap:** connected compute accounts, user credits/contracts, reliable execution.

**Difference:** focused on training reliability and user-invoked jobs, not a general autonomous-agent compute capability or arbitrary provider-neutral execution intent.

Sources:
- https://vaultlayer.cloud/byoc-gpu-training
- https://vaultlayer.cloud/use-cloud-credits-for-training

### Claude Science + Modal

This is important product validation.

Claude Science allows researchers to connect their own Modal workspace. Workloads needing GPUs or many CPUs can route automatically to Modal while the researcher stays in the Claude experience.

**Overlap:** an agent determines more compute is needed and uses a user's connected provider without exposing provider mechanics to the user in each step.

**Difference:** a vertical scientific workbench and a specific integrated compute backend, not a provider-neutral standalone gateway for arbitrary agents.

Source:
- https://modal.com/blog/modal-integration-brings-scalable-compute-to-claude-science

### Sapiom

**Owns:** agent-accessible capabilities including sandboxes, ephemeral code runs, serverless jobs and other paid resources through a unified interface.

**Overlap:** agents consume compute as a capability rather than provisioning raw infrastructure.

**Difference:** Sapiom provides a managed capability catalog. Our early wedge is BYOC/connected-estate routing where the user's existing accounts, balances, credits, and provider relationships are first-class routing inputs.

Source:
- https://docs.sapiom.ai/capabilities/compute

### Crossmint

**Owns:** agent payment infrastructure across cards/stablecoins, spending rules, x402 and MPP flows.

**Overlap:** bounded autonomous economic action.

**Difference:** payment is a future input/rail for the router, not the core compute execution abstraction.

Sources:
- https://docs.crossmint.com/agents/overview
- https://docs.crossmint.com/agents/how-agents-pay

### Nevermined / Skyfire / other agent-payment vendors

**Own:** various combinations of delegated spending, agent identity, payments and machine commerce.

**Overlap:** authorization/payment of resources.

**Difference:** the gateway must earn its place through workload execution intelligence, not by cloning wallet primitives.

### Paystack Index

**Owns:** AI-native commerce in Africa through participating services/merchants.

**Overlap:** delegated agent action, African agent-commerce validation.

**Difference:** consumer/service commerce rather than provider-neutral machine compute procurement.

## Where the product can still be different

The interesting intersection is:

```text
Composio-like connected accounts
          +
SkyPilot-like compute abstraction
          +
OpenRouter-like route decision
          +
agent-native capability interface
          +
user-specific economics
```

But simply combining buzzwords is not enough. The product must demonstrate an experience that adjacent systems do not make trivial:

> An arbitrary authorized agent can ask for a computational outcome, and the gateway can safely use any compute the user has connected, without exposing provider credentials, while choosing and recovering routes based on the user's real constraints.

## Product wedge

### "Make my entire compute estate consumable by agents"

A user may have:

```text
Modal balance / account
Hugging Face credits
AWS startup credits
RunPod balance
local workstation GPU
company Kubernetes
```

The router should present one capability:

```text
compute.execute(intent)
```

That is different from making the user or agent choose a cloud every time.

## Important anti-moats

These are **not** defensible by themselves:

- encrypting API keys
- using a secret manager
- exposing an MCP tool
- comparing public GPU price tables
- accepting MPP/x402
- running a Modal Sandbox
- BYOC as a label

All are useful infrastructure, but competitors can reproduce them.

## Potential compounding assets

The router can become harder to copy if it accumulates reliable execution data:

```text
workload fingerprint
 -> provider/hardware
 -> startup time
 -> runtime
 -> failure modes
 -> retries
 -> true billed cost
 -> transfer cost
 -> successful artifact
```

This enables a decision layer based on **cost and probability of successful completion**, not marketing price.

## Competitive test we should keep asking

For every feature:

> Could a user get 90% of this by putting SkyPilot behind an MCP tool?

If yes, the feature is not enough.

Our differentiation has to show up in agent authorization, connected-account UX, user-specific economics, cross-provider workload normalization, route recovery, and the data-driven decision layer.
