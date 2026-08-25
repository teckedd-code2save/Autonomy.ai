# Roadmap

The roadmap is intentionally gated. Each gate must produce a concrete proof before the next layer is added.

## Gate 0A - Local security/execution seam

**Status:** implemented, tests passing.

Proof:

- request policy runs before provider invocation
- Modal provider receives credentials from a broker
- credentials do not appear in agent result
- sandbox cleanup path exists

Exit criteria:

```bash
npm test
```

passes with no live provider credentials.

## Gate 0B - Real credentialless Modal CPU execution

Set up:

- Infisical Free project
- `/providers/modal/MODAL_TOKEN_ID`
- `/providers/modal/MODAL_TOKEN_SECRET`
- one read-only Universal Auth machine identity

Run:

```text
python -c "print('hello from credentialless Modal')"
```

Exit criteria:

1. request contains no Modal credential
2. service `.env` contains no Modal credential
3. Modal Sandbox executes
4. output returns to caller
5. Sandbox terminates
6. Modal token never appears in response/logs

## Gate 0C - Real Modal GPU execution

Run `nvidia-smi` on a small supported GPU such as T4.

Exit criteria:

- GPU allocated
- output returned
- execution torn down
- actual provider behavior recorded

## Gate 0.5 - Agent Proxy compatibility experiment

Test whether Infisical Agent Proxy can safely mediate Modal SDK transport in a way that removes plaintext Modal credentials from ordinary execution-worker code.

This is an experiment, not a blocker.

Exit criteria:

- either document a clean working proxy design
- or explicitly reject it and retain small trusted worker boundary

## Gate 1 - Normalize `compute.execute()`

**Status:** implemented, tests passing. Live provider proof pending credentials.

Shipped:

- provider-neutral workload normalization (flat Gate 0 shape and semantic intent shape both accepted)
- in-memory `ExecutionRegistry` with structured `exec_*` IDs
- execution list / status / stop endpoints
- output size limits (`MAX_OUTPUT_BYTES`, default 256 KiB per stream)
- runtime policy as a first-class, pre-credential step (`MAX_TIMEOUT_MS`, `ALLOWED_GPUS`, `ALLOWED_PROVIDERS`)
- Modal refactored toward the `ComputeProvider` adapter shape (`capabilities`, `isConfigured`, stop handle)

Still deferred: durable persistence (records are in-memory), per-workspace budgets.

## Gate 2 - Hugging Face provider

**Status:** adapter implemented, tests passing. Live HF Jobs proof pending an HF token + namespace.

Shipped:

- HTTPS Jobs adapter (`POST /api/jobs/{namespace}`, status polling, logs, cancel)
- GPU class → hardware flavor mapping (T4 → `t4-small`, L4 → `l4x1`, A10G → `a10g-small`, A100 → `a100-large`, H100/H200 → `h200`)
- capability test via `/api/whoami-v2`
- normalized failure classification: 402 → `billing_unavailable`, 401/403 → `auth_invalid`, 429 → `rate_limited`, 5xx/network → `provider_unavailable`, job `ERROR` stage → `execution_error`
- credential broker extended: `HF_TOKEN` via env injection or Infisical `/providers/huggingface`
- `npm run smoke:hf`

Still deferred: artifact collection beyond logs, cost/billing-state awareness.

## Gate 3 - First router behavior

**Status:** implemented, tests passing. The origin incident (HF `402` → Modal continuation) is reproduced deterministically in `test/router.test.js`. Live proof pending credentials.

Behavior:

- deterministic candidate order via `ROUTE_ORDER` (default `huggingface,modal`)
- unconfigured providers are skipped before any credential retrieval
- failover happens only on fallback-eligible classifications (`billing_unavailable`, `auth_invalid`, `provider_unavailable`); `execution_error` stops the chain because the workload itself failed
- the identical normalized workload is passed to every candidate — failover never relaxes budget, runtime, hardware, or provider policy
- provenance: every attempt is an `ExecutionRecord`; fallback attempts carry `parentExecutionId` and `routeReason`, and the execute response includes `route.candidates` / `route.attempts`

Still a deterministic policy, not an optimizer — quotes and scoring arrive in Gate 4.

## Gate 4 - Candidate/quote decision engine

Providers return normalized quotes:

- feasible
- estimated cost
- expected startup time
- expected runtime
- confidence
- rejection reasons

Select best route from connected providers.

## Gate 5 - User-specific economics

Account for:

- prepaid balances
- cloud credits
- committed capacity
- provider subscriptions
- spot/on-demand
- expected retry cost

Define **effective marginal cost** for the user rather than only published price.

## Gate 6 - Execution intelligence

Persist workload fingerprints and observed outcomes.

Start with simple heuristics, not ML theater.

Track:

- provisioning latency
- runtime
- GPU type
- provider/region
- failures
- teardown
- actual spend
- artifact transfer

Use this data to improve estimates.

## Gate 7 - Third provider

Add RunPod, AWS, or another provider selected because it creates a meaningful routing choice, not because a logo grid looks impressive.

At three providers, routing abstractions get stress-tested properly.

## Gate 8 - Agent SDK / MCP surface

Expose the stable gateway API to:

- OpenAI/Codex agents
- Claude
- MCP clients
- custom agent frameworks

Agents still receive only our compute capability.

## Gate 9 - Machine-native payment rails

Only after BYOC routing is valuable, add support for providers/resources that can be bought on demand via:

- MPP
- x402
- cards/payment credentials where appropriate
- later local African payment rails if strategically useful

The payment subsystem should obey the same workload budget/policy model.

## Gate 10 - Router-managed procurement

Much later, consider the magical no-provider-account UX:

```text
user funds gateway / grants payment mandate
agent asks for compute
router procures compute from provider
```

This introduces substantial commercial, contractual, fraud and potentially regulatory complexity. It should not contaminate the BYOC prototype.

## Explicit non-goals until routing works

- polished dashboard
- generic secrets manager
- general SaaS integration platform
- wallet product
- KYA clone
- marketplace
- consumer commerce
- Kubernetes management suite
- persistent PaaS
- GPU-price comparison website

The test is completion, not feature count:

> Can an agent reliably finish a compute task that would otherwise stop because its first execution path failed?
