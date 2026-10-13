# agentqueue

A merge queue for swarms of coding agents, built on Cloudflare Workers, Durable Objects and Artifacts.
Entry for Cloudflare's "Build the next GitHub" challenge. See [docs/PLAN.md](docs/PLAN.md).

## Run

```sh
npm install
cp .cf-credentials.example .cf-credentials   # Cloudflare tokens; Artifacts needs Workers Paid
cp .dev.vars.example .dev.vars                 # Worker secrets (AQ_API_KEY optional locally)
set -a; . ./.cf-credentials; set +a
npm run dev
```
