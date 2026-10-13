import { DurableObject } from "cloudflare:workers";
import { changedPaths, intersect } from "./diff";
import { Mirror } from "./mirror";

export type Status = "waiting" | "working" | "queued" | "landed" | "evicted" | "abandoned";
const ACTIVE: Status[] = ["working", "queued"]; // statuses that hold a lease

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
			changed: "changed", blockedBy: "blocked_by", landedSha: "landed_sha", conflicts: "conflicts",
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
		const blockers = this.tasks(`status IN ('working','queued','waiting')`).filter((t) => intersect(input.claims, t.claims).length);
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
		using main = await this.env.ARTIFACTS.get(this.meta("mainRepo")!);
		const [head] = await main.log({ ref: "main", limit: 1 });
		const fork = await main.fork(forkName, { defaultBranchOnly: true, description: t.intent.slice(0, 200) });
		using forkRepo = await this.env.ARTIFACTS.get(forkName);
		const token = await forkRepo.createToken("write", 7200);
		this.update(id, { status: "working", attempt, fork: forkName, baseSha: head?.hash ?? null, headSha: null, changed: [], blockedBy: [] });
		this.log(attempt > 1 ? "task.redo" : "task.started", id, { fork: forkName, base: head?.hash, attempt });
		return { task: this.task(id), remote: fork.remote, token: token.plaintext };
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
		this.update(id, { status: "queued", headSha: head.hash, changed });
		this.log("task.queued", id, { head: head.hash, changed, undeclared });
		this.kick();
		return this.task(id);
	}

	async abandon(id: string) {
		this.update(id, { status: "abandoned" });
		this.log("task.abandoned", id, {});
		await this.wake();
		return this.task(id);
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
				message: `${next.intent}\n\nAgent-Task: ${next.id}\nAgent: ${next.agent}\nAttempt: ${next.attempt}\nClaims: ${next.claims.join(", ")}`,
			});
			if (res.ok) {
				this.update(next.id, { status: "landed", landedSha: res.sha });
				this.log("task.landed", next.id, { sha: res.sha, fastForward: res.fastForward, changed: next.changed });
			} else {
				this.update(next.id, { status: "evicted", conflicts: res.conflicts });
				this.log("task.evicted", next.id, { conflicts: res.conflicts });
				// Agents are cheap to re-run: redo the intent on the new main.
				await this.start(next.id);
			}
			await this.wake();
		}
	}

	// Start waiting tasks whose blockers have all finished.
	private async wake() {
		const live = new Set(this.tasks(`status IN ('working','queued','waiting')`).map((t) => t.id));
		for (const t of this.tasks(`status = 'waiting'`)) {
			if (t.blockedBy.every((b) => !live.has(b))) await this.start(t.id);
		}
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
			leases: this.tasks(`status IN (${ACTIVE.map((s) => `'${s}'`).join(",")})`).map((t) => ({ task: t.id, claims: t.claims })),
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
