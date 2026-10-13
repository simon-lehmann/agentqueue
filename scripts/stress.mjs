#!/usr/bin/env node
// Large-change stress test: one agent rewrites ~LINES lines across many files
// while small agents work on the same files.
// usage: node scripts/stress.mjs [baseUrl] [files] [linesPerFile]
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:8799";
const FILES = Number(process.argv[3] ?? 100);
const LINES = Number(process.argv[4] ?? 100);
const PROJECT = `stress-${Date.now().toString(36)}`;
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

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
const git = (cwd, token, ...args) =>
	execFileSync("git", ["-c", "user.name=stress", "-c", "user.email=stress@x", ...args], {
		cwd,
		env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` },
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 1 << 28,
	}).toString();

async function work(a, edit) {
	const dir = mkdtempSync(join(tmpdir(), `aq-${a.task.id}-`));
	git(dir, a.token, "clone", "-q", a.remote, ".");
	edit(dir);
	git(dir, a.token, "add", "-A");
	git(dir, a.token, "commit", "-qm", a.task.intent);
	const stat = git(dir, a.token, "diff", "--shortstat", "HEAD~1").trim();
	git(dir, a.token, "push", "-q", "origin", "main");
	console.log(`[${secs()}] ${a.task.agent} pushed: ${stat}`);
	return api("POST", `/tasks/${a.task.id}/submit`);
}

async function waitFor(id, pred, label, limit = 600) {
	let last = "";
	for (let i = 0; i < limit; i++) {
		const a = await api("GET", `/tasks/${id}`);
		if (a.task.status !== last) console.log(`[${secs()}] ${a.task.agent} → ${(last = a.task.status)}${a.task.feedback ? ` (${a.task.feedback.slice(0, 160)})` : ""}`);
		if (pred(a.task) && (a.task.status !== "working" || a.remote)) return a;
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`timeout waiting for ${id} to ${label}`);
}

const file = (i) => `src/mod${String(i).padStart(3, "0")}.ts`;
const seed = { "README.md": "# stress\n" };
for (let i = 0; i < FILES; i++) {
	seed[file(i)] = Array.from({ length: LINES }, (_, j) => `export const v${j} = legacyName(${i}, ${j});`).join("\n") + "\n";
}
console.log(`project ${PROJECT}: ${FILES} files x ${LINES} lines = ${FILES * LINES} lines`);
await api("POST", "/init", { seed });
console.log(`[${secs()}] seeded`);

// Small agents grab single files first; the big refactor claims all of src/ and must wait for them.
const smalls = [];
for (const i of [3, 42, 77].filter((i) => i < FILES)) {
	smalls.push(await api("POST", "/tasks", { agent: `small${i}`, intent: `Add a header comment to ${file(i)}`, claims: [file(i)] }));
}
const big = await api("POST", "/tasks", { agent: "rex", intent: "Rename legacyName to modernName across the codebase", claims: ["src/"] });
console.log(`[${secs()}] rex is ${big.task.status} (blocked by ${big.task.blockedBy.length})`);

await Promise.all(smalls.map((s) => work(s, (dir) => {
	const p = join(dir, s.task.claims[0]);
	writeFileSync(p, `// owned by ${s.task.agent}\n` + readFileSync(p, "utf8"));
})));
for (const s of smalls) await waitFor(s.task.id, (t) => ["landed", "needs-human"].includes(t.status), "settle");

const rex = await waitFor(big.task.id, (t) => t.status === "working", "start");
const r = await work(rex, (dir) => {
	for (let i = 0; i < FILES; i++) {
		const p = join(dir, file(i));
		writeFileSync(p, readFileSync(p, "utf8").replaceAll("legacyName", "modernName"));
	}
});
console.log(`[${secs()}] rex submitted (${r.changed.length} files changed)`);
const done = await waitFor(big.task.id, (t) => ["landed", "needs-human", "abandoned"].includes(t.status), "settle");
console.log(`[${secs()}] rex finished: ${done.task.status} @ attempt ${done.task.attempt}`);

const state = await api("GET", "/");
for (const e of state.events.filter((e) => e.type === "queue.error" || e.type === "task.reviewed" || e.type === "agent.note").reverse()) {
	console.log(`  ${e.type} ${e.task ?? ""} ${JSON.stringify(e.data).slice(0, 300)}`);
}
