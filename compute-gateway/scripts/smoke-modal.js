import { loadConfig } from "../src/config.js";
import {
  EnvironmentCredentialBroker,
  InfisicalCredentialBroker,
} from "../src/credential-broker.js";
import { ModalProvider } from "../src/providers/modal.js";
import { ComputeService } from "../src/compute-service.js";

const gpu = process.argv.includes("--gpu");

function stage(name) {
  process.stdout.write(`[smoke] ${name}\n`);
}

async function main() {
  const config = loadConfig();
  const hasInjectedModalCredentials = Boolean(
    process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET,
  );

  const broker = hasInjectedModalCredentials
    ? new EnvironmentCredentialBroker()
    : new InfisicalCredentialBroker(config.infisical);

  const modal = new ModalProvider({ credentialBroker: broker, appName: config.modal.appName });
  const compute = new ComputeService({ modalProvider: modal });

  stage(
    hasInjectedModalCredentials
      ? "using short-lived Infisical OIDC-injected Modal connection"
      : "resolving Infisical-backed Modal connection",
  );
  const connection = await modal.testConnection();
  console.log(JSON.stringify(connection));

  stage(gpu ? "running Modal GPU sandbox" : "running Modal CPU sandbox");
  const result = await compute.execute(gpu
    ? {
        image: "nvidia/cuda:12.4.1-base-ubuntu22.04",
        command: ["nvidia-smi"],
        gpu: "T4",
        timeoutMs: 120_000,
      }
    : {
        image: "python:3.13-slim",
        command: ["python", "-c", "print('hello from credentialless Modal')"],
        timeoutMs: 60_000,
      });

  stage("execution complete");
  console.log(JSON.stringify({
    provider: result.provider,
    executionId: result.executionId,
    stdout: result.stdout,
    stderr: result.stderr,
  }, null, 2));
}

main().catch((error) => {
  // Trusted operator CLI: print only error class/message, never arbitrary serialized objects.
  console.error(`[smoke] failed: ${error?.name ?? "Error"}: ${error?.message ?? "unknown error"}`);
  process.exitCode = 1;
});
