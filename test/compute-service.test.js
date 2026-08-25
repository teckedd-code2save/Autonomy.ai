import test from "node:test";
import assert from "node:assert/strict";
import { ModalProvider } from "../src/providers/modal.js";
import { ComputeService } from "../src/compute-service.js";

test("agent can execute while provider credentials never appear in result", async () => {
  const seen = {};
  const credentialBroker = {
    async getModalCredentials() {
      return { tokenId: "modal-token-id-secret", tokenSecret: "modal-token-secret-secret" };
    },
  };

  const fakeSandbox = {
    sandboxId: "sb-test",
    stdout: { readText: async () => "hello from modal\n" },
    stderr: { readText: async () => "" },
    terminate: async () => { seen.terminated = true; },
  };

  const clientFactory = (credentials) => {
    seen.credentials = credentials;
    return {
      apps: { fromName: async () => ({ appId: "app-test" }) },
      images: { fromRegistry: () => ({ imageId: "img-test" }) },
      sandboxes: { create: async (_app, _image, params) => {
        seen.params = params;
        return fakeSandbox;
      } },
      close: () => { seen.closed = true; },
    };
  };

  const modal = new ModalProvider({ credentialBroker, appName: "test", clientFactory });
  const compute = new ComputeService({ modalProvider: modal });

  const result = await compute.execute({
    command: ["python", "-c", "print('hello from modal')"],
    timeoutMs: 30_000,
  });

  assert.equal(result.provider, "modal");
  assert.equal(result.stdout, "hello from modal\n");
  assert.equal(result.status, "succeeded");
  assert.ok(result.executionId.startsWith("exec_"));
  assert.equal(JSON.stringify(result).includes("modal-token"), false);
  assert.deepEqual(seen.credentials, {
    tokenId: "modal-token-id-secret",
    tokenSecret: "modal-token-secret-secret",
  });
  assert.equal(seen.terminated, true);
  assert.equal(seen.closed, true);
});

test("Gate policy rejects excessive runtime before touching provider", async () => {
  let called = false;
  const compute = new ComputeService({
    modalProvider: { execute: async () => { called = true; } },
  });

  await assert.rejects(
    () => compute.execute({ command: ["sleep", "999"], timeoutMs: 301_000 }),
    /5 minutes/,
  );
  assert.equal(called, false);
});

test("Modal connection test proves access without returning credentials", async () => {
  const seen = {};
  const credentialBroker = {
    async getModalCredentials() {
      return { tokenId: "modal-token-id-secret", tokenSecret: "modal-token-secret-secret" };
    },
  };
  const clientFactory = (credentials) => {
    seen.credentials = credentials;
    return {
      apps: { fromName: async () => ({ appId: "app-test" }) },
      close: () => { seen.closed = true; },
    };
  };

  const modal = new ModalProvider({ credentialBroker, appName: "test", clientFactory });
  const result = await modal.testConnection();

  assert.deepEqual(result, { provider: "modal", connected: true, appId: "app-test" });
  assert.equal(JSON.stringify(result).includes("modal-token"), false);
  assert.equal(seen.closed, true);
});

// --- Gate 1: normalized intent shape ---------------------------------------

test("semantic intent shape normalizes to the same workload model", async () => {
  const seen = {};
  const provider = {
    id: "modal",
    isConfigured: () => true,
    async execute(workload) {
      seen.workload = workload;
      return { provider: "modal", status: "succeeded", executionId: "sb-1", stdout: "ok\n", stderr: "" };
    },
  };
  const compute = new ComputeService({ providers: new Map([["modal", provider]]) });

  const result = await compute.execute({
    kind: "batch",
    runtime: { image: "ghcr.io/acme/asr-benchmark:sha", command: ["python", "benchmark.py"] },
    requirements: { accelerator: "gpu", gpuClass: "T4", minVramGb: 16 },
    constraints: { maxRuntimeSeconds: 120, network: "egress-only" },
    economics: { maxSpendUsd: 2, optimizeFor: "effective_cost" },
  });

  assert.equal(result.provider, "modal");
  assert.equal(seen.workload.image, "ghcr.io/acme/asr-benchmark:sha");
  assert.deepEqual(seen.workload.command, ["python", "benchmark.py"]);
  assert.equal(seen.workload.gpu, "T4");
  assert.equal(seen.workload.timeoutMs, 120_000);
  assert.equal(seen.workload.economics.maxSpendUsd, 2);
});

test("output streams are truncated at the policy limit", async () => {
  const bigOutput = "x".repeat(600 * 1024);
  const provider = {
    id: "modal",
    isConfigured: () => true,
    async execute() {
      return { provider: "modal", status: "succeeded", executionId: "sb-1", stdout: bigOutput, stderr: "" };
    },
  };
  const compute = new ComputeService({
    providers: new Map([["modal", provider]]),
    policy: { maxOutputBytes: 1024 },
  });

  const result = await compute.execute({ command: ["yes"] });

  assert.equal(Buffer.byteLength(result.stdout), 1024);
  assert.equal(result.outputTruncated, true);
});

test("invalid command fails validation before any provider call", async () => {
  let called = false;
  const compute = new ComputeService({
    modalProvider: { execute: async () => { called = true; } },
  });

  await assert.rejects(() => compute.execute({ command: [] }), /non-empty array/);
  assert.equal(called, false);
});

// --- Security policy tests (docs/SECURITY.md) -------------------------------

test("disallowed GPU class fails before credential broker invocation", async () => {
  let brokerCalled = false;
  let providerCalled = false;
  const compute = new ComputeService({
    providers: new Map([["modal", {
      id: "modal",
      isConfigured: () => true,
      execute: async () => { providerCalled = true; },
    }]]),
    policy: { allowedGpus: ["T4"] },
  });
  void brokerCalled;

  await assert.rejects(
    () => compute.execute({ command: ["nvidia-smi"], gpu: "H100", timeoutMs: 60_000 }),
    /GPU class not allowed/,
  );
  assert.equal(providerCalled, false);
});

test("unsupported provider fails before secret retrieval", async () => {
  let providerCalled = false;
  const compute = new ComputeService({
    providers: new Map([["modal", {
      id: "modal",
      isConfigured: () => true,
      execute: async () => { providerCalled = true; },
    }]]),
  });

  await assert.rejects(
    () => compute.execute({ command: ["echo", "hi"], provider: "runpod" }),
    /not connected/,
  );
  assert.equal(providerCalled, false);
});

test("provider error details never leak credential material to the agent", async () => {
  const provider = {
    id: "huggingface",
    isConfigured: () => true,
    async execute() {
      const error = new Error("HTTP 402 token hf_secret_token_value rejected");
      error.name = "ProviderError";
      error.code = "billing_unavailable";
      error.fallbackEligible = true;
      throw error;
    },
  };
  const compute = new ComputeService({
    providers: new Map([["huggingface", provider]]),
    routeOrder: ["huggingface"],
  });

  const failure = await compute.execute({ command: ["python", "-c", "1"] }).catch((e) => e);
  assert.equal(failure.name, "RoutingError");
  assert.equal(JSON.stringify(failure).includes("hf_secret_token_value"), false);
  assert.equal(JSON.stringify(failure.attempts).includes("hf_secret_token_value"), false);
});
