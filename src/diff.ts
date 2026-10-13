// Changed paths between two commits, read straight from Artifacts without a
// clone: walk both trees and only descend where subtree hashes differ.
export async function changedPaths(repo: ArtifactsRepo, fromCommit: string, toCommit: string): Promise<string[]> {
	if (fromCommit === toCommit) return [];
	const [a, b] = await Promise.all([repo.readCommit(fromCommit), repo.readCommit(toCommit)]);
	if (!a || !b) throw new Error(`missing commit ${!a ? fromCommit : toCommit}`);
	const out: string[] = [];
	await walk(repo, a.treeHash, b.treeHash, "", out);
	return out.sort();
}

async function walk(repo: ArtifactsRepo, ta: string | null, tb: string | null, prefix: string, out: string[]) {
	if (ta === tb) return;
	const [ea, eb] = await Promise.all([ta ? repo.readTree(ta) : [], tb ? repo.readTree(tb) : []]);
	const byName = new Map<string, { a?: ArtifactsTreeEntry; b?: ArtifactsTreeEntry }>();
	for (const e of ea ?? []) byName.set(e.name, { a: e });
	for (const e of eb ?? []) byName.set(e.name, { ...byName.get(e.name), b: e });
	const subdirs: Promise<void>[] = [];
	for (const [name, { a, b }] of byName) {
		if (a?.hash === b?.hash && a?.mode === b?.mode) continue;
		const path = prefix + name;
		const aTree = a?.type === "tree" ? a.hash : null;
		const bTree = b?.type === "tree" ? b.hash : null;
		if (aTree || bTree) subdirs.push(walk(repo, aTree, bTree, path + "/", out));
		if ((a && a.type !== "tree") || (b && b.type !== "tree")) out.push(path);
	}
	await Promise.all(subdirs);
}

// Lease overlap: a claim is a file path or a directory prefix ending in "/".
export function overlaps(a: string, b: string) {
	if (a === b) return true;
	if (a.endsWith("/") && b.startsWith(a)) return true;
	if (b.endsWith("/") && a.startsWith(b)) return true;
	return false;
}

export function intersect(as: string[], bs: string[]) {
	return as.filter((a) => bs.some((b) => overlaps(a, b)));
}
