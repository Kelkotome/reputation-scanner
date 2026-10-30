# Teammate handoff

## Start here

Read [START-HERE.md](START-HERE.md), then [README.md](README.md). The local app runs at `http://127.0.0.1:8788` when started with `npm run dev:live`.

## Operator sign-in

The operator page is `http://127.0.0.1:8788/admin`. Its access key is **not in this ZIP**. On the existing machine, an authorised maintainer can find it in the private `.env` file on the line beginning:

```dotenv
OPERATOR_ACCESS_KEY=
```

Do not put the key in source control, browser code, screenshots, tickets or chat. The key allows higher scan limits and access to usage totals. For a deployed environment, create a separate long random key and set it in that environment’s private configuration.

## Search credentials

The same private `.env` contains the SearXNG connection settings and `SERPAPI_API_KEY`. They are excluded from this ZIP. See [SERPAPI-SETUP.md](SERPAPI-SETUP.md) and `deploy/searxng/README.md` for the expected non-secret configuration.

## What is intentionally excluded

This handoff excludes `.env`, `.dev.vars`, `node_modules`, `.wrangler`, generated artifacts and Git metadata. Copy `.env.example` to a new private `.env`, fill in the deployment’s own credentials, run `npm ci`, then follow the startup documentation.
