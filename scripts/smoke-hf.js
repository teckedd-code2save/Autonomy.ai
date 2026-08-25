import { loadConfig } from "../src/config.js";
import {
  EnvironmentCredentialBroker,
  InfisicalCredentialBroker,
} from "../src/credential-broker.js";
import { HuggingFaceProvider } from "../src/providers/huggingface.js";
import { ComputeService } from "../src/compute-service.js";

function stage(name) {
  process.stdout.write(`[smoke:hf] ${name}\n`);
}

async function main() {
  const config = loadConfig();
  const hasInjectedCredentials = Boolean(process.env.HF_TOKEN);

  const broker = hasInjectedCredentials
    ? new EnvironmentCredentialBroker()
    : new InfisicalCredentialBroker(config.infisical);

  const hf = new HuggingFaceProvider({
    credentialBroker: broker,
    namespace: config.huggingface.namespace,
    endpoint: config.huggingface.endpoint,
  });
  const compute = new ComputeService({
    providers: new Map([["huggingface", hf]]),
    routeOrder: ["huggingface"],
  });

  if (!config.huggingface.namespace) {
    throw new Error("HF_NAMESPACE is required for the Hugging Face smoke");
  }

  stage(hasInjectedCredentials
    ? "using injected Hugging Face connection"
    : "resolving Infisical-backed Hugging Face connection");
  const connection = await hf.testConnection();
  console.log(JSON.stringify(connection));

  stage("running Hugging Face CPU job");
  const result = await compute.execute({
    image: "python:3.13-slim",
    command: ["python", "-c", "print('hello from credentialless Hugging Face Jobs')"],
    timeoutMs: 120_000,
  });

  stage("execution complete");
  console.log(JSON.stringify({
    provider: result.provider,
    executionId: result.executionId,
    providerExecutionId: result.providerExecutionId,
    stdout: result.stdout,
    jobUrl: result.jobUrl,
  }, null, 2));
}

main().catch((error) => {
  // Trusted operator CLI: print only error class/message, never arbitrary serialized objects.
  console.error(`[smoke:hf] failed: ${error?.name ?? "Error"}: ${error?.message ?? "unknown error"}`);
  process.exitCode = 1;
});
