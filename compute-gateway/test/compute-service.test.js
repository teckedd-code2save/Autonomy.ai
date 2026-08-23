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
  assert.equal(JSON.stringify(result).includes("modal-token"), false);
  assert.deepEqual(seen.credentials, {
    tokenId: "modal-token-id-secret",
    tokenSecret: "modal-token-secret-secret",
  });
  assert.equal(seen.terminated, true);
  assert.equal(seen.closed, true);
});

test("Gate 0 rejects excessive runtime before touching provider", async () => {
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
