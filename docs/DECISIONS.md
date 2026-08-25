# Architecture and Product Decisions

This file records the decisions that shaped Gate 0 so the rationale does not disappear as the code gets cleaner.

## D001 - The product is not an agent wallet

**Decision:** Do not build generic delegated payments as the primary product.

**Why:** ACP/MPP/x402 and agent-wallet infrastructure are moving quickly. Crossmint, Nevermined, AWS AgentCore Payments, Skyfire and others already provide substantial spending primitives.

**Keep:** MPP/x402 remain future payment rails when the router needs to purchase compute from machine-native services.

---

## D002 - Focus on compute continuity

**Decision:** Optimize for "finish this compute task" rather than "pay this merchant."

**Why:** The original HF `402` failure was valuable because the task could potentially have continued on another provider. Compute routing/fallback is a stronger product wedge than payment alone.

---

## D003 - Credentials are a separate wall from payments

**Decision:** Treat provider authentication/credentials as an independent control plane.

**Why:** An agent can have money and still be unable to use Modal because it lacks Modal credentials. Conversely it can have Modal credentials and no budget policy. Both problems need distinct abstractions.

---

## D004 - Agents get capabilities, never raw provider credentials

**Decision:** No agent-facing `getCredential`, `getSecret`, or provider-token operation.

**Why:** Provider secrets are standing authority. The gateway should let agents consume the capability without inheriting that authority.

---

## D005 - KYA is optional infrastructure, not Gate 0

**Decision:** Do not depend on Skyfire KYA or another external agent-identity system initially.

**Why:** Gate 0 only needs caller authentication + policy + provider execution. External identity/mandate systems can be adapters later.

---

## D006 - Composio is not used for Modal Gate 0

**Decision:** Drop Composio from the Modal prototype.

**Why:** Composio's connected-account and proxy model is excellent for authenticated HTTP/tool calls. Modal's primary automation interface is the Modal SDK using `tokenId` + `tokenSecret`. Forcing Modal through a custom Composio relay would add another hop without eliminating our need for trusted Modal execution code.

**What we keep from Composio:** the UX principle of connect once, expose capability, hide credentials.

---

## D007 - Use Infisical Free as the first credential broker

**Decision:** Store Modal credentials in Infisical and retrieve them with a machine identity.

**Why:** It directly matches the SDK credential-use case and avoids building a secret manager. The current Free plan is enough for Gate 0.

**Constraint:** Keep Infisical behind `CredentialBroker` semantics so it can be replaced.

---

## D008 - Do not create an Infisical identity per end-user agent

**Decision:** Our system owns users and agents. Infisical owns infrastructure secret access for execution services.

**Why:** Cleaner security boundary and better cost model. Secret-manager identity count should not scale 1:1 with product agents.

---

## D009 - Start with explicit secret retrieval, then test Agent Proxy

**Decision:** Do not block Gate 0 on proxy compatibility.

**Why:** A basic Modal SDK call with late Infisical retrieval proves the product invariant. Agent Proxy is a hardening experiment after the first real execution succeeds.

---

## D010 - Modal first

**Decision:** Modal is provider #1.

**Why:** It is the real alternative compute account that motivated the credential question, and its Sandbox API gives a clean short-lived execution primitive.

---

## D011 - No routing engine in Gate 0

**Decision:** `ComputeService` always chooses Modal for now.

**Why:** Routing before proving secure execution would create abstractions on top of an unproven foundation.

---

## D012 - Hugging Face is provider #2

**Decision:** Add Hugging Face only after real Modal CPU + GPU success.

**Why:** It allows us to recreate the origin story as the first routing demonstration: HF cannot execute -> Modal fallback -> task continues.

---

## D013 - Optimize effective cost, not published hourly rate

**Decision:** Future routing should understand the user's actual economic state.

**Examples:**

- AWS may have a higher listed rate but be effectively free because the user has startup credits.
- Modal may be more expensive per GPU-hour but cheaper for an interactive task because of startup/runtime behavior.
- A nominally cheap provider may have poor capacity and a higher expected failure cost.

---

## D014 - Build data from executions

**Decision:** Persist routing inputs and actual outcomes once routing begins.

**Why:** Historical cost-to-completion, startup time, failure rate and throughput may become more valuable than static provider pricing.

---

## D015 - Working name, not final brand

**Decision:** "Agent Compute Gateway" / "Compute Gateway" is a product/category description for now.

**Why:** `ComputeRouter.ai` already exists, and naming should wait until the execution thesis is validated.

---

## D016 - Deterministic fallback router before any optimizer

**Decision:** Gate 3 routing is a fixed-order failover chain (`ROUTE_ORDER`, default `huggingface,modal`) driven only by normalized failure classifications.

**Why:** The product's first promise is completion, not optimization. A `402`/unavailable/auth failure means the route never really ran, so continuing on the next candidate is safe. An `execution_error` means the workload itself failed, so the chain stops — retrying it elsewhere would burn budget to repeat the same failure.

**Invariant:** failover passes the identical normalized workload to every candidate. Budget, runtime limit, required hardware, and provider policy are never silently relaxed.

**Replaces:** D011 ("no routing engine in Gate 0") — routing is allowed now that secure execution and failure classification exist.
