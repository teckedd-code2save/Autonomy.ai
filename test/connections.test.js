import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModalProvider } from "../src/providers/modal.js";
import { ConnectionService } from "../src/connection-service.js";
import {
  OverlayCredentialBroker,
  EnvFileSecretStore,
  ConnectionRecordStore,
} from "../src/connections.js";
import { ComputeService } from "../src/compute-service.js";
import { buildServer } from "../src/app.js";

const MODAL_CREDS = { tokenId: "ak-live-id", tokenSecret: "as-live-secret" };

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "acg-test-"));
}

function fakeModalProvider({ overlay, failValidation = false }) {
  return new ModalProvider({
    credentialBroker: overlay,
    appName: "test-app",
    clientFactory: (credentials) => {
      if (failValidation) throw new Error("Modal auth failed: invalid token");
      return {
        apps: { fromName: async () => ({ appId: "app-from-live-check" }) },
        close: () => {},
      };
    },
  });
}

function makeStack({ failValidation = false } = {}) {
  const dir = tmpdir();
  const overlay = new OverlayCredentialBroker(null);
  const providers = new Map([["modal", fakeModalProvider({ overlay, failValidation })]]);
  const secretStore = new EnvFileSecretStore(path.join(dir, ".env"));
  const recordStore = new ConnectionRecordStore(path.join(dir, "connections.json"));
  const connections = new ConnectionService({ providers, secretStore, recordStore, overlayBroker: overlay });
  const compute = new ComputeService({ providers, routeOrder: ["modal"] });
  return { dir, overlay, providers, secretStore, recordStore, connections, compute };
}

// --- ConnectionService ------------------------------------------------------

test("connect validates live, stores secret only in the secret store, activates immediately", async () => {
  const { overlay, connections, recordStore, dir } = makeStack();

  const result = await connections.connect("modal", MODAL_CREDS);

  assert.equal(result.connection.provider, "modal");
  assert.equal(result.connection.status, "active");
  assert.equal(result.connection.account, "app-from-live-check");
  assert.ok(result.connection.credentialRef.startsWith("env:"));

  // Opaque record contains no secret material.
  assert.equal(JSON.stringify(recordStore.list()).includes("as-live-secret"), false);
  assert.equal(JSON.stringify(result).includes("as-live-secret"), false);

  // Secret landed in the env-file store.
  const envText = fs.readFileSync(path.join(dir, ".env"), "utf8");
  assert.match(envText, /MODAL_TOKEN_ID=ak-live-id/);
  assert.match(envText, /MODAL_TOKEN_SECRET=as-live-secret/);

  // Runtime overlay makes the provider configured without a restart.
  assert.equal(overlay.hasModalCredentials(), true);
  assert.deepEqual(await overlay.getModalCredentials(), MODAL_CREDS);
});

test("failed live validation stores nothing and activates nothing", async () => {
  const { overlay, connections, recordStore, dir } = makeStack({ failValidation: true });

  await assert.rejects(
    () => connections.connect("modal", MODAL_CREDS),
    /credential validation failed/,
  );

  assert.equal(recordStore.list().length, 0);
  assert.equal(fs.existsSync(path.join(dir, ".env")), false);
  assert.equal(overlay.hasModalCredentials(), false);
});

test("connect rejects incomplete credentials before any provider call", async () => {
  const { connections } = makeStack();

  await assert.rejects(() => connections.connect("modal", { tokenId: "ak-only" }), /tokenSecret/);
  await assert.rejects(() => connections.connect("runpod", MODAL_CREDS), /unknown provider/);
});

test("disconnect clears overlay, secret store, and record", async () => {
  const { overlay, connections, recordStore, dir } = makeStack();
  await connections.connect("modal", MODAL_CREDS);

  const result = await connections.disconnect("modal");

  assert.equal(result.disconnected, true);
  assert.equal(overlay.hasModalCredentials(), false);
  assert.equal(recordStore.list().length, 0);
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8").includes("MODAL_TOKEN"), false);
});

test("env-file store updates values in place without duplicating lines", async () => {
  const dir = tmpdir();
  const store = new EnvFileSecretStore(path.join(dir, ".env"));

  await store.set("modal", { tokenId: "ak-one", tokenSecret: "as-one" });
  await store.set("modal", { tokenId: "ak-two", tokenSecret: "as-two" });

  const text = fs.readFileSync(path.join(dir, ".env"), "utf8");
  assert.equal(text.match(/MODAL_TOKEN_ID=/g).length, 1);
  assert.match(text, /MODAL_TOKEN_ID=ak-two/);
});

// --- HTTP auth boundary -------------------------------------------------------

async function withServer(stack, fn) {
  const server = buildServer({
    config: {
      agentApiKey: "agent-key",
      operatorApiKey: "operator-key",
      policy: {},
      routeOrder: ["modal"],
    },
    compute: stack.compute,
    connections: stack.connections,
    providers: stack.providers,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base, p, key, body) => fetch(`${base}${p}`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify(body),
});

test("agent key can never reach the connection API", async () => {
  const stack = makeStack();
  await withServer(stack, async (base) => {
    const res = await post(base, "/v1/connections/modal", "agent-key", MODAL_CREDS);
    assert.equal(res.status, 401);

    const list = await fetch(`${base}/v1/connections`, {
      headers: { authorization: "Bearer agent-key" },
    });
    assert.equal(list.status, 401);
  });
});

test("operator key can never reach the agent compute API", async () => {
  const stack = makeStack();
  await withServer(stack, async (base) => {
    const res = await post(base, "/v1/compute/execute", "operator-key", { command: ["echo", "hi"] });
    assert.equal(res.status, 401);
  });
});

test("operator connect flow works over HTTP and makes the provider routable", async () => {
  const stack = makeStack();
  await withServer(stack, async (base) => {
    // Before connecting, the provider is not configured.
    const before = await (await fetch(`${base}/v1/providers`, {
      headers: { authorization: "Bearer agent-key" },
    })).json();
    assert.equal(before.providers[0].configured, false);

    const res = await post(base, "/v1/connections/modal", "operator-key", MODAL_CREDS);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.connection.status, "active");

    // After connecting, the agent-visible provider list shows it configured.
    const after = await (await fetch(`${base}/v1/providers`, {
      headers: { authorization: "Bearer agent-key" },
    })).json();
    assert.equal(after.providers[0].configured, true);

    // The connection list never contains secret material.
    const list = await (await fetch(`${base}/v1/connections`, {
      headers: { authorization: "Bearer operator-key" },
    })).json();
    assert.equal(JSON.stringify(list).includes("as-live-secret"), false);
  });
});

test("failed validation over HTTP returns 422 and stores nothing", async () => {
  const stack = makeStack({ failValidation: true });
  await withServer(stack, async (base) => {
    const res = await post(base, "/v1/connections/modal", "operator-key", MODAL_CREDS);
    assert.equal(res.status, 422);
    assert.equal(stack.recordStore.list().length, 0);
  });
});

test("operator surface is disabled when OPERATOR_API_KEY is not configured", async () => {
  const stack = makeStack();
  const server = buildServer({
    config: { agentApiKey: "agent-key", operatorApiKey: undefined, policy: {} },
    compute: stack.compute,
    connections: stack.connections,
    providers: stack.providers,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  try {
    const res = await post(base, "/v1/connections/modal", "anything", MODAL_CREDS);
    assert.equal(res.status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("connect page serves and contains no secrets", async () => {
  const stack = makeStack();
  await withServer(stack, async (base) => {
    const res = await fetch(`${base}/connect`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Connect a compute provider/);
    assert.equal(html.includes("operator-key"), false);
    assert.equal(html.includes("agent-key"), false);
  });
});

test("capabilities manifest describes the agent surface", async () => {
  const stack = makeStack();
  await withServer(stack, async (base) => {
    const res = await fetch(`${base}/v1/capabilities`, {
      headers: { authorization: "Bearer agent-key" },
    });
    assert.equal(res.status, 200);
    const manifest = await res.json();
    assert.equal(manifest.endpoints.execute.path, "/v1/compute/execute");
    assert.deepEqual(manifest.failover.eligibleFailures, [
      "billing_unavailable", "auth_invalid", "provider_unavailable",
    ]);
    assert.ok(manifest.limits.maxTimeoutMs > 0);
  });
});
