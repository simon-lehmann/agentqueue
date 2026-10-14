# agentqueue — plan (working name)

Entry for Cloudflare "Build the next GitHub" (https://www.cloudflare.com/git-competition/).
Deadline: **Oct 14 2026, 11:59 PM PDT**. Finalists present Oct 21, Moscone West SF (US teammate travels).

## Rules that constrain us (docs/research/competition-terms.txt)
- Entrants: US/Canada legal residents, 18+. US teammate is primary contact/attendee.
- Built on **Workers + Artifacts** (checkbox on submit form).
- MIT/Apache-2.0/BSD + LICENSE file. One submission per entrant.
- Submit: 5–10 min demo video, public repo URL, run instructions, vision, "how you used Cloudflare".
- Judging (1–5 each): 50% originality/quality for agent-oriented collaboration,
  25% concurrency/coordination/context/review/conflicts, 25% ease of use/UX.

## Thesis
Big repos already solved "hundreds of concurrent contributors". The recurring principles:
1. Serialize the commit point, speculate everything else (Bors, Zuul, merge trains, Meta pushrebase).
2. Use the dependency graph to decide which changes commute → parallel lanes (Uber SubmitQueue, Google TAP).
3. Small changes with stable IDs (Gerrit Change-Id, stacks).
4. Predict/prevent conflicts before work starts (leases, continuous merge-tree).
5. Make conflicts cheap: evict + redo on new main instead of resolving conflicts.

Agent twist: agents are cheap to re-run, so an evicted change is **re-executed from its stated
intent** on the new main rather than having its conflicts resolved.

## Architecture
- **Worker (API + dashboard)** — task intake, token minting, UI.
- **Artifacts** — `main` repo + one `fork()` per agent task; short-lived per-repo write tokens.
  Intent/prompt attached via git notes. `pushed` events via Queues event subscriptions.
- **RepoCoordinator Durable Object** (one per repo) — the only writer of `main`; holds leases
  (files/symbols), the queue, lane assignment, eviction/redo state.
- **Conflict prediction** — on each `pushed` event: changed paths + merge-tree vs in-flight forks.
- **Verification** — Sandbox SDK container runs git merge + tests on speculative main; bisect batches.
- **Agents** — Workers AI (demo swarm), plus any external agent via git remote + token.
- **Dashboard** — live lanes, leases, predicted conflicts, evict→redo, main stays green.

## Open questions / risks
- Sandbox containers: images build for linux/amd64; this box is arm64 → need buildx/QEMU or
  deploy-side build. Fallback: isomorphic-git merges inside the DO, tests skipped/simulated.
- Artifacts has no local emulator (`remote: true`) → needs `wrangler login` on a Workers Paid account.
- Artifacts billing starts Oct 14.

## Milestones
1. Artifacts round-trip: create main, fork per task, push via token, read back. 
2. Coordinator: queue + leases + land-to-main (fast-forward / isomorphic-git merge).
3. pushed-event → conflict prediction → lanes.
4. Evict → redo-from-intent loop with Workers AI agents.
5. Dashboard. 6. Demo script + video + README run instructions. 7. Submit.
