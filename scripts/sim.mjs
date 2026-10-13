#!/usr/bin/env node
// Drives the coordinator with real git clients acting as agents.
// usage: node scripts/sim.mjs [baseUrl] [project]
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:8799";
const PROJECT = process.argv[3] ?? `sim-${Date.now().toString(36)}`;
const api = async (method, path, body) => {
	const res = await fetch(`${BASE}/p/${PROJECT}${path}`, {
		method,
		headers: { "content-type": "application/json", ...(process.env.AQ_KEY && { authorization: `Bearer ${process.env.AQ_KEY}` }) },
		body: body && JSON.stringify(body),
	});
	const data = await res.json();
	if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data)}`);
	return data;
};

// Token goes in an env-provided header, never in remote URLs or git config.
const git = (cwd, token, ...args) =>
	execFileSync("git", ["-c", "user.name=sim", "-c", "user.email=sim@x", ...args], {
		cwd,
		env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` },
		stdio: ["ignore", "pipe", "pipe"],
	}).toString();

async function work(assignment, edit) {
	const dir = mkdtempSync(join(tmpdir(), `aq-${assignment.task.id}-`));
	git(dir, assignment.token, "clone", "-q", assignment.remote, ".");
	edit(dir);
	git(dir, assignment.token, "add", "-A");
	git(dir, assignment.token, "commit", "-qm", assignment.task.intent);
	git(dir, assignment.token, "push", "-q", "origin", "main");
	return api("POST", `/tasks/${assignment.task.id}/submit`);
}

const append = (file, line) => (dir) => writeFileSync(join(dir, file), readFileSync(join(dir, file), "utf8") + line + "\n");
const replace = (file, from, to) => /* from: string | RegExp */ (dir) => writeFileSync(join(dir, file), readFileSync(join(dir, file), "utf8").replace(from, to));

async function waitFor(id, pred, label) {
	for (let i = 0; i < 60; i++) {
		const a = await api("GET", `/tasks/${id}`);
		if (pred(a.task) && (a.task.status !== "working" || a.remote)) return a;
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`timeout waiting for ${id} to ${label}`);
}

console.log(`project ${PROJECT} @ ${BASE}`);
await api("POST", "/init", {
	seed: {
		"README.md": "# demo\n",
		"src/auth.ts": "export const login = () => true;\n",
		"src/billing.ts": "export const charge = (n: number) => n;\n",
		"src/ui.ts": 'export const title = "Demo";\n',
	},
});

// 1. Disjoint claims run in parallel.
const a = await api("POST", "/tasks", { agent: "alice", intent: "Add a logout() stub to auth that returns false", claims: ["src/auth.ts"] });
const b = await api("POST", "/tasks", { agent: "bob", intent: "Add a refund(n) helper to billing that returns -n", claims: ["src/billing.ts"] });
// 2. Overlapping claim waits instead of conflicting later.
const c = await api("POST", "/tasks", { agent: "carol", intent: "Add an exported expiry constant of 3600 seconds to auth", claims: ["src/auth.ts"] });
console.log("claimed:", [a, b, c].map((x) => `${x.task.agent}=${x.task.status}`).join(" "));
if (c.task.status !== "waiting") throw new Error("carol should wait on alice");

await Promise.all([
	work(a, append("src/auth.ts", "export const logout = () => false;")),
	work(b, append("src/billing.ts", "export const refund = (n: number) => -n;")),
]);
await waitFor(a.task.id, (t) => t.status === "landed", "land");
await waitFor(b.task.id, (t) => t.status === "landed", "land");
console.log("alice + bob landed");

// carol is started automatically once alice's lease is released.
const c2 = await waitFor(c.task.id, (t) => t.status === "working", "start");
await work(c2, append("src/auth.ts", "export const expiry = 3600;"));
await waitFor(c.task.id, (t) => t.status === "landed", "land");
console.log("carol landed after alice (no conflict)");

// 3. Under-claiming: dave claims only README but also edits ui.ts, which erin changed.
//    The reviewer (or, failing that, the merge) sends him back to redo on the new main.
const d = await api("POST", "/tasks", { agent: "dave", intent: "Rename the product to Acme in the README heading", claims: ["README.md"] });
const e = await api("POST", "/tasks", { agent: "erin", intent: "Change the UI title to Erin's Demo", claims: ["src/ui.ts"] });
await work(e, replace("src/ui.ts", '"Demo"', '"Erin\'s Demo"'));
await waitFor(e.task.id, (t) => t.status === "landed", "land");
await work(d, (dir) => {
	replace("README.md", "# demo", "# Acme")(dir);
	replace("src/ui.ts", '"Demo"', '"Acme"')(dir);
});
const d2 = await waitFor(d.task.id, (t) => t.status === "working" && t.attempt === 2, "be evicted and redone");
console.log(`dave sent back (${d2.task.feedback}); redo attempt ${d2.task.attempt} forked from new main`);
await work(d2, replace("README.md", "# demo", "# Acme"));
await waitFor(d.task.id, (t) => t.status === "landed", "land");

const state = await api("GET", "/");
console.log("final:", state.tasks.map((t) => `${t.agent}:${t.status}@a${t.attempt}`).join(" "));
console.log(`main: ${state.mainRemote}`);
