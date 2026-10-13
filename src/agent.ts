import { DurableObject } from "cloudflare:workers";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { Assignment } from "./coordinator";
import { CODEMODS } from "./demo";
import { intersect } from "./diff";
import { MemoryFS } from "./memfs";

const MODEL = "@cf/openai/gpt-oss-120b";
const POLL_MS = 1500;
// Beyond the claimed files, how much of the repo an LLM agent reads for context.
const CONTEXT_CHARS = 60_000;

interface AgentState {
	project: string;
	name: string;
	goal: string;
	codemod?: string; // scripted large refactor instead of an LLM edit
	taskId: string | null;
	doneAttempt: number; // last attempt we pushed
	finished: boolean;
}

// A demo coding agent that lives entirely on Cloudflare. It follows the same
// protocol any external agent would: claim → work in fork → push → submit,
// and re-executes its intent whenever the coordinator hands it a fresh fork.
export class SwarmAgent extends DurableObject<Env> {
	private async load() {
		return (await this.ctx.storage.get<AgentState>("s")) ?? null;
	}
	private save(s: AgentState) {
		return this.ctx.storage.put("s", s);
	}
	private coord(project: string) {
		return this.env.COORDINATOR.get(this.env.COORDINATOR.idFromName(project));
	}

	async begin(project: string, name: string, goal: string, codemod?: string) {
		const s: AgentState = { project, name, goal, codemod: codemod && CODEMODS[codemod] ? codemod : undefined, taskId: null, doneAttempt: 0, finished: false };
		await this.save(s);
		await this.ctx.storage.setAlarm(Date.now() + 10);
	}

	async alarm() {
		const s = await this.load();
		if (!s || s.finished) return;
		try {
			await this.step(s);
		} catch (e) {
			await this.coord(s.project).note(s.taskId, `agent ${s.name}: ${e instanceof Error ? e.message : e}`);
		}
		if (!s.finished) await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
	}

	private async step(s: AgentState) {
		const coord = this.coord(s.project);
		if (!s.taskId) {
			const mod = s.codemod && CODEMODS[s.codemod];
			const plan = mod ? { intent: mod.intent, claims: mod.claims } : await this.plan(s.goal, await coord.listFiles());
			const a = await coord.claim({ intent: plan.intent, claims: plan.claims, agent: s.name });
			s.taskId = a.task.id;
			await this.save(s);
			if (a.remote) await this.work(s, a);
			return;
		}
		const a = await coord.assignment(s.taskId);
		if (a.task.status === "landed" || a.task.status === "abandoned" || a.task.status === "needs-human") {
			s.finished = true;
			await this.save(s);
		} else if (a.task.status === "working" && a.remote && a.task.attempt > s.doneAttempt) {
			await this.work(s, a);
		}
	}

	private async work(s: AgentState, a: Assignment) {
		const fs = new MemoryFS();
		const dir = "/w";
		const auth = () => ({ username: "x", password: a.token!.split("?expires=")[0] });
		await git.clone({ fs, http, dir, url: a.remote!, singleBranch: true, depth: 1, onAuth: auth });
		const paths = (await git.listFiles({ fs, dir })).filter((p) => !p.startsWith("."));
		const read = async (p: string) => (await fs.promises.readFile(`${dir}/${p}`, "utf8")) as string;

		let edits: Record<string, string>;
		const mod = s.codemod && CODEMODS[s.codemod];
		if (mod) {
			const all: Record<string, string> = {};
			for (const p of paths) all[p] = await read(p);
			edits = mod.apply(all, a.task.attempt);
		} else {
			// Claimed files in full, then as much of the rest as fits; big repos
			// don't fit in a model context, and the agent mostly needs its claims.
			const context: Record<string, string> = {};
			let budget = CONTEXT_CHARS;
			const claimed = paths.filter((p) => intersect([p], a.task.claims).length);
			for (const p of claimed) context[p] = await read(p);
			for (const p of paths.filter((p) => !claimed.includes(p))) {
				const body = await read(p);
				if (body.length > budget) continue;
				context[p] = body;
				budget -= body.length;
			}
			edits = await this.edit(a.task.intent, a.task.claims, context, a.task.attempt > 1 ? a.task.feedback : null);
		}
		for (const [p, body] of Object.entries(edits)) {
			await fs.promises.writeFile(`${dir}/${p}`, body);
			await git.add({ fs, dir, filepath: p });
		}
		await git.commit({ fs, dir, message: a.task.intent, author: { name: s.name, email: `${s.name}@agents.agentqueue.dev` } });
		await git.push({ fs, http, dir, onAuth: auth });
		s.doneAttempt = a.task.attempt;
		await this.save(s);
		await this.coord(s.project).submit(a.task.id);
	}

	// ---- LLM calls ----------------------------------------------------------

	private async ask(system: string, user: string): Promise<any> {
		const out: any = await this.env.AI.run(MODEL as any, {
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			max_tokens: 6000,
			reasoning_effort: "low",
		} as any);
		const text: string = out?.choices?.[0]?.message?.content ?? out?.response ?? "";
		const m = text.match(/\{[\s\S]*\}/);
		if (!m) throw new Error(`model returned no JSON: ${text.slice(0, 200)}`);
		return JSON.parse(m[0]);
	}

	// Declare intent and claims up front so the coordinator can schedule around conflicts.
	private async plan(goal: string, files: string[]): Promise<{ intent: string; claims: string[] }> {
		const r = await this.ask(
			"You are a coding agent in a team of agents sharing one repository. Before editing, you must declare which files you will touch so work can be scheduled without conflicts. Claim as few files as possible. Reply with JSON only.",
			`Repository files:\n${files.join("\n")}\n\nYour goal: ${goal}\n\nReply as {"intent": "<one-line imperative summary>", "claims": ["<path>", ...]}. New files you will create count as claims.`,
		);
		const claims = (Array.isArray(r.claims) ? r.claims : []).filter((c: unknown) => typeof c === "string" && c.length);
		return { intent: String(r.intent || goal).slice(0, 200), claims: claims.length ? claims : files.slice(0, 1) };
	}

	private async edit(intent: string, claims: string[], files: Record<string, string>, feedback: string | null): Promise<Record<string, string>> {
		const listing = Object.entries(files).map(([p, b]) => `--- ${p}\n${b}`).join("\n");
		const redo = feedback ? `\nThis is a retry. ${feedback} The files below are the current main.\n` : "";
		const r = await this.ask(
			"You are a careful coding agent. Make the smallest correct change that achieves the intent. Only modify the files you claimed. Return complete new file contents. Reply with JSON only.",
			`Intent: ${intent}\nClaimed files: ${claims.join(", ")}${redo}\nCurrent files:\n${listing}\n\nReply as {"files": {"<path>": "<full new content>"}}.`,
		);
		const out: Record<string, string> = {};
		for (const [p, b] of Object.entries(r.files ?? {})) if (typeof b === "string") out[p] = b;
		if (!Object.keys(out).length) throw new Error("model proposed no edits");
		return out;
	}
}
