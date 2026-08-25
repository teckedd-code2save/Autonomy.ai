import test from "node:test";
import assert from "node:assert/strict";
import { HuggingFaceProvider } from "../src/providers/huggingface.js";
import { FailureCode } from "../src/failures.js";

const HF_TOKEN = "hf_secret_token_value";

function makeBroker(token = HF_TOKEN) {
  return {
    hasHuggingFaceCredentials: () => Boolean(token),
    async getHuggingFaceCredentials() {
      if (!token) throw new Error("Hugging Face credentials are incomplete");
      return { token };
    },
  };
}

function makeProvider(calls, token = HF_TOKEN) {
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? "GET", headers: options.headers, body: options.body });
    const responder = calls.responder ?? defaultResponder;
    return responder(url, options, calls);
  };
  return new HuggingFaceProvider({
    credentialBroker: makeBroker(token),
    namespace: "acme-agents",
    fetchImpl,
    pollIntervalMs: 1,
  });
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const okText = (body) => ({ ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body });
const err = (status, body = "") => ({ ok: false, status, text: async () => body });

function defaultResponder(url) {
  if (url.endsWith("/api/jobs/acme-agents")) {
    return okJson({ id: "job-123", status: { stage: "RUNNING" } });
  }
  if (url.endsWith("/api/jobs/acme-agents/job-123/logs")) {
    return okText("hello from hf jobs\n");
  }
  if (url.endsWith("/api/jobs/acme-agents/job-123")) {
    return okJson({ id: "job-123", status: { stage: "COMPLETED", message: null } });
  }
  throw new Error(`unexpected url: ${url}`);
}

test("HF job executes end to end and credentials never appear in the result", async () => {
  const calls = [];
  const provider = makeProvider(calls);

  const result = await provider.execute({
    image: "python:3.13-slim",
    command: ["python", "-c", "print('hello from hf jobs')"],
    timeoutMs: 30_000,
  });

  assert.equal(result.provider, "huggingface");
  assert.equal(result.status, "succeeded");
  assert.equal(result.executionId, "job-123");
  assert.equal(result.stdout, "hello from hf jobs\n");
  assert.equal(JSON.stringify(result).includes(HF_TOKEN), false);

  const create = calls[0];
  assert.equal(create.method, "POST");
  assert.equal(create.headers.authorization, `Bearer ${HF_TOKEN}`);
  const spec = JSON.parse(create.body);
  assert.equal(spec.dockerImage, "python:3.13-slim");
  assert.deepEqual(spec.command, ["python", "-c", "print('hello from hf jobs')"]);
  assert.equal(spec.flavor, "cpu-basic");
  assert.equal(spec.timeoutSeconds, 30);
});

test("GPU workload maps to the matching HF hardware flavor", async () => {
  const calls = [];
  const provider = makeProvider(calls);

  await provider.execute({ image: "img", command: ["nvidia-smi"], gpu: "T4", timeoutMs: 30_000 });

  const spec = JSON.parse(calls[0].body);
  assert.equal(spec.flavor, "t4-small");
});

test("HTTP 402 classifies as billing_unavailable and is fallback-eligible", async () => {
  const calls = [];
  calls.responder = () => err(402, "Payment Required: no balance");
  const provider = makeProvider(calls);

  const failure = await provider
    .execute({ image: "img", command: ["echo", "hi"], timeoutMs: 30_000 })
    .catch((e) => e);

  assert.equal(failure.name, "ProviderError");
  assert.equal(failure.code, FailureCode.BILLING_UNAVAILABLE);
  assert.equal(failure.fallbackEligible, true);
  assert.equal(JSON.stringify({ code: failure.code }).includes(HF_TOKEN), false);
});

test("job reaching ERROR stage classifies as execution_error and is NOT fallback-eligible", async () => {
  const calls = [];
  calls.responder = (url) => {
    if (url.endsWith("/api/jobs/acme-agents")) return okJson({ id: "job-9", status: { stage: "RUNNING" } });
    if (url.endsWith("/api/jobs/acme-agents/job-9/logs")) return okText("Traceback: boom\n");
    if (url.endsWith("/api/jobs/acme-agents/job-9")) {
      return okJson({ id: "job-9", status: { stage: "ERROR", message: "exit code 1" } });
    }
    throw new Error(`unexpected url: ${url}`);
  };
  const provider = makeProvider(calls);

  const failure = await provider
    .execute({ image: "img", command: ["python", "broken.py"], timeoutMs: 30_000 })
    .catch((e) => e);

  assert.equal(failure.code, FailureCode.EXECUTION_ERROR);
  assert.equal(failure.fallbackEligible, false);
});

test("401 classifies as auth_invalid and is fallback-eligible", async () => {
  const calls = [];
  calls.responder = () => err(401, "Invalid username or password");
  const provider = makeProvider(calls);

  const failure = await provider
    .execute({ image: "img", command: ["echo", "hi"], timeoutMs: 30_000 })
    .catch((e) => e);

  assert.equal(failure.code, FailureCode.AUTH_INVALID);
  assert.equal(failure.fallbackEligible, true);
});

test("network failure classifies as provider_unavailable and is fallback-eligible", async () => {
  const calls = [];
  calls.responder = () => { throw new Error("socket hang up"); };
  const provider = makeProvider(calls);

  const failure = await provider
    .execute({ image: "img", command: ["echo", "hi"], timeoutMs: 30_000 })
    .catch((e) => e);

  assert.equal(failure.code, FailureCode.PROVIDER_UNAVAILABLE);
  assert.equal(failure.fallbackEligible, true);
});

test("missing HF credential is a classified auth failure, not a raw error", async () => {
  const calls = [];
  const provider = makeProvider(calls, null);

  const failure = await provider
    .execute({ image: "img", command: ["echo", "hi"], timeoutMs: 30_000 })
    .catch((e) => e);

  assert.equal(failure.code, FailureCode.AUTH_INVALID);
  assert.equal(failure.fallbackEligible, true);
  assert.equal(calls.length, 0); // never touched the network
});

test("missing namespace is rejected before any request", async () => {
  const calls = [];
  const provider = new HuggingFaceProvider({
    credentialBroker: makeBroker(),
    namespace: undefined,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return okJson({}); },
  });

  const failure = await provider
    .execute({ image: "img", command: ["echo", "hi"], timeoutMs: 30_000 })
    .catch((e) => e);

  assert.equal(failure.code, FailureCode.AUTH_INVALID);
  assert.equal(calls.length, 0);
});

test("stop cancels the remote job", async () => {
  const calls = [];
  calls.responder = (url, options) => {
    if (url.endsWith("/cancel")) return okJson({});
    return defaultResponder(url, options);
  };
  const provider = makeProvider(calls);

  await provider.stop("job-123");

  const cancel = calls.find((c) => c.url.endsWith("/cancel"));
  assert.equal(cancel.method, "POST");
  assert.equal(cancel.headers.authorization, `Bearer ${HF_TOKEN}`);
});

test("testConnection proves access without returning the token", async () => {
  const calls = [];
  calls.responder = (url) => {
    if (url.endsWith("/api/whoami-v2")) return okJson({ name: "acme-agents", type: "user" });
    throw new Error(`unexpected url: ${url}`);
  };
  const provider = makeProvider(calls);

  const result = await provider.testConnection();

  assert.deepEqual(result, { provider: "huggingface", connected: true, account: "acme-agents" });
  assert.equal(JSON.stringify(result).includes(HF_TOKEN), false);
});

test("onHandle exposes provider execution id and a stop hook", async () => {
  const calls = [];
  calls.responder = (url) => {
    if (url.endsWith("/cancel")) return okJson({});
    return defaultResponder(url);
  };
  const provider = makeProvider(calls);

  let handle;
  await provider.execute(
    { image: "img", command: ["echo", "hi"], timeoutMs: 30_000 },
    { onHandle: (h) => { handle = h; } },
  );

  assert.equal(handle.providerExecutionId, "job-123");
  await handle.stop();
  assert.ok(calls.some((c) => c.url.endsWith("/job-123/cancel")));
});
