import http from "node:http";
import crypto from "node:crypto";
import { loadConfig } from "./config.js";
import { InfisicalCredentialBroker } from "./credential-broker.js";
import { ModalProvider } from "./providers/modal.js";
import { ComputeService } from "./compute-service.js";

const config = loadConfig();
const credentialBroker = new InfisicalCredentialBroker(config.infisical);
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
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.reduce((n, c) => n + c.length, 0) > 64 * 1024) throw new Error("request too large");
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
      const result = await modalProvider.testConnection();
      return json(res, 200, result);
    }

    if (req.url === "/v1/compute/execute" && req.method === "POST") {
      const body = await readJson(req);
      const result = await compute.execute(body);
      return json(res, 200, result);
    }

    return json(res, 404, { error: "not_found" });
  } catch (error) {
    // Never serialize arbitrary provider errors because they can contain sensitive request context.
    console.error("execution failed", { name: error?.name, message: error?.message });
    return json(res, 500, { error: "execution_failed" });
  }
});

server.listen(config.port, () => {
  console.log(`compute gateway listening on :${config.port}`);
});
