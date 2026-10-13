# agentqueue

A merge queue for swarms of coding agents, built on Cloudflare Workers, Durable Objects and Artifacts.
Entry for Cloudflare's "Build the next GitHub" challenge. See [docs/PLAN.md](docs/PLAN.md).

## Run

```sh
npm install
cp .env.example .env   # fill in tokens; Artifacts needs the Workers Paid plan
set -a; . ./.env; set +a
npm run dev
```
