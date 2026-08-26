export function loadConfig(env = process.env) {
  if (!env.AGENT_API_KEY) {
    throw new Error("Missing required environment variable: AGENT_API_KEY");
  }

  const parseList = (value) =>
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

  return {
    port: Number(env.PORT ?? 4000),
    agentApiKey: env.AGENT_API_KEY,
    // Operator surface (connect UI/CLI/API). Distinct from the agent key on
    // purpose: agents must never be able to connect or inspect credentials.
    // When unset, operator routes are disabled entirely.
    operatorApiKey: env.OPERATOR_API_KEY,
    dataDir: env.DATA_DIR ?? "./data",
    envFile: env.ENV_FILE ?? ".env",
    infisical: {
      siteUrl: env.INFISICAL_SITE_URL ?? "https://app.infisical.com",
      clientId: env.INFISICAL_CLIENT_ID,
      clientSecret: env.INFISICAL_CLIENT_SECRET,
      projectId: env.INFISICAL_PROJECT_ID,
      environment: env.INFISICAL_ENVIRONMENT ?? "dev",
      secretPath: env.INFISICAL_SECRET_PATH ?? "/providers/modal",
      hfSecretPath: env.INFISICAL_HF_SECRET_PATH ?? "/providers/huggingface",
    },
    modal: {
      appName: env.MODAL_APP_NAME ?? "agent-compute-gateway",
    },
    huggingface: {
      endpoint: env.HF_ENDPOINT ?? "https://huggingface.co",
      namespace: env.HF_NAMESPACE, // HF user/org that owns the Jobs quota
    },
    policy: {
      maxTimeoutMs: Number(env.MAX_TIMEOUT_MS ?? 300_000),
      allowedGpus: parseList(env.ALLOWED_GPUS),
      allowedProviders: parseList(env.ALLOWED_PROVIDERS),
      maxOutputBytes: Number(env.MAX_OUTPUT_BYTES ?? 256 * 1024),
    },
    // Gate 3 deterministic fallback order. Hugging Face first recreates the
    // origin incident; unconfigured providers are skipped at route time.
    routeOrder: parseList(env.ROUTE_ORDER).length > 0
      ? parseList(env.ROUTE_ORDER)
      : ["huggingface", "modal"],
  };
}
