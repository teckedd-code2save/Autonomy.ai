import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { loadConfig } from "./config.js";
import { createCredentialBroker } from "./credential-broker.js";
import { ModalProvider } from "./providers/modal.js";
import { HuggingFaceProvider } from "./providers/huggingface.js";
import { ComputeService } from "./compute-service.js";
import { PolicyViolation, ValidationError, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MAX_OUTPUT_BYTES } from "./model.js";
import { isProviderError } from "./failures.js";
import {
  OverlayCredentialBroker,
  EnvFileSecretStore,
  InfisicalSecretStore,
  ConnectionRecordStore,
} from "./connections.js";
import { ConnectionService } from "./connection-service.js";
import { connectPage } from "./connect-page.js";

export function createGateway({ config = loadConfig(), env = process.env } = {}) {
  const broker = createCredentialBroker({ env, infisicalConfig: config.infisical });
  const overlayBroker = new OverlayCredentialBroker(broker);

  const modalProvider = new ModalProvider({
    credentialBroker: overlayBroker,
    appName: config.modal.appName,
  });
  const huggingFaceProvider = new HuggingFaceProvider({
    credentialBroker: overlayBroker,
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

  // Secret store: Infisical in production, local .env in dev.
  const secretStore = (config.infisical.clientId && config.infisical.clientSecret && config.infisical.projectId)
    ? new InfisicalSecretStore(config.infisical)
    : new EnvFileSecretStore(config.envFile);

  const connections = new ConnectionService({
    providers,
    secretStore,
    recordStore: new ConnectionRecordStore(path.join(config.dataDir, "connections.json")),
    overlayBroker,
  });

  return buildServer({ config, compute, connections, providers });
}

export function buildServer({ config, compute, connections, providers }) {
  const providerTests = {
    modal: () => providers.get("modal").testConnection(),
    huggingface: () => providers.get("huggingface").testConnection(),
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

  function bearer(req) {
    return req.headers.authorization?.replace(/^Bearer\s+/i, "");
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname;

      if (p === "/health" && req.method === "GET") {
        return json(res, 200, { ok: true });
      }

      // Operator surface: static connect page (no secrets in the page itself).
      if (p === "/connect" && req.method === "GET") {
        const html = connectPage();
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
      }

      // Operator API: connection management. A distinct key, and disabled
      // entirely when OPERATOR_API_KEY is not configured.
      if (p.startsWith("/v1/connections")) {
        if (!config.operatorApiKey) {
          return json(res, 503, { error: "operator surface is not configured" });
        }
        if (!secureEqual(bearer(req), config.operatorApiKey)) {
          return json(res, 401, { error: "unauthorized" });
        }

        if (p === "/v1/connections" && req.method === "GET") {
          return json(res, 200, { connections: connections.list() });
        }

        const match = p.match(/^\/v1\/connections\/([a-z0-9-]+)$/);
        if (match && req.method === "POST") {
          const body = await readJson(req);
          const { namespace, ...credential } = body;
          const result = await connections.connect(match[1], credential, { namespace });
          return json(res, 200, result);
        }
        if (match && req.method === "DELETE") {
          return json(res, 200, await connections.disconnect(match[1]));
        }

        return json(res, 404, { error: "not_found" });
      }

      // Agent surface below. The agent key never reaches connection routes.
      if (!secureEqual(bearer(req), config.agentApiKey)) {
        return json(res, 401, { error: "unauthorized" });
      }

      // Machine-readable capability manifest: what an agent needs to use the
      // gateway without reading any docs.
      if (p === "/v1/capabilities" && req.method === "GET") {
        return json(res, 200, {
          name: "agent-compute-gateway",
          version: "0.2.0",
          principle: "agents receive capabilities, not provider credentials",
          endpoints: {
            execute: { method: "POST", path: "/v1/compute/execute" },
            executions: { method: "GET", path: "/v1/compute/executions" },
            executionStatus: { method: "GET", path: "/v1/compute/executions/:id" },
            executionStop: { method: "POST", path: "/v1/compute/executions/:id/stop" },
            providers: { method: "GET", path: "/v1/providers" },
          },
          executeRequest: {
            command: "string[] (required)",
            image: "string (optional container image)",
            gpu: "string (optional GPU class, e.g. T4)",
            timeoutMs: `number (optional, max ${MAX_TIMEOUT_MS})`,
            provider: "string (optional pin: modal | huggingface)",
          },
          limits: {
            maxTimeoutMs: config.policy?.maxTimeoutMs ?? MAX_TIMEOUT_MS,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
            maxOutputBytes: config.policy?.maxOutputBytes ?? MAX_OUTPUT_BYTES,
            allowedGpus: config.policy?.allowedGpus ?? [],
            allowedProviders: config.policy?.allowedProviders ?? [],
          },
          providers: compute.listProviders(),
          failover: {
            order: compute.router.order,
            eligibleFailures: ["billing_unavailable", "auth_invalid", "provider_unavailable"],
            note: "workload-level failures (execution_error) never fail over",
          },
        });
      }

      if (p === "/v1/providers" && req.method === "GET") {
        return json(res, 200, { providers: compute.listProviders() });
      }

      const providerTest = p.match(/^\/v1\/providers\/([a-z0-9-]+)\/test$/);
      if (providerTest && req.method === "POST") {
        const test = providerTests[providerTest[1]];
        if (!test) return json(res, 404, { error: "not_found" });
        return json(res, 200, await test());
      }

      if (p === "/v1/compute/execute" && req.method === "POST") {
        const workload = await readJson(req);
        return json(res, 200, await compute.execute(workload));
      }

      if (p === "/v1/compute/executions" && req.method === "GET") {
        return json(res, 200, { executions: compute.listExecutions() });
      }

      const executionMatch = p.match(/^\/v1\/compute\/executions\/(exec_[a-z0-9]+_[a-f0-9]+)(\/stop)?$/);
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

      if (error?.name === "ConnectionValidationError") {
        return json(res, 422, { error: error.message });
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
}
