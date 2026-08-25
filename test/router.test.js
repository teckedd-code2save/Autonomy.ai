import test from "node:test";
import assert from "node:assert/strict";
import { ComputeService } from "../src/compute-service.js";
import { ExecutionRegistry } from "../src/execution-registry.js";
import { FailureCode, ProviderError } from "../src/failures.js";

function fakeProvider(id, behavior) {
  return {
    id,
    isConfigured: () => behavior.configured !== false,
    calls: [],
    async execute(workload, context) {
      this.calls.push({ workload, context });
      if (behavior.handle) context?.onHandle?.(behavior.handle);
      if (behavior.error) throw behavior.error;
      return {
        provider: id,
        status: "succeeded",
        executionId: `${id}-exec-1`,
        stdout: behavior.stdout ?? `hello from ${id}\n`,
        stderr: "",
      };
    },
  };
}

const billingFailure = () => new ProviderError({
  provider: "huggingface",
  code: FailureCode.BILLING_UNAVAILABLE,
  message: "402 Payment Required",
});

// --- Gate 3: the origin incident, reproduced -------------------------------

test("HF billing 402 fails over to Modal and the workload completes", async () => {
  const hf = fakeProvider("huggingface", { error: billingFailure() });
  const modal = fakeProvider("modal", {});
  const compute = new ComputeService({
    providers: new Map([["huggingface", hf], ["modal", modal]]),
    routeOrder: ["huggingface", "modal"],
  });

  const result = await compute.execute({
    command: ["python", "-c", "print('hello')"],
    timeoutMs: 30_000,
  });

  // The agent's task finished despite HF being unable to run it.
  assert.equal(result.provider, "modal");
  assert.equal(result.stdout, "hello from modal\n");

  // Provenance: both attempts are visible, in order, with classification.
  assert.deepEqual(result.route.candidates, ["huggingface", "modal"]);
  assert.equal(result.route.attempts.length, 2);
  assert.equal(result.route.attempts[0].provider, "huggingface");
  assert.equal(result.route.attempts[0].failureCode, FailureCode.BILLING_UNAVAILABLE);
  assert.equal(result.route.attempts[1].provider, "modal");
  assert.equal(result.route.attempts[1].status, "succeeded");

  // The identical workload was passed to the fallback — nothing relaxed.
  assert.deepEqual(modal.calls[0].workload.command, hf.calls[0].workload.command);
  assert.equal(modal.calls[0].workload.timeoutMs, 30_000);

  // Failover provenance is recorded in the registry.
  const parent = compute.getExecution(result.route.attempts[0].executionId);
  const child = compute.getExecution(result.route.attempts[1].executionId);
  assert.equal(parent.status, "failed");
  assert.equal(parent.failureCode, FailureCode.BILLING_UNAVAILABLE);
  assert.equal(child.parentExecutionId, parent.id);
  assert.equal(child.status, "succeeded");
});

test("auth failure on HF also fails over to Modal", async () => {
  const hf = fakeProvider("huggingface", {
    error: new ProviderError({ provider: "huggingface", code: FailureCode.AUTH_INVALID, message: "bad token" }),
  });
  const modal = fakeProvider("modal", {});
  const compute = new ComputeService({
    providers: new Map([["huggingface", hf], ["modal", modal]]),
    routeOrder: ["huggingface", "modal"],
  });

  const result = await compute.execute({ command: ["echo", "hi"], timeoutMs: 30_000 });
  assert.equal(result.provider, "modal");
});

test("workload-level failure does NOT fall back to another provider", async () => {
  const hf = fakeProvider("huggingface", {
    error: new ProviderError({ provider: "huggingface", code: FailureCode.EXECUTION_ERROR, message: "exit code 1" }),
  });
  const modal = fakeProvider("modal", {});
  const compute = new ComputeService({
    providers: new Map([["huggingface", hf], ["modal", modal]]),
    routeOrder: ["huggingface", "modal"],
  });

  const failure = await compute.execute({ command: ["python", "broken.py"], timeoutMs: 30_000 }).catch((e) => e);

  assert.equal(failure.name, "RoutingError");
  assert.equal(modal.calls.length, 0); // never retried the broken workload
  assert.equal(failure.attempts.length, 1);
});

test("explicit provider selection bypasses the fallback chain", async () => {
  const hf = fakeProvider("huggingface", { error: billingFailure() });
  const modal = fakeProvider("modal", {});
  const compute = new ComputeService({
    providers: new Map([["huggingface", hf], ["modal", modal]]),
    routeOrder: ["huggingface", "modal"],
  });

  const result = await compute.execute({ command: ["echo", "hi"], provider: "modal", timeoutMs: 30_000 });

  assert.equal(result.provider, "modal");
  assert.equal(hf.calls.length, 0);
});

test("unconfigured providers are skipped in the candidate set", async () => {
  const hf = fakeProvider("huggingface", { configured: false });
  const modal = fakeProvider("modal", {});
  const compute = new ComputeService({
    providers: new Map([["huggingface", hf], ["modal", modal]]),
    routeOrder: ["huggingface", "modal"],
  });

  const result = await compute.execute({ command: ["echo", "hi"], timeoutMs: 30_000 });

  assert.equal(result.provider, "modal");
  assert.equal(hf.calls.length, 0);
  assert.deepEqual(result.route.candidates, ["modal"]);
});

test("all routes failing surfaces a sanitized RoutingError", async () => {
  const hf = fakeProvider("huggingface", { error: billingFailure() });
  const modal = fakeProvider("modal", {
    error: new ProviderError({ provider: "modal", code: FailureCode.PROVIDER_UNAVAILABLE, message: "capacity" }),
  });
  const compute = new ComputeService({
    providers: new Map([["huggingface", hf], ["modal", modal]]),
    routeOrder: ["huggingface", "modal"],
  });

  const failure = await compute.execute({ command: ["echo", "hi"], timeoutMs: 30_000 }).catch((e) => e);

  assert.equal(failure.name, "RoutingError");
  assert.equal(failure.attempts.length, 2);
  assert.equal(failure.message.includes("402"), false); // classification codes only
  assert.match(failure.message, /billing_unavailable/);
  assert.match(failure.message, /provider_unavailable/);
});

test("no connected provider fails before any execution", async () => {
  const compute = new ComputeService({
    providers: new Map(),
    routeOrder: ["huggingface", "modal"],
  });

  await assert.rejects(
    () => compute.execute({ command: ["echo", "hi"] }),
    /no compute provider is connected/,
  );
});

// --- Gate 1: registry lifecycle ---------------------------------------------

test("execution registry tracks lifecycle and stop", async () => {
  const registry = new ExecutionRegistry();
  const record = registry.create({ workload: { kind: "batch", image: "img", command: ["true"], timeoutMs: 1000 } });

  assert.equal(record.status, "queued");
  registry.transition(record.id, "running", { providerExecutionId: "sb-1" });
  assert.ok(registry.get(record.id).startedAt);

  let stopped = false;
  registry.registerStopHandle(record.id, async () => { stopped = true; });
  const after = await registry.stop(record.id);

  assert.equal(stopped, true);
  assert.equal(after.status, "stopped");
  assert.ok(after.finishedAt);

  // Terminal records cannot be resurrected.
  registry.transition(record.id, "succeeded");
  assert.equal(registry.get(record.id).status, "stopped");
});

test("stop endpoint stops a running provider handle through the service", async () => {
  let stopCalled = false;
  const modal = fakeProvider("modal", {
    handle: { providerExecutionId: "sb-77", stop: async () => { stopCalled = true; } },
  });
  const compute = new ComputeService({
    providers: new Map([["modal", modal]]),
    routeOrder: ["modal"],
  });

  const result = await compute.execute({ command: ["echo", "hi"], timeoutMs: 30_000 });
  const record = compute.getExecution(result.executionId);

  assert.equal(record.providerExecutionId, "sb-77");
  // Execution already finished; stop on a terminal record is a no-op.
  const stopped = await compute.stopExecution(result.executionId);
  assert.equal(stopped.status, "succeeded");
});
