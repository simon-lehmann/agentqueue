#!/usr/bin/env node
// aq — join an agentqueue project from any coding agent (Claude Code, Codex, a human).
//
//   aq claim -p <project> -a <agent> -m "<intent>" <path>...   → clones your fork into ./aq-<task>
//   aq submit [dir]                                            → pushes, submits, waits for the verdict
//   aq status [dir]
//
// AQ_URL selects the coordinator (default http://localhost:8799).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const BASE = process.env.AQ_URL ?? "http://localhost:8799";
const [cmd, ...rest] = process.argv.slice(2);

function flags(args) {
	const out = { _: [] };
	for (let i = 0; i < args.length; i++) {
		if (args[i].startsWith("-")) out[args[i].replace(/^-+/, "")] = args[++i];
		else out._.push(args[i]);
	}
	return out;
}

async function api(project, method, path, body) {
	const res = await fetch(`${BASE}/p/${project}${path}`, {
		method,
		headers: { "content-type": "application/json", ...(process.env.AQ_KEY && { authorization: `Bearer ${process.env.AQ_KEY}` }) },
		body: body && JSON.stringify(body),
	});
	const data = await res.json();
	if (!res.ok) throw new Error(data.error ?? JSON.stringify(data));
	return data;
}

// The repo token rides in an env-provided header: never in the remote URL or .git/config.
function git(cwd, token, ...args) {
	return execFileSync("git", args, {
		cwd,
		env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` },
		stdio: ["ignore", "pipe", "inherit"],
	}).toString();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(project, id, pred) {
	for (;;) {
		const a = await api(project, "GET", `/tasks/${id}`);
		if (pred(a)) return a;
		await sleep(1500);
	}
}

function checkout(dir, a, project) {
	if (existsSync(dir)) rmSync(dir, { recursive: true });
	git(process.cwd(), a.token, "clone", "-q", a.remote, dir);
	writeFileSync(join(dir, ".git", "aq.json"), JSON.stringify({ project, task: a.task.id, attempt: a.task.attempt }));
	console.log(`fork ready in ${dir} (attempt ${a.task.attempt}, base ${a.task.baseSha?.slice(0, 7)})`);
	if (a.task.feedback) console.log(`feedback: ${a.task.feedback}`);
	console.log(`intent: ${a.task.intent}\nclaims: ${a.task.claims.join(", ")}\nedit, commit, then: aq submit ${dir}`);
}

const live = (a) => a.task.status === "working" && a.remote;

if (cmd === "claim") {
	const f = flags(rest);
	if (!f.p || !f.m || !f._.length) throw new Error('usage: aq claim -p <project> -a <agent> -m "<intent>" <path>...');
	let a = await api(f.p, "POST", "/tasks", { intent: f.m, claims: f._, agent: f.a ?? process.env.USER ?? "agent" });
	if (!live(a)) {
		console.log(`claims overlap ${a.task.blockedBy.join(", ")}; waiting for the lease...`);
		a = await until(f.p, a.task.id, live);
	}
	checkout(resolve(f.dir ?? `aq-${a.task.id}`), a, f.p);
} else if (cmd === "submit" || cmd === "status") {
	const dir = resolve(rest[0] ?? ".");
	const meta = JSON.parse(readFileSync(join(dir, ".git", "aq.json"), "utf8"));
	let a = await api(meta.project, "GET", `/tasks/${meta.task}`);
	if (cmd === "status") {
		console.log(JSON.stringify(a.task, null, 2));
		process.exit(0);
	}
	if (!a.token) throw new Error(`task is ${a.task.status}, not working`);
	git(dir, a.token, "push", "-q", "origin", "HEAD:main");
	await api(meta.project, "POST", `/tasks/${meta.task}/submit`);
	console.log("submitted; reviewing and queueing...");
	a = await until(meta.project, meta.task, (x) => x.task.status === "landed" || (live(x) && x.task.attempt > meta.attempt));
	if (a.task.status === "landed") {
		console.log(`landed on main as ${a.task.landedSha.slice(0, 7)}`);
	} else {
		console.log(`sent back for another attempt.`);
		checkout(dir, a, meta.project);
		process.exit(2);
	}
} else {
	console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(1, 9).join("\n").replace(/^\/\/ ?/gm, ""));
}
