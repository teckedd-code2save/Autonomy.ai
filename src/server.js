import http from "node:http";
import crypto from "node:crypto";
import { loadConfig } from "./config.js";
import { createCredentialBroker } from "./credential-broker.js";
import { ModalProvider } from "./providers/modal.js";
import { HuggingFaceProvider } from "./providers/huggingface.js";
import { ComputeService } from "./compute-service.js";
import { PolicyViolation, ValidationError } from "./model.js";
import { isProviderError } from "./failures.js";

const config = loadConfig();
const credentialBroker = createCredentialBroker({
  env: process.env,
  infisicalConfig: config.infisical,
});
const modalProvider = new ModalProvider({
  credentialBroker,
  appName: config.modal.appName,
});
const huggingFaceProvider = new HuggingFaceProvider({
  credentialBroker,
  namespace: config.huggingface.namespace,
  endpoint: config.huggingface.endpoint,
});

const providers = new Map([
  ["modal", modalProvider],
  ["huggingface", huggingFaceProvider],
]);

const compute = new ComputeService({
  providers,
  routeOrder: config.routeOrder,
  policy: config.policy,
});

const providerTests = {
  modal: () => modalProvider.testConnection(),
  huggingface: () => huggingFaceProvider.testConnection(),
};

function secureEqual(a, b) {
  const aa = Buffer.from(a ?? "");
  const bb = Buffer.from(b ?? "");
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > 64 * 1024) throw new ValidationError("request too large");
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new ValidationError("request body must be valid JSON");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (path === "/health" && req.method === "GET") {
      return json(res, 200, { ok: true });
    }

    const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!secureEqual(auth, config.agentApiKey)) {
      return json(res, 401, { error: "unauthorized" });
    }

    if (path === "/v1/providers" && req.method === "GET") {
      return json(res, 200, { providers: compute.listProviders() });
    }

    const providerTest = path.match(/^\/v1\/providers\/([a-z0-9-]+)\/test$/);
    if (providerTest && req.method === "POST") {
      const test = providerTests[providerTest[1]];
      if (!test) return json(res, 404, { error: "not_found" });
      return json(res, 200, await test());
    }

    if (path === "/v1/compute/execute" && req.method === "POST") {
      const workload = await readJson(req);
      return json(res, 200, await compute.execute(workload));
    }

    if (path === "/v1/compute/executions" && req.method === "GET") {
      return json(res, 200, { executions: compute.listExecutions() });
    }

    const executionMatch = path.match(/^\/v1\/compute\/executions\/(exec_[a-z0-9]+_[a-f0-9]+)(\/stop)?$/);
    if (executionMatch) {
      const [, id, stopSuffix] = executionMatch;

      if (!stopSuffix && req.method === "GET") {
        const record = compute.getExecution(id);
        if (!record) return json(res, 404, { error: "not_found" });
        return json(res, 200, record);
      }

      if (stopSuffix && req.method === "POST") {
        const record = await compute.stopExecution(id);
        if (!record) return json(res, 404, { error: "not_found" });
        return json(res, 200, record);
      }
    }

    return json(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof ValidationError || error instanceof PolicyViolation) {
      return json(res, error instanceof PolicyViolation ? 403 : 400, { error: error.message });
    }

    if (error?.name === "RoutingError") {
      // Sanitized: failure codes and provider names only, never raw SDK errors.
      console.error("all routes failed", { attempts: error.attempts });
      return json(res, 502, { error: error.code, attempts: error.attempts });
    }

    if (isProviderError(error)) {
      console.error("provider call failed", {
        provider: error.provider,
        code: error.code,
        statusCode: error.statusCode,
      });
      return json(res, 502, { error: error.code, provider: error.provider });
    }

    // Never serialize arbitrary provider errors. Provider SDK errors can contain
    // request context that should not become an agent-visible side channel.
    console.error("execution failed", {
      name: error?.name,
      message: error?.message,
    });
    return json(res, 500, { error: "execution_failed" });
  }
});

server.listen(config.port, () => {
  console.log(`agent compute gateway listening on :${config.port}`);
});
