import { DurableObject } from "cloudflare:workers";
import { changedPaths, intersect } from "./diff";
import { Mirror } from "./mirror";
import { REVIEW_MODEL, reviewChange, unifiedDiff, type Verdict } from "./review";

export type Status = "waiting" | "working" | "reviewing" | "queued" | "landed" | "evicted" | "abandoned" | "needs-human";
// Statuses that hold a lease. An evicted task is between attempts and keeps
// its lease so nothing waiting on it starts early.
const ACTIVE: Status[] = ["working", "reviewing", "queued", "evicted"];
const LIVE: Status[] = [...ACTIVE, "waiting"];
const inList = (xs: Status[]) => xs.map((s) => `'${s}'`).join(",");

export interface Task {
	id: string;
	intent: string;
	agent: string;
	claims: string[];
	status: Status;
	attempt: number;
	fork: string | null;
	baseSha: string | null;
	headSha: string | null;
	changed: string[];
	blockedBy: string[];
	landedSha: string | null;
	conflicts: string[];
	feedback: string | null; // why the current attempt exists: conflict or review notes
	reviews: number;
	createdAt: number;
	updatedAt: number;
}

export interface Assignment {
	task: Task;
	remote?: string;
	token?: string;
}

type Row = Record<string, SqlStorageValue>;

const json = (v: unknown) => JSON.stringify(v);
const MAX_REVIEWS = 2;
const newId = () => Math.random().toString(36).slice(2, 8);

// One coordinator per project. It is the only writer of the project's main
// repo, so the commit point is serialized here while agents work in forks.
export class RepoCoordinator extends DurableObject<Env> {
	private sql = this.ctx.storage.sql;
	private mirror: Mirror | null = null;
	private mainToken: { value: string; exp: number } | null = null;
	private landing: Promise<void> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS tasks (
			id TEXT PRIMARY KEY, intent TEXT, agent TEXT, claims TEXT, status TEXT, attempt INTEGER,
			fork TEXT, base_sha TEXT, head_sha TEXT, changed TEXT, blocked_by TEXT, landed_sha TEXT,
			conflicts TEXT, seq INTEGER, created_at INTEGER, updated_at INTEGER)`);
		for (const col of ["feedback TEXT", "reviews INTEGER DEFAULT 0"]) {
			try {
				this.sql.exec(`ALTER TABLE tasks ADD COLUMN ${col}`);
			} catch {} // already present
		}
		this.sql.exec(`CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, task TEXT, data TEXT)`);
	}

	// ---- project setup ------------------------------------------------------

	private meta(k: string): string | null {
		const r = this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0];
		return (r?.v as string) ?? null;
	}

	private setMeta(k: string, v: string) {
		this.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v);
	}

	private get project() {
		const p = this.meta("project");
		if (!p) throw new Error("project not initialised");
		return p;
	}

	async init(project: string, opts: { seed?: Record<string, string>; importUrl?: string } = {}) {
		if (this.meta("project")) return this.state();
		const name = `${project}--main`;
		let created: ArtifactsCreateRepoResult;
		if (opts.importUrl) {
			created = await this.env.ARTIFACTS.import({ source: { url: opts.importUrl }, target: { name } });
		} else {
			created = await this.env.ARTIFACTS.create(name, { setDefaultBranch: "main", description: `agentqueue main for ${project}` });
		}
		this.setMeta("project", project);
		this.setMeta("mainRepo", name);
		this.setMeta("mainRemote", created.remote);
		if (opts.seed) await this.getMirror().seed(opts.seed, "Initial commit");
		this.log("project.created", null, { remote: created.remote });
		return this.state();
	}

	private async token(): Promise<string> {
		if (this.mainToken && this.mainToken.exp > Date.now() + 60_000) return this.mainToken.value;
		using repo = await this.env.ARTIFACTS.get(this.meta("mainRepo")!);
		const t = await repo.createToken("write", 3600);
		this.mainToken = { value: t.plaintext, exp: Date.parse(t.expiresAt) };
		return t.plaintext;
	}

	private getMirror() {
		this.mirror ??= new Mirror(this.meta("mainRemote")!, () => this.token());
		return this.mirror;
	}

	// ---- tasks --------------------------------------------------------------

	private row(r: Row): Task {
		return {
			id: r.id as string,
			intent: r.intent as string,
			agent: r.agent as string,
			claims: JSON.parse(r.claims as string),
			status: r.status as Status,
			attempt: r.attempt as number,
			fork: r.fork as string | null,
			baseSha: r.base_sha as string | null,
			headSha: r.head_sha as string | null,
			changed: JSON.parse(r.changed as string),
			blockedBy: JSON.parse(r.blocked_by as string),
			landedSha: r.landed_sha as string | null,
			conflicts: JSON.parse(r.conflicts as string),
			feedback: (r.feedback as string | null) ?? null,
			reviews: (r.reviews as number) ?? 0,
			createdAt: r.created_at as number,
			updatedAt: r.updated_at as number,
		};
	}

	private tasks(where = "1=1", ...args: SqlStorageValue[]): Task[] {
		return this.sql.exec(`SELECT * FROM tasks WHERE ${where} ORDER BY seq`, ...args).toArray().map((r) => this.row(r));
	}

	private task(id: string): Task {
		const t = this.tasks("id = ?", id)[0];
		if (!t) throw new Error(`no task ${id}`);
		return t;
	}

	private update(id: string, patch: Partial<Task>) {
		const cols: Record<string, string> = {
			status: "status", attempt: "attempt", fork: "fork", baseSha: "base_sha", headSha: "head_sha",
			changed: "changed", blockedBy: "blocked_by", landedSha: "landed_sha", conflicts: "conflicts", feedback: "feedback", reviews: "reviews",
		};
		const sets: string[] = ["updated_at = ?"];
		const vals: SqlStorageValue[] = [Date.now()];
		for (const [k, v] of Object.entries(patch)) {
			sets.push(`${cols[k]} = ?`);
			vals.push(Array.isArray(v) ? json(v) : (v as SqlStorageValue));
		}
		this.sql.exec(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...vals, id);
	}

	// Claim work. If the claims overlap a live lease, the task waits and is
	// forked from main only after its blockers land — the conflict never happens.
	async claim(input: { intent: string; claims: string[]; agent: string }): Promise<Assignment> {
		const id = newId();
		const blockers = this.tasks(`status IN (${inList(LIVE)})`).filter((t) => intersect(input.claims, t.claims).length);
		const now = Date.now();
		this.sql.exec(
			`INSERT INTO tasks (id, intent, agent, claims, status, attempt, changed, blocked_by, conflicts, seq, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'waiting', 0, '[]', ?, '[]', (SELECT COALESCE(MAX(seq), 0) + 1 FROM tasks), ?, ?)`,
			id, input.intent, input.agent, json(input.claims), json(blockers.map((t) => t.id)), now, now,
		);
		this.log("task.claimed", id, { agent: input.agent, intent: input.intent, claims: input.claims, blockedBy: blockers.map((t) => t.id) });
		if (!blockers.length) return this.start(id);
		this.log("task.waiting", id, { blockedBy: blockers.map((t) => t.id) });
		return { task: this.task(id) };
	}

	// Fork current main for a task (first attempt or a redo after eviction).
	private async start(id: string): Promise<Assignment> {
		const t = this.task(id);
		if (t.status !== "waiting" && t.status !== "evicted") return { task: t };
		const attempt = t.attempt + 1;
		const forkName = `${this.project}--${id}-a${attempt}`;
		// Take the lease before any await so a concurrent wake() can't start it twice.
		this.update(id, { status: "working", attempt, fork: null });
		try {
			using main = await this.env.ARTIFACTS.get(this.meta("mainRepo")!);
			const [head] = await main.log({ ref: "main", limit: 1 });
			await main.fork(forkName, { defaultBranchOnly: true, description: t.intent.slice(0, 200) }).catch(async (e) => {
				// A retry after a partial failure may find the fork already there.
				// Look it up by name rather than listing the namespace, which forks fill up.
				try {
					using _existing = await this.ready(forkName);
				} catch {
					throw e;
				}
			});
			using forkRepo = await this.ready(forkName);
			const [info, token] = await Promise.all([forkRepo.info(), forkRepo.createToken("write", 7200)]);
			this.update(id, { status: "working", attempt, fork: forkName, baseSha: head?.hash ?? null, headSha: null, changed: [], blockedBy: [] });
			this.log(attempt > 1 ? "task.redo" : "task.started", id, { fork: forkName, base: head?.hash, attempt });
			if (t.fork && t.fork !== forkName) this.dropFork(t.fork);
			return { task: this.task(id), remote: info.remote, token: token.plaintext };
		} catch (e) {
			// Give the lease back in its previous state and retry from the alarm.
			this.update(id, { status: t.status, attempt: t.attempt, fork: t.fork });
			this.log("agent.note", id, { message: `fork for attempt ${attempt} failed, retrying: ${e instanceof Error ? e.message : e}` });
			await this.ctx.storage.setAlarm(Date.now() + 2000);
			return { task: this.task(id) };
		}
	}

	// Forks are created asynchronously; get() throws until the repo is ready.
	private async ready(name: string) {
		for (let i = 0; ; i++) {
			try {
				return await this.env.ARTIFACTS.get(name);
			} catch (e) {
				if (i >= 20) throw e;
				await new Promise((r) => setTimeout(r, 250));
			}
		}
	}

	// Forks are throwaway: one per attempt, deleted once the attempt is over.
	private dropFork(name: string) {
		this.ctx.waitUntil(this.env.ARTIFACTS.delete(name).then(() => {}, () => {}));
	}

	async alarm() {
		await this.wake();
	}

	// Re-issue credentials for a task's current fork (agents poll this while waiting).
	async assignment(id: string): Promise<Assignment> {
		const t = this.task(id);
		if (t.status !== "working" || !t.fork) return { task: t };
		using repo = await this.env.ARTIFACTS.get(t.fork);
		const [info, token] = await Promise.all([repo.info(), repo.createToken("write", 7200)]);
		return { task: t, remote: info.remote, token: token.plaintext };
	}

	async submit(id: string) {
		const t = this.task(id);
		if (t.status !== "working" || !t.fork) throw new Error(`task ${id} is ${t.status}, not working`);
		using repo = await this.env.ARTIFACTS.get(t.fork);
		const [head] = await repo.log({ ref: "main", limit: 1 });
		if (!head || head.hash === t.baseSha) throw new Error(`task ${id}: no commits on fork`);
		const changed = t.baseSha ? await changedPaths(repo, t.baseSha, head.hash) : [];
		const undeclared = changed.filter((p) => !intersect([p], t.claims).length);
		this.update(id, { headSha: head.hash, changed });

		// Leases are enforced, not advisory: editing a file another live task
		// holds sends the change back before it costs a review.
		const trespass = this.tasks(`status IN (${inList(ACTIVE)}) AND id != ?`, id)
			.map((o) => ({ task: o, paths: intersect(undeclared, o.claims) }))
			.filter((x) => x.paths.length);
		if (trespass.length) {
			const paths = [...new Set(trespass.flatMap((x) => x.paths))];
			const holders = trespass.map((x) => `${x.task.agent} (#${x.task.id})`).join(", ");
			this.update(id, {
				status: "evicted",
				conflicts: paths,
				feedback: `You edited ${paths.join(", ")}, which you did not claim and ${holders} currently holds. Redo the intent touching only your claimed files.`,
			});
			this.log("task.trespass", id, { paths, holders: trespass.map((x) => x.task.id) });
			await this.start(id);
			return this.task(id);
		}

		this.update(id, { status: "reviewing" });
		this.log("task.reviewing", id, { head: head.hash, changed, undeclared });
		this.ctx.waitUntil(this.review(id, undeclared).catch((e) => this.log("queue.error", id, { error: String(e) })));
		return this.task(id);
	}

	async abandon(id: string) {
		const t = this.task(id);
		this.update(id, { status: "abandoned" });
		this.log("task.abandoned", id, {});
		if (t.fork) this.dropFork(t.fork);
		await this.wake();
		return this.task(id);
	}

	// A human overrides the reviewer for a parked task and sends it to the queue.
	async approve(id: string) {
		const t = this.task(id);
		if (t.status !== "needs-human") throw new Error(`task ${id} is ${t.status}, not waiting for a human`);
		this.update(id, { status: "queued", feedback: null });
		this.log("task.queued", id, { changed: t.changed, approvedBy: "human" });
		this.kick();
		return this.task(id);
	}

	// ---- review gate ----------------------------------------------------------

	// A reviewer model checks the diff against the stated intent. Rejections
	// re-fork the task with the review as feedback; a retry budget keeps
	// a stubborn reviewer from looping forever.
	private async review(id: string, undeclared: string[]) {
		const t = this.task(id);
		let verdict: Verdict;
		try {
			using repo = await this.env.ARTIFACTS.get(t.fork!);
			const text = async (ref: string, path: string) => (await repo.readFile({ ref, path }))?.text() ?? null;
			const patches = await Promise.all(t.changed.map(async (p) => unifiedDiff(p, await text(t.baseSha!, p), await text(t.headSha!, p))));
			verdict = await reviewChange(this.env, t.intent, t.claims, undeclared, patches);
		} catch (e) {
			// Fail closed but never wedge: a broken review parks the task and frees its lease.
			verdict = { approve: null, comments: `review failed: ${e instanceof Error ? e.message : e}`.slice(0, 300), chunks: 0 };
		}
		const reviews = t.reviews + 1;
		if (this.task(id).status !== "reviewing") return; // abandoned meanwhile
		this.log("task.reviewed", id, { ...verdict, round: reviews });
		if (verdict.approve) {
			this.update(id, { status: "queued", reviews });
			this.log("task.queued", id, { changed: t.changed });
			this.kick();
		} else if (verdict.approve === null || reviews >= MAX_REVIEWS) {
			// Out of review budget (or no usable verdict): park it for a human and
			// release the lease. The fork stays so a human can inspect or approve it.
			const why = verdict.approve === null ? verdict.comments : `still rejected after ${reviews} rounds: ${verdict.comments}`;
			this.update(id, { status: "needs-human", reviews, feedback: `Needs a human: ${why}` });
			this.log("task.parked", id, { reason: why });
			await this.wake();
		} else {
			this.update(id, { status: "evicted", reviews, feedback: `Reviewer requested changes: ${verdict.comments}` });
			await this.start(id);
		}
	}

	// ---- the merge queue ----------------------------------------------------

	private kick() {
		this.landing = this.landing.then(() => this.drain()).catch((e) => this.log("queue.error", null, { error: String(e) }));
		this.ctx.waitUntil(this.landing);
	}

	private async drain() {
		const mirror = this.getMirror();
		for (;;) {
			const next = this.tasks(`status = 'queued'`)[0];
			if (!next) break;
			const mainSha = await mirror.sync();
			using fork = await this.env.ARTIFACTS.get(next.fork!);
			const token = await fork.createToken("read", 600);
			const info = await fork.info();
			this.log("task.landing", next.id, { main: mainSha });
			const res = await mirror.land({
				id: next.id,
				remote: info.remote,
				token: token.plaintext,
				author: next.agent,
				message: `${next.intent}\n\n${this.trailers(next).join("\n")}`,
			});
			if (res.ok) {
				this.update(next.id, { status: "landed", landedSha: res.sha });
				this.log("task.landed", next.id, { sha: res.sha, fastForward: res.fastForward, changed: next.changed });
				this.dropFork(next.fork!);
			} else {
				this.update(next.id, {
					status: "evicted",
					conflicts: res.conflicts,
					feedback: `Your change conflicted with work that landed first on ${res.conflicts.join(", ") || "overlapping lines"}. Redo the intent on top of the new main and keep their changes.`,
				});
				this.log("task.evicted", next.id, { conflicts: res.conflicts });
				// Agents are cheap to re-run: redo the intent on the new main.
				await this.start(next.id);
			}
			await this.wake();
		}
	}

	// The landed commit carries the task's whole story as git trailers, so
	// `git log` on main explains why each change looks the way it does:
	// who asked for what, which files were leased, every redo and its reason,
	// and who reviewed it. Readable with `git log --format=%(trailers)`.
	private trailers(t: Task): string[] {
		const one = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
		const events = this.sql
			.exec(`SELECT type, data FROM events WHERE task = ? AND type IN ('task.waiting','task.reviewed','task.evicted','task.trespass','task.redo','task.queued') ORDER BY id`, t.id)
			.toArray()
			.map((e) => ({ type: e.type as string, data: JSON.parse(e.data as string) }));
		const name = (id: string) => this.tasks("id = ?", id)[0]?.agent ?? id;
		const out = [`Agent-Task: ${t.id}`, `Agent: ${t.agent}`, `Claims: ${t.claims.join(", ")}`];
		let reason = "";
		let review: any = null;
		let human = false;
		for (const e of events) {
			if (e.type === "task.waiting") out.push(`Waited-For: ${e.data.blockedBy.map((b: string) => `${name(b)} (#${b})`).join(", ")}`);
			if (e.type === "task.evicted") reason = `merge conflict on ${e.data.conflicts?.join(", ") || "overlapping lines"}`;
			if (e.type === "task.trespass") reason = `edited ${e.data.paths.join(", ")} under another agent's lease`;
			if (e.type === "task.reviewed") {
				review = e.data;
				if (e.data.approve === false) reason = `review: ${one(e.data.comments)}`;
			}
			if (e.type === "task.redo" && reason) {
				out.push(`Redo-Reason: attempt ${e.data.attempt}: ${reason}`);
				reason = "";
			}
			if (e.type === "task.queued" && e.data.approvedBy === "human") human = true;
		}
		out.push(`Attempt: ${t.attempt}`);
		if (review) {
			out.push(`Reviewed-by: ${REVIEW_MODEL.replace("@cf/", "workers-ai/")}${review.chunks > 1 ? ` (${review.chunks} chunks)` : ""}`);
			out.push(`Review: ${review.approve === true ? "approved" : review.approve === false ? "changes requested" : "no verdict"}: ${one(review.comments)}`);
		}
		if (human) out.push("Approved-by: human (review override)");
		return out;
	}

	// Start waiting tasks whose blockers have all finished, and retry redos
	// whose fork creation failed.
	private async wake() {
		for (const t of this.tasks(`status = 'evicted'`)) await this.start(t.id);
		const live = new Set(this.tasks(`status IN (${inList(LIVE)})`).map((t) => t.id));
		for (const t of this.tasks(`status = 'waiting'`)) {
			if (t.blockedBy.every((b) => !live.has(b))) await this.start(t.id);
		}
	}

	// ---- read-only views (served from Artifacts, no clone) ------------------

	async listFiles(): Promise<string[]> {
		if (!this.meta("mainRepo")) return [];
		using main = await this.env.ARTIFACTS.get(this.meta("mainRepo")!);
		const [head] = await main.log({ ref: "main", limit: 1 });
		if (!head) return [];
		const out: string[] = [];
		const walk = async (tree: string, prefix: string) => {
			for (const e of (await main.readTree(tree)) ?? []) {
				if (e.type === "tree") await walk(e.hash, `${prefix}${e.name}/`);
				else out.push(prefix + e.name);
			}
		};
		await walk(head.treeHash, "");
		return out.sort();
	}

	async commits(limit = 50) {
		if (!this.meta("mainRepo")) return [];
		using main = await this.env.ARTIFACTS.get(this.meta("mainRepo")!);
		return main.log({ ref: "main", limit });
	}

	// Demo budget: one coordinator instance doubles as a per-day counter so the
	// public one-click demo can't run up an unbounded Workers AI bill.
	async spendDemo(max: number) {
		const k = `demo:${new Date().toISOString().slice(0, 10)}`;
		const n = Number(this.meta(k) ?? 0);
		if (n >= max) return false;
		this.setMeta(k, String(n + 1));
		return true;
	}

	async note(task: string | null, message: string) {
		this.log("agent.note", task, { message });
	}

	// Launch Workers AI agents, one Durable Object each, on a list of goals.
	async swarm(goals: { agent: string; goal: string }[]) {
		for (const g of goals) {
			const stub = this.env.AGENT.get(this.env.AGENT.idFromName(`${this.project}/${g.agent}/${crypto.randomUUID()}`));
			await stub.begin(this.project, g.agent, g.goal);
		}
		this.log("swarm.launched", null, { agents: goals.map((g) => g.agent) });
		return { launched: goals.length };
	}

	// ---- observability ------------------------------------------------------

	private log(type: string, task: string | null, data: unknown) {
		const ts = Date.now();
		this.sql.exec(`INSERT INTO events (ts, type, task, data) VALUES (?, ?, ?, ?)`, ts, type, task, json(data));
		const msg = json({ ts, type, task, data });
		for (const ws of this.ctx.getWebSockets()) ws.send(msg);
	}

	async state() {
		const events = this.sql.exec(`SELECT * FROM events ORDER BY id DESC LIMIT 200`).toArray()
			.map((e) => ({ ts: e.ts, type: e.type, task: e.task, data: JSON.parse(e.data as string) }));
		return {
			project: this.meta("project"),
			mainRemote: this.meta("mainRemote"),
			tasks: this.tasks(),
			leases: this.tasks(`status IN (${inList(ACTIVE)})`).map((t) => ({ task: t.id, claims: t.claims })),
			events,
		};
	}

	async fetch(req: Request) {
		if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}
}
