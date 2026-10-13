// Minimal in-memory filesystem with the promise API isomorphic-git expects.
// Workers have no disk; each coordinator keeps one of these as its git mirror.

type Entry =
	| { kind: "dir"; mtimeMs: number }
	| { kind: "file"; data: Uint8Array; mtimeMs: number };

function fsError(code: string, path: string) {
	return Object.assign(new Error(`${code}: ${path}`), { code });
}

class Stats {
	constructor(private e: Entry) {}
	get size() {
		return this.e.kind === "file" ? this.e.data.byteLength : 0;
	}
	get mode() {
		return this.e.kind === "file" ? 0o100644 : 0o040000;
	}
	get mtimeMs() {
		return this.e.mtimeMs;
	}
	get ctimeMs() {
		return this.e.mtimeMs;
	}
	uid = 1;
	gid = 1;
	dev = 1;
	ino = 1;
	isFile() {
		return this.e.kind === "file";
	}
	isDirectory() {
		return this.e.kind === "dir";
	}
	isSymbolicLink() {
		return false;
	}
}

export class MemoryFS {
	private entries = new Map<string, Entry>([["/", { kind: "dir", mtimeMs: Date.now() }]]);

	promises = {
		readFile: this.readFile.bind(this),
		writeFile: this.writeFile.bind(this),
		unlink: this.unlink.bind(this),
		readdir: this.readdir.bind(this),
		mkdir: this.mkdir.bind(this),
		rmdir: this.rmdir.bind(this),
		stat: this.stat.bind(this),
		lstat: this.stat.bind(this),
		readlink: async (p: string) => {
			throw fsError("ENOENT", p);
		},
		symlink: async (_t: string, p: string) => {
			throw fsError("ENOTSUP", p);
		},
		chmod: async () => {},
	};

	private norm(p: string) {
		const out: string[] = [];
		for (const part of p.split("/")) {
			if (!part || part === ".") continue;
			if (part === "..") out.pop();
			else out.push(part);
		}
		return "/" + out.join("/");
	}

	private parent(p: string) {
		const i = p.lastIndexOf("/");
		return i <= 0 ? "/" : p.slice(0, i);
	}

	async mkdir(path: string, opts?: { recursive?: boolean } | number) {
		const p = this.norm(path);
		if (this.entries.has(p)) {
			if (typeof opts === "object" && opts?.recursive) return;
			throw fsError("EEXIST", p);
		}
		const parent = this.parent(p);
		if (!this.entries.has(parent)) {
			if (typeof opts === "object" && opts?.recursive) await this.mkdir(parent, opts);
			else throw fsError("ENOENT", parent);
		}
		this.entries.set(p, { kind: "dir", mtimeMs: Date.now() });
	}

	async rmdir(path: string) {
		const p = this.norm(path);
		if ((await this.readdir(p)).length) throw fsError("ENOTEMPTY", p);
		this.entries.delete(p);
	}

	async readdir(path: string) {
		const p = this.norm(path);
		const e = this.entries.get(p);
		if (!e) throw fsError("ENOENT", p);
		if (e.kind !== "dir") throw fsError("ENOTDIR", p);
		const prefix = p === "/" ? "/" : p + "/";
		const names: string[] = [];
		for (const k of this.entries.keys()) {
			if (k !== p && k.startsWith(prefix) && !k.slice(prefix.length).includes("/")) {
				names.push(k.slice(prefix.length));
			}
		}
		return names;
	}

	async readFile(path: string, opts?: { encoding?: string } | string) {
		const p = this.norm(path);
		const e = this.entries.get(p);
		if (!e) throw fsError("ENOENT", p);
		if (e.kind !== "file") throw fsError("EISDIR", p);
		const enc = typeof opts === "string" ? opts : opts?.encoding;
		return enc ? new TextDecoder().decode(e.data) : e.data;
	}

	async writeFile(path: string, data: Uint8Array | string) {
		const p = this.norm(path);
		const parent = this.parent(p);
		if (!this.entries.has(parent)) await this.mkdir(parent, { recursive: true });
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
		this.entries.set(p, { kind: "file", data: bytes, mtimeMs: Date.now() });
	}

	async unlink(path: string) {
		const p = this.norm(path);
		if (!this.entries.delete(p)) throw fsError("ENOENT", p);
	}

	async stat(path: string) {
		const p = this.norm(path);
		const e = this.entries.get(p);
		if (!e) throw fsError("ENOENT", p);
		return new Stats(e);
	}
}
