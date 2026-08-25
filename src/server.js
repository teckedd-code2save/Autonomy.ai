import http from "node:http";
import crypto from "node:crypto";
import { loadConfig } from "./config.js";
import { createCredentialBroker } from "./credential-broker.js";
import { ModalProvider } from "./providers/modal.js";
import { ComputeService } from "./compute-service.js";

const config = loadConfig();
const credentialBroker = createCredentialBroker({
  env: process.env,
  infisicalConfig: config.infisical,
});
const modalProvider = new ModalProvider({
  credentialBroker,
  appName: config.modal.appName,
});
const compute = new ComputeService({ modalProvider });

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
    if (total > 64 * 1024) throw new Error("request too large");
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/health" && req.method === "GET") {
      return json(res, 200, { ok: true });
    }

    const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!secureEqual(auth, config.agentApiKey)) {
      return json(res, 401, { error: "unauthorized" });
    }

    if (req.url === "/v1/providers/modal/test" && req.method === "POST") {
      return json(res, 200, await modalProvider.testConnection());
    }

    if (req.url === "/v1/compute/execute" && req.method === "POST") {
      const workload = await readJson(req);
      return json(res, 200, await compute.execute(workload));
    }

    return json(res, 404, { error: "not_found" });
  } catch (error) {
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
