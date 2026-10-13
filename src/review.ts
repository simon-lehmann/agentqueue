import { createTwoFilesPatch } from "diff";

export const REVIEW_MODEL = "@cf/openai/gpt-oss-120b";
// gpt-oss-120b has a 128k-token window. At roughly 4 characters per token a
// chunk is ~30k tokens, leaving plenty of room for reasoning and the reply.
const CHUNK_CHARS = 120_000;
// Past this the change is too big to review piecemeal with any confidence.
const MAX_CHUNKS = 24;
const PARALLEL = 4;

export interface Verdict {
	approve: boolean | null; // null: no usable verdict, a human decides
	comments: string;
	chunks: number;
}

export function unifiedDiff(path: string, before: string | null, after: string | null) {
	return createTwoFilesPatch(before === null ? "/dev/null" : `a/${path}`, after === null ? "/dev/null" : `b/${path}`, before ?? "", after ?? "", undefined, undefined, { context: 3 })
		.replace(/^=+\n/, "");
}

// Pack per-file patches into model-sized chunks. A patch too big for one
// chunk is split on line boundaries, each piece keeping its file header.
export function chunkPatches(patches: string[]): string[] {
	const chunks: string[] = [];
	let cur = "";
	const push = (piece: string) => {
		if (cur && cur.length + piece.length > CHUNK_CHARS) {
			chunks.push(cur);
			cur = "";
		}
		cur += piece;
	};
	for (const patch of patches) {
		if (patch.length <= CHUNK_CHARS) {
			push(patch + "\n");
			continue;
		}
		const lines = patch.split("\n");
		const header = lines.slice(0, 2).join("\n") + "\n";
		let piece = header;
		for (const line of lines.slice(2)) {
			if (piece.length + line.length > CHUNK_CHARS) {
				push(piece);
				piece = header + "(continued)\n";
			}
			piece += line + "\n";
		}
		push(piece);
	}
	if (cur) chunks.push(cur);
	return chunks;
}

async function askOnce(env: Env, intent: string, claims: string[], undeclared: string[], diff: string, part: string) {
	const out: any = await env.AI.run(REVIEW_MODEL as any, {
		messages: [
			{
				role: "system",
				content:
					"You review changes made by coding agents before they merge. Approve if the change correctly implements the intent without unrelated edits or obvious bugs. Be pragmatic: style nits are not grounds for rejection. Reply with JSON only.",
			},
			{
				role: "user",
				content: `Intent: ${intent}\nClaimed files: ${claims.join(", ")}\n${undeclared.length ? `Edited without claiming: ${undeclared.join(", ")}\n` : ""}${part}\n${diff}\n\nReply as {"approve": true|false, "comments": "<one or two sentences>"}`,
			},
		],
		max_tokens: 3000,
		reasoning_effort: "low",
	} as any);
	const text: string = out?.choices?.[0]?.message?.content ?? out?.response ?? "";
	const r = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "null");
	if (typeof r?.approve !== "boolean") throw new Error("no verdict");
	return { approve: r.approve as boolean, comments: String(r.comments ?? "").slice(0, 400) };
}

// Ask twice before giving up: a single malformed reply or AI error shouldn't park a task.
async function ask(...args: Parameters<typeof askOnce>): Promise<{ approve: boolean | null; comments: string }> {
	let err: unknown;
	for (let i = 0; i < 2; i++) {
		try {
			return await askOnce(...args);
		} catch (e) {
			err = e;
		}
	}
	return { approve: null, comments: `reviewer gave no usable verdict (${err instanceof Error ? err.message : err})`.slice(0, 300) };
}

// Review a change of any size: small diffs in one call, large ones split into
// chunks reviewed in parallel against the same intent. Every chunk must pass.
export async function reviewChange(env: Env, intent: string, claims: string[], undeclared: string[], patches: string[]): Promise<Verdict> {
	const chunks = chunkPatches(patches);
	if (chunks.length > MAX_CHUNKS) {
		return { approve: null, comments: `diff too large for automated review (${chunks.length} chunks); split the change or approve it by hand`, chunks: chunks.length };
	}
	const n = chunks.length;
	const part = (i: number) =>
		n === 1 ? "" : `This is part ${i + 1} of ${n} of one large change; the other parts are reviewed separately. Judge only whether this part correctly and consistently carries out the intent. Do not reject it for looking incomplete.\n`;
	const results: { approve: boolean | null; comments: string }[] = new Array(n);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(PARALLEL, n) }, async () => {
			for (let i = next++; i < n; i = next++) results[i] = await ask(env, intent, claims, undeclared, chunks[i], part(i));
		}),
	);
	const label = (i: number) => (n === 1 ? "" : `[part ${i + 1}/${n}] `);
	const failed = results.flatMap((r, i) => (r.approve === null ? [label(i) + r.comments] : []));
	const rejected = results.flatMap((r, i) => (r.approve === false ? [label(i) + r.comments] : []));
	if (rejected.length) return { approve: false, comments: rejected.join(" ").slice(0, 1000), chunks: n };
	if (failed.length) return { approve: null, comments: failed.join(" ").slice(0, 1000), chunks: n };
	return { approve: true, comments: n === 1 ? results[0].comments : `All ${n} parts approved. ${results[0].comments}`, chunks: n };
}
