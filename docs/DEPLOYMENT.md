# Deployment

The gateway is a single Node.js process with no database dependency. Provider
credentials live in the configured secret store (Infisical, injected env, or
the dev `.env` file); only opaque connection metadata is written to
`DATA_DIR/connections.json`.

## Runtime contract

Required:

| Variable | Purpose |
|---|---|
| `AGENT_API_KEY` | authenticates the agent surface (`/v1/compute/*`, `/v1/providers`, `/v1/capabilities`) |

Recommended:

| Variable | Purpose |
|---|---|
| `OPERATOR_API_KEY` | enables the operator surface (`/connect`, `/v1/connections/*`); when unset, that surface is disabled entirely |
| `PORT` | default `4000` |

Credential source — pick one:

| Option | Variables |
|---|---|
| Infisical (production) | `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_PROJECT_ID` |
| Direct injection (simple deploys) | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `HF_TOKEN`, `HF_NAMESPACE` |
| None | connect providers later through `/connect` (requires `OPERATOR_API_KEY`) |

## Docker

```bash
docker build -t agent-compute-gateway .
docker run -p 4000:4000 \
  -e AGENT_API_KEY=... \
  -e OPERATOR_API_KEY=... \
  -e INFISICAL_CLIENT_ID=... \
  -e INFISICAL_CLIENT_SECRET=... \
  -e INFISICAL_PROJECT_ID=... \
  agent-compute-gateway
```

## Any Node host (Fly.io, Render, Railway, a VPS)

```bash
npm install --omit=dev
node src/server.js
```

Health check: `GET /health` (unauthenticated).

## After deploy

1. Open `/connect` (or run `npm run connect:modal` / `connect:hf` locally against the same Infisical project) to connect provider accounts.
2. Hand agents only the base URL + `AGENT_API_KEY` + `GET /v1/capabilities`. Never the operator key, never provider tokens.

## Notes

- **TLS**: put the gateway behind a reverse proxy (Caddy, nginx, Fly/Render built-ins). The process serves plain HTTP.
- **State**: execution records are in-memory (POC). `connections.json` under `DATA_DIR` is the only file state; mount a volume if you want it to survive container replacement. Secret values are never written there.
- **CI live smokes**: see `.github/workflows/compute-gateway-smoke.yml` — Infisical OIDC injects Modal credentials with no long-lived secrets in GitHub.
