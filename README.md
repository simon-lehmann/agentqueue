# agentqueue

**A merge queue for swarms of coding agents**, built on Cloudflare Workers, Durable Objects, Artifacts and Workers AI.

**Live: [agentqueue.simon-lehmann.com](https://agentqueue.simon-lehmann.com)**: press *Launch demo swarm* to watch 12 Workers AI agents share one repo.

A pull request assumes a person on each end: one writes the change, one reads it. Agents arrive all at once, and they don't mind redoing work. When researchers replayed merges between AI agents' pull requests that were open in the same repository at the same time, 48 of 115 pairs from two different agents conflicted (41.7%), against 19.8% for pairs from the same agent ([Xu et al. 2026, arXiv 2607.04697](https://arxiv.org/abs/2607.04697)). agentqueue borrows what large monorepos built for many writers on one main (Rust's bors, OpenStack's Zuul, Uber's SubmitQueue, Meta's pushrebase) and rebuilds it around agents:

1. **Declare before you write.** An agent states its *intent* and the files it will touch. Claims that overlap a live lease wait. They are forked from main only after the blocker lands, so most conflicts never happen. Leases are enforced: a submit that edits a file someone else holds is sent straight back.
2. **Every task gets its own repo.** Each attempt is an Artifacts fork of main with a short-lived, repo-scoped token. Agents use plain `git`.
3. **One writer for main.** A Durable Object per project is the only thing that moves main. It squash-lands each task as one linear commit carrying `Agent-Task`, `Agent` and `Claims` trailers.
4. **Review against intent.** Before queueing, a reviewer model compares the diff with the stated intent and the claims. It sends back incomplete work and edits outside the claimed files.
5. **Redo, don't resolve.** When review rejects a change, or it still conflicts at merge time, the task is re-forked from the new main. The reason goes back to the agent as feedback and the agent re-executes its intent. Nothing in the queue resolves a conflict; the agent just reruns. Review rounds are capped so retries can't loop forever. A change that runs out of rounds is parked for a human instead of landing anyway.

## How it uses Cloudflare

| Piece | Cloudflare product | Role |
| --- | --- | --- |
| Project main + per-task forks | **Artifacts** | `create` / `fork` / `createToken` per task; `log`, `readTree`, `readFile` to diff forks and render views without cloning |
| Coordinator | **Durable Objects** (SQLite) | Leases, queue, review state, event log; single serialized commit point; WebSocket fan-out to the dashboard |
| Landing | **Workers** + isomorphic-git | In-memory bare mirror of main inside the DO; three-way merge, squash commit, push |
| Agents | **Durable Objects** + **Workers AI** (`gpt-oss-120b`) | Each demo agent is a DO that plans claims, edits in its fork and retries from feedback |
| Reviewer | **Workers AI** | Intent-vs-diff review gate before the queue |
| Dashboard | **Workers static assets** | Live lanes, leases, review verdicts and the main commit rail |

External agents (Claude Code, Codex, humans) join the same queue through the `aq` CLI. It's just HTTP plus git.

## Run it

Requirements: Node 22+, git, a Cloudflare account on the **Workers Paid** plan (Artifacts is in open beta there).

```sh
npm install
cp .cf-credentials.example .cf-credentials   # CLOUDFLARE_API_TOKEN (Workers Scripts Edit) + CLOUDFLARE_ACCOUNT_ID
cp .dev.vars.example .dev.vars                 # AQ_API_KEY: leave empty locally to disable auth
set -a; . ./.cf-credentials; set +a
npm run dev                                    # http://localhost:8799
```

Artifacts and Workers AI have no local emulator, so `wrangler dev` uses the real services through remote bindings.

**Watch a swarm:** open `http://localhost:8799/` and press *Launch demo swarm*. Or:

```sh
curl -X POST localhost:8799/p/demo-1/demo     # seeds a todo service, launches 12 Workers AI agents
open "http://localhost:8799/?project=demo-1"
```

**Large-scale demo:** the dashboard's second button (or `curl -X POST localhost:8799/p/demo-2/demo -H 'content-type: application/json' -d '{"kind":"scale"}'`) seeds a ~20k-line repo. Codemod agents then rewrite tens of thousands of lines (a rename across 121 files, a `var`→`const` pass that has to wait for it, an 80-file rewrite, and a docs agent that over-reaches and gets sent back), while Workers AI agents add small features. A typical run lands about +32k / −32k lines in two minutes. The header and every card show lines landed.

**Scripted scenario** (real git clients; covers parallel lanes, a waiting lease, and review sending a task back for redo):

```sh
npm run sim
```

**Large changes** (one agent rewrites 10,000 lines across 100 files while small agents hold leases on some of them):

```sh
npm run stress                                 # or: node scripts/stress.mjs <url> <files> <linesPerFile>
```

The reviewer reads unified diffs, not whole files. A change too big for one model call is split into chunks that are reviewed in parallel against the same intent, and every chunk must pass. 10k changed lines review as 8 chunks in ~18s; 30k as 22 chunks in ~35s. Above about 33k lines the task is parked for a human instead. A failed review parks the task and frees its lease, so a huge change can never wedge the queue.

**Bring your own agent:**

```sh
export AQ_URL=http://localhost:8799            # AQ_KEY=<key> if auth is on
node scripts/aq.mjs claim -p demo-1 -a claude -m "Add a priority badge to formatTodo" src/format.ts
cd aq-<task> && $EDITOR src/format.ts && git commit -am "priority badge"
node scripts/aq.mjs submit .                   # waits; re-checks out the fork with feedback if sent back
```

**Deploy:**

```sh
npx wrangler secret put AQ_API_KEY
npm run deploy
```

`wrangler.jsonc` routes the Worker to `agentqueue.simon-lehmann.com`. Change the `routes` pattern to a domain on your own account, or delete it to deploy on `workers.dev`.

**Read a project's history:** every landed commit carries its story as git trailers.

```sh
git log --format='%h %s%n%w(0,4,4)%(trailers)'
```

```
7e1c0a2 Rename the product to Acme in the README heading
    Agent-Task: 7ertf3
    Agent: dave
    Claims: README.md
    Redo-Reason: attempt 2: review: src/ui.ts was also modified without being claimed
    Attempt: 2
    Reviewed-by: workers-ai/openai/gpt-oss-120b
    Review: approved: The README heading is correctly changed to 'Acme' as requested.
```

## API

| Route | |
| --- | --- |
| `POST /p/:project/init` `{seed?, importUrl?}` | create the project's main repo |
| `POST /p/:project/tasks` `{intent, claims[], agent}` | claim work → `{task, remote?, token?}` (no remote while waiting) |
| `GET /p/:project/tasks/:id` | task + fresh fork credentials when working |
| `POST /p/:project/tasks/:id/submit` | diff fork → review → queue → land |
| `POST /p/:project/tasks/:id/abandon` | release the lease |
| `POST /p/:project/tasks/:id/approve` | human override: land a task parked as `needs-human` |
| `POST /p/:project/swarm` `{goals:[{agent, goal}]}` | launch Workers AI agents |
| `POST /p/:project/demo` | seed + launch the demo swarm (`demo-*` projects, rate limited) |
| `GET /p/:project/` · `/commits` · `/files` · `/ws` | state, main history, tree, live events |

Write routes and `GET /tasks/:id` (which hands out a token) require `Authorization: Bearer $AQ_API_KEY` when the secret is set. The public demo route is capped at `DEMO_DAILY_LIMIT` runs a day (`wrangler.jsonc`).

Each attempt's fork is deleted once it lands, is redone or is abandoned. Parked tasks keep theirs for inspection.

## Layout

```
src/coordinator.ts  RepoCoordinator DO: leases, review gate, merge queue, events
src/mirror.ts       in-memory git mirror: fetch, three-way merge, squash-land, push
src/diff.ts         changed paths between commits via Artifacts readTree
src/review.ts       intent-vs-diff reviewer; chunks large diffs and reviews them in parallel
src/agent.ts        SwarmAgent DO: Workers AI coding agent
src/demo.ts         demo repo + goals
scripts/aq.mjs      CLI for external agents
scripts/sim.mjs     scripted end-to-end scenario
scripts/stress.mjs  10k-line refactor racing small agents
docs/PLAN.md        design notes; docs/research/ holds Artifacts docs + contest terms
```

MIT licensed.
