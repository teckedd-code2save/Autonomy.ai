# Product Journey

## 0. The trigger: an intelligent agent stopped at a billing wall

The product did not begin as a cloud-compute startup idea. It began while running a research benchmark.

The benchmark was prepared for Hugging Face Jobs. Hugging Face rejected the GPU run with `402 Payment Required` because the account did not have the necessary billing balance. Nothing ran and nothing was charged.

That failure was revealing because the computational task itself was ready. The agent could reason about the benchmark, the models, and the experiment. What it could not do was continue once the environment required an economic or infrastructure action.

The initial question was essentially:

> Can an agent or ChatGPT connector make the payment and continue on my behalf?

That opened the first branch of exploration.

---

## 1. Agent payments: ACP, MPP, x402, and delegated spending

We looked at the emerging machine-commerce ecosystem, especially:

- Agentic Commerce Protocol (ACP)
- Machine Payments Protocol (MPP)
- x402
- Crossmint agent payment infrastructure
- Nevermined
- Skyfire
- Coinbase-style agent wallets
- AWS AgentCore Payments
- Paystack Index in Africa

The important insight was that `402 Payment Required` is becoming an actual machine interaction primitive rather than merely an error code. MPP and x402 make it possible for software to encounter a priced resource, evaluate payment policy, pay, and retry.

The architecture initially looked like:

```text
Agent
  |
paid resource -> 402
  |
spending policy
  |
wallet / payment rail
  |
pay -> retry -> continue
```

This is powerful, but market investigation showed that **generic agent wallets and delegated spending controls are already becoming a busy category**. Crossmint, Nevermined, AWS, Skyfire and others cover substantial parts of it.

The product needed a narrower reason to exist.

---

## 2. Paystack Index validated delegated agent commerce, but pointed to a different niche

Paystack Index was particularly useful validation because it demonstrates a major African payments company taking delegated agent commerce seriously.

But Index is oriented toward consumer commerce and a participating merchant ecosystem: airtime, bills, food, transfers and similar user purchases.

The benchmark problem was different:

```text
"Finish this computational task."
```

The agent might need to acquire:

- temporary GPU compute
- inference calls
- CPU batch capacity
- model access
- data
- storage

This led to the idea of **machine procurement for computation**, not another general shopping/payment assistant.

---

## 3. Compute procurement became the stronger problem

The breakthrough question was:

> What if the agent did not need to care which compute provider ran the job?

Instead of asking the agent to know Modal, RunPod, Hugging Face Jobs, Lambda, AWS, etc., we could accept a compute intent:

```yaml
kind: batch
runtime: python
accelerator:
  type: gpu
  min_vram_gb: 24
limits:
  max_runtime_minutes: 30
economics:
  max_cost_usd: 1.50
  optimize_for: effective_cost
```

Then a router could decide where to execute it.

This is conceptually similar to OpenRouter at a much broader execution layer:

```text
model request -> inference route
```

versus:

```text
workload intent -> compute route
```

The route might depend on:

- GPU model / VRAM
- CPU / RAM
- runtime compatibility
- startup latency
- current availability
- nominal price
- user's prepaid balance or cloud credits
- historical throughput for that workload class
- reliability
- data locality
- policy

The economic objective is therefore not necessarily "lowest listed GPU-hour price." It is closer to:

```text
effective cost per successful workload
```

---

## 4. Market investigation killed the lazy version of the idea

Research found strong adjacent products:

### SkyPilot

SkyPilot already performs multi-cloud cost/capacity optimization, auto-failover, and centralized team access across many clouds. It can choose the cheapest available infrastructure from a search space and can run as a centralized API server.

### VaultLayer

VaultLayer already offers BYOC training across AWS, Azure, GCP, Lambda Labs, RunPod and Vast.ai, while keeping the user's own pricing, credits and contracts. It adds provisioning, checkpointing and resume-on-failure.

### Sapiom

Sapiom explicitly gives agents paid compute capabilities such as sandboxes, ephemeral code execution and serverless jobs.

### Claude Science + Modal

Anthropic and Modal shipped a vertical proof of the UX: a researcher can connect their own Modal workspace and Claude Science can automatically route demanding workloads to Modal.

These products meant we could not honestly claim novelty around:

- multi-cloud compute routing
- BYOC alone
- credential storage alone
- agent payment wallets alone
- "agents can use GPUs" alone

The product needed to live in the seam between those systems.

---

## 5. The second wall: credentials

The next practical question exposed another problem:

> Even if the router decides Modal is the right fallback, how does the agent push/run on Modal if the agent does not have Modal credentials?

Handing powerful provider credentials to an LLM/agent is the wrong default:

```text
"Here is MODAL_TOKEN_SECRET. Please do not leak it."
```

The desired architecture is:

```text
Agent
  |
  | compute capability
  v
Router
  |
  | provider credential resolved internally
  v
Modal
```

The agent should be able to **use** the capability without being able to **possess** the credential.

This became the first concrete product gate because every later routing feature depends on it.

---

## 6. KYA was considered and deliberately removed from Gate 0

Skyfire KYA raised an interesting possibility: prove agent identity and delegated authority using an external agent-identity primitive.

But KYA is not necessary to solve the first engineering problem. Gate 0 only needs:

1. caller authentication
2. authorization/policy
3. secure provider credential use

A normal agent API key or later short-lived signed capability token is sufficient for the POC.

KYA, AP2-style mandates, workload identity standards, and other external identity systems can be adapters later. The core product should not be coupled to any one identity vendor.

---

## 7. Composio was the first credential-plane candidate

Composio was attractive because connected accounts are exactly the UX we want:

```text
user connects service once
    -> credentials stored securely
    -> agent uses capability
    -> raw secret stays hidden
```

Its server-side authenticated proxy is excellent for REST-style providers because Composio can inject OAuth/API credentials without returning them to application code.

However, Modal exposed an architectural mismatch.

Modal's normal programmatic control plane is its SDK/CLI. The JS SDK authenticates using a two-part `tokenId` + `tokenSecret` credential. Composio's strength is mediating authenticated HTTP/tool calls without exposing the credential. To force Modal through it we would have needed a custom relay/auth bundle and would still own trusted code that unpacked or consumed the Modal credential.

At that point Composio would be adding complexity rather than removing the risky responsibility.

Decision:

> Do not force Composio into Modal Gate 0. Keep the connected-account insight, use a secret-management primitive that matches Modal directly.

---

## 8. Infisical became the Gate 0 credential plane

Infisical fit the immediate need better:

- proper secret manager
- machine identities
- Universal Auth
- official Node SDK
- read secrets on demand
- free plan sufficient for a prototype
- Agent Proxy available later

The Free plan currently includes five identities, unlimited projects, and Agent Proxy, which is enough for this experiment.

The design deliberately does **not** create one Infisical identity per AI agent. Infisical identities protect infrastructure. Our product owns end-user and agent identity.

```text
Our users / agents / policies
          |
          v
Execution service machine identity
          |
          v
Infisical
```

This avoids coupling product economics to a secret-manager identity per agent.

---

## 9. Gate 0 was implemented

The first code now exists.

The POC exposes:

```text
POST /v1/compute/execute
```

Gate 0 always routes to Modal. It validates a minimal workload, limits runtime to five minutes, retrieves the Modal token pair from Infisical only inside the Modal adapter, creates a Modal Sandbox, captures output, and terminates the Sandbox in `finally`.

Tests currently prove:

- successful agent-facing execution with a fake Modal client
- credentials are passed to the provider adapter but do not appear in the result
- excessive runtime is rejected before the provider is called

A real Modal smoke test is the next operational step after Infisical/Modal credential onboarding.

---

## 10. What the product is now

Working category description:

### Agent Compute Gateway

A gateway that makes a user's connected compute estate safely consumable by autonomous agents through one capability interface.

The long-term proposition is not:

> "We store your Modal key."

It is:

> "Give your agent compute access once. We decide how to turn a workload intent into a completed execution across the compute you can access, without exposing provider credentials."

This has three increasingly valuable layers:

### A. Capability layer

```text
agent -> compute.execute()
```

No provider secrets.

### B. Execution abstraction

Translate one normalized workload into Modal, Hugging Face, RunPod, cloud VM, local GPU, etc.

### C. Decision layer

Choose a route based on user-specific economics and task constraints.

```text
listed price
- usable credits
+ startup penalty
+ expected failure cost
+ transfer cost
+ performance penalty
= effective route cost
```

---

## 11. The first magical behavior we want

The original failure should become our first end-to-end routing demonstration:

```text
Agent: run benchmark
        |
        v
Hugging Face Jobs
        |
      402
        |
        v
Compute Gateway
        |
"Modal is connected and viable"
        |
        v
Modal Sandbox / GPU
        |
        v
benchmark completes
```

The user should not have to:

- hand the agent Modal credentials
- manually rewrite the workload for Modal
- decide where to retry
- babysit teardown

The task should simply continue.

---

## 12. What may become defensible

Encryption and secret storage are not the moat. Those are table stakes and should be delegated where possible.

Potential defensibility comes from accumulated **execution intelligence**:

- workload fingerprint -> provider/hardware compatibility
- time-to-ready by provider and region
- real cost-to-completion
- failure and retry behavior
- credit/balance-aware marginal cost
- cold-start behavior
- throughput by workload class
- artifact-transfer cost
- provider-specific quirks and normalized translation

Over time the system could know, for example:

> Provider A's GPU is cheaper per hour, but Provider B is cheaper per completed Whisper benchmark because it starts faster and finishes 1.6x sooner.

That is much more useful than a static GPU price table.

---

## 13. Discipline going forward

The product is large enough to become a swamp if built horizontally too early.

The current sequence is intentionally strict:

1. one provider
2. real credentialless execution
3. one GPU run
4. normalized execute contract
5. second provider
6. first fallback
7. only then a real decision engine
8. payments later

No dashboard, wallet, KYA, marketplace, or generalized secrets platform until execution routing itself proves valuable.
