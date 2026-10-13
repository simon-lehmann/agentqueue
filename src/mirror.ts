import git, { Errors } from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memfs";

const GITDIR = "/repo.git";
const BOT = { name: "agentqueue", email: "bot@agentqueue.dev" };

export type LandResult =
	| { ok: true; sha: string; fastForward: boolean }
	| { ok: false; conflicts: string[] };

// Artifacts tokens carry "?expires=<unix>"; git Basic auth wants only the secret.
const secret = (token: string) => token.split("?expires=")[0];

// A bare in-memory clone of main. The coordinator is its only user, so it can
// stay warm across lands instead of re-cloning each time.
export class Mirror {
	private fs = new MemoryFS();
	private ready = false;

	constructor(
		private mainRemote: string,
		private mainToken: () => Promise<string>,
	) {}

	private async auth(token: string) {
		return { username: "x", password: secret(token) };
	}

	// isomorphic-git only fetches through a configured remote with a refspec.
	private async fetchMain(remote: string, url: string, token: string) {
		await git.setConfig({ fs: this.fs, gitdir: GITDIR, path: `remote.${remote}.url`, value: url });
		await git.setConfig({ fs: this.fs, gitdir: GITDIR, path: `remote.${remote}.fetch`, value: `+refs/heads/main:refs/remotes/${remote}/main` });
		const res = await git.fetch({
			fs: this.fs,
			http,
			gitdir: GITDIR,
			remote,
			ref: "main",
			singleBranch: true,
			tags: false,
			onAuth: () => this.auth(token),
		});
		return res.fetchHead;
	}

	async sync(): Promise<string | null> {
		const token = await this.mainToken();
		if (!this.ready) {
			await git.init({ fs: this.fs, gitdir: GITDIR, bare: true, defaultBranch: "main" });
			this.ready = true;
		}
		const head = await this.fetchMain("origin", this.mainRemote, token);
		if (!head) return null;
		await git.writeRef({ fs: this.fs, gitdir: GITDIR, ref: "refs/heads/main", value: head, force: true });
		return head;
	}

	// Squash-land a task fork onto main: three-way merge for the tree, then a
	// single-parent commit so main stays linear with one commit per task.
	async land(task: { id: string; remote: string; token: string; message: string; author: string }): Promise<LandResult> {
		const fs = this.fs;
		const remoteRef = `refs/remotes/task-${task.id}/main`;
		const taskHead = await this.fetchMain(`task-${task.id}`, task.remote, task.token);
		if (!taskHead) throw new Error(`task ${task.id}: fork has no main`);
		const fetched = { fetchHead: taskHead };

		const mainSha = await git.resolveRef({ fs, gitdir: GITDIR, ref: "refs/heads/main" });
		const [base] = await git.findMergeBase({ fs, gitdir: GITDIR, oids: [mainSha, fetched.fetchHead] });
		if (base === fetched.fetchHead) return { ok: true, sha: mainSha, fastForward: true }; // nothing new

		let tree: string;
		if (base === mainSha) {
			tree = (await git.readCommit({ fs, gitdir: GITDIR, oid: fetched.fetchHead })).commit.tree;
		} else {
			try {
				const merged = await git.merge({
					fs,
					gitdir: GITDIR,
					ours: "refs/heads/main",
					theirs: remoteRef,
					noUpdateBranch: true,
					abortOnConflict: true,
					author: BOT,
					message: "tmp",
				});
				tree = merged.tree ?? (await git.readCommit({ fs, gitdir: GITDIR, oid: merged.oid! })).commit.tree;
			} catch (e) {
				if (e instanceof Errors.MergeConflictError) {
					return { ok: false, conflicts: [...e.data.filepaths, ...e.data.bothModified, ...e.data.deleteByUs, ...e.data.deleteByTheirs].filter((v, i, a) => a.indexOf(v) === i) };
				}
				throw e;
			}
		}

		const sha = await git.commit({
			fs,
			gitdir: GITDIR,
			tree,
			parent: [mainSha],
			ref: "refs/heads/main",
			message: task.message,
			author: { name: task.author, email: `${task.author}@agents.agentqueue.dev` },
			committer: BOT,
		});
		try {
			const token = await this.mainToken();
			const pushed = await git.push({
				fs,
				http,
				gitdir: GITDIR,
				url: this.mainRemote,
				ref: "main",
				remoteRef: "main",
				onAuth: () => this.auth(token),
			});
			if (!pushed.ok) throw new Error(`push rejected: ${JSON.stringify(pushed.refs)}`);
		} catch (e) {
			// Leave the mirror matching the remote so the next land starts clean.
			await git.writeRef({ fs, gitdir: GITDIR, ref: "refs/heads/main", value: mainSha, force: true });
			throw e;
		}
		return { ok: true, sha, fastForward: base === mainSha };
	}

	async seed(files: Record<string, string>, message: string) {
		const fs = this.fs;
		const dir = "/seed";
		await git.init({ fs, dir, defaultBranch: "main" });
		for (const [path, body] of Object.entries(files)) {
			await fs.promises.writeFile(`${dir}/${path}`, body);
			await git.add({ fs, dir, filepath: path });
		}
		await git.commit({ fs, dir, message, author: BOT });
		const token = await this.mainToken();
		await git.push({ fs, http, dir, url: this.mainRemote, ref: "main", onAuth: () => this.auth(token) });
	}
}
