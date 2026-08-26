import readline from "node:readline/promises";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { ModalProvider } from "../src/providers/modal.js";
import { HuggingFaceProvider } from "../src/providers/huggingface.js";
import {
  OverlayCredentialBroker,
  EnvFileSecretStore,
  InfisicalSecretStore,
  ConnectionRecordStore,
  PROVIDER_CREDENTIAL_FIELDS,
} from "../src/connections.js";
import { ConnectionService } from "../src/connection-service.js";

// Operator CLI: validate a provider credential against the real provider,
// persist it into the secret store, and record opaque connection metadata.
//
//   npm run connect:modal
//   npm run connect:hf
//
// Non-interactive (CI) usage:
//   node scripts/connect.js modal --token-id ak-... --token-secret as-...
//   node scripts/connect.js huggingface --token hf_... --namespace acme

const providerArg = process.argv[2];
if (!providerArg || !PROVIDER_CREDENTIAL_FIELDS[providerArg]) {
  console.error("usage: node scripts/connect.js <modal|huggingface> [--token-id .. --token-secret .. | --token .. --namespace ..]");
  process.exit(1);
}

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function prompt(question, { secret = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (secret && process.stdin.isTTY) process.stdout.write("\x1b[8m"); // hide echo best-effort
    const answer = await rl.question(question);
    if (secret && process.stdin.isTTY) process.stdout.write("\x1b[28m\n");
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function main() {
  const config = loadConfig();
  const overlayBroker = new OverlayCredentialBroker(null);

  const providers = new Map([
    ["modal", new ModalProvider({ credentialBroker: overlayBroker, appName: config.modal.appName })],
    ["huggingface", new HuggingFaceProvider({
      credentialBroker: overlayBroker,
      namespace: config.huggingface.namespace,
      endpoint: config.huggingface.endpoint,
    })],
  ]);

  const secretStore = (config.infisical.clientId && config.infisical.clientSecret && config.infisical.projectId)
    ? new InfisicalSecretStore(config.infisical)
    : new EnvFileSecretStore(config.envFile);

  const connections = new ConnectionService({
    providers,
    secretStore,
    recordStore: new ConnectionRecordStore(path.join(config.dataDir, "connections.json")),
    overlayBroker,
  });

  let credential = {};
  let namespace = flag("namespace");

  if (providerArg === "modal") {
    credential = {
      tokenId: flag("token-id") ?? await prompt("Modal Token ID: "),
      tokenSecret: flag("token-secret") ?? await prompt("Modal Token Secret: ", { secret: true }),
    };
  } else {
    credential = { token: flag("token") ?? await prompt("Hugging Face Token: ", { secret: true }) };
    namespace = namespace ?? await prompt("HF namespace (user/org owning Jobs quota): ");
  }

  console.log(`[connect] validating ${providerArg} credential against the real provider...`);
  const result = await connections.connect(providerArg, credential, { namespace });

  console.log(`[connect] ${providerArg} connected`);
  console.log(JSON.stringify({
    status: result.connection.status,
    account: result.connection.account,
    credentialRef: result.connection.credentialRef,
    secretStore: result.connection.secretStore,
  }, null, 2));
  console.log("[connect] credential stored in the secret store only; restart not required for this process.");
  console.log("[connect] if the gateway runs as a separate process, restart it or use the /connect page against the running instance.");
}

main().catch((error) => {
  console.error(`[connect] failed: ${error?.name ?? "Error"}: ${error?.message ?? "unknown error"}`);
  process.exitCode = 1;
});
