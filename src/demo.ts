// A small TypeScript service for the demo swarm to work on. Goals overlap on
// store.ts and routes.ts on purpose so the queue has to schedule around them.
export const DEMO_SEED: Record<string, string> = {
	"README.md": "# todo-service\n\nA tiny in-memory todo API.\n",
	"src/store.ts": `export interface Todo {
	id: number;
	title: string;
	done: boolean;
}

const todos = new Map<number, Todo>();
let nextId = 1;

export function add(title: string): Todo {
	const todo = { id: nextId++, title, done: false };
	todos.set(todo.id, todo);
	return todo;
}

export function complete(id: number): Todo | undefined {
	const todo = todos.get(id);
	if (todo) todo.done = true;
	return todo;
}

export function list(): Todo[] {
	return [...todos.values()];
}
`,
	"src/routes.ts": `import { add, complete, list } from "./store";

export async function handle(req: Request): Promise<Response> {
	const url = new URL(req.url);
	if (req.method === "GET" && url.pathname === "/todos") {
		return Response.json(list());
	}
	if (req.method === "POST" && url.pathname === "/todos") {
		const { title } = await req.json<{ title: string }>();
		return Response.json(add(title), { status: 201 });
	}
	const m = url.pathname.match(/^\\/todos\\/(\\d+)\\/complete$/);
	if (req.method === "POST" && m) {
		const todo = complete(Number(m[1]));
		return todo ? Response.json(todo) : new Response("not found", { status: 404 });
	}
	return new Response("not found", { status: 404 });
}
`,
	"src/format.ts": `import type { Todo } from "./store";

export function formatTodo(todo: Todo): string {
	return \`\${todo.done ? "[x]" : "[ ]"} #\${todo.id} \${todo.title}\`;
}
`,
	"src/validate.ts": `export function isNonEmpty(s: unknown): s is string {
	return typeof s === "string" && s.trim().length > 0;
}
`,
};

export const DEMO_GOALS: { agent: string; goal: string }[] = [
	{ agent: "ada", goal: "Add a priority field ('low' | 'normal' | 'high', default 'normal') to todos in the store." },
	{ agent: "ben", goal: "Validate todo titles (non-empty, at most 120 characters) in validate.ts and reject bad titles with 400 in the POST /todos route." },
	{ agent: "cleo", goal: "Support filtering GET /todos by ?done=true or ?done=false." },
	{ agent: "dev", goal: "Add a formatDue(date: Date, now?: Date) helper to format.ts that returns relative strings like 'in 2 days' or '3 hours ago'." },
	{ agent: "eve", goal: "Document every HTTP endpoint with an example request in README.md." },
	{ agent: "finn", goal: "Add a clearCompleted() function to the store that deletes done todos and returns how many were removed." },
	{ agent: "gus", goal: "Add permissive CORS headers to every response from the routes handler." },
	{ agent: "hana", goal: "Add a count() function to the store returning {total, done, open}, and expose it as GET /todos/count." },
	{ agent: "ivy", goal: "Create src/search.ts with a searchTodos(todos, query) function doing case-insensitive substring search on titles." },
	{ agent: "jon", goal: "Create src/export.ts with toCsv(todos) that exports todos as CSV with a header row and proper quoting." },
	{ agent: "kai", goal: "Create tests/format.test.ts with vitest tests for formatTodo." },
	{ agent: "lea", goal: "Create a CHANGELOG.md following Keep a Changelog with an Unreleased section." },
];

// ---- large-scale demo ----------------------------------------------------
// A ~20k-line repo and codemod agents that each rewrite thousands of lines,
// running alongside Workers AI agents doing small features. Codemods are
// deterministic: an LLM can't emit a 12k-line edit in one reply, but large
// mechanical migrations are exactly what agent fleets produce.

const LEGACY = 120;
const GEN = 80;
const LINES = 100;
const pad = (n: number) => String(n).padStart(3, "0");
const legacyPath = (i: number) => `src/legacy/client${pad(i)}.ts`;
const genPath = (i: number) => `src/gen/table${pad(i)}.ts`;

export function scaleSeed(): Record<string, string> {
	const seed: Record<string, string> = {
		...DEMO_SEED,
		"README.md": "# todo-service\n\nA tiny in-memory todo API, plus a large legacy HTTP client and generated lookup tables.\n",
		"src/http.ts": "export function legacyFetch(path: string) {\n\treturn fetch(path).then((r) => r.json());\n}\n",
	};
	for (let i = 0; i < LEGACY; i++) {
		seed[legacyPath(i)] = `import { legacyFetch } from "../http";\n\n` + Array.from({ length: LINES }, (_, j) => `var r${j} = legacyFetch("/api/${i}/${j}");`).join("\n") + "\n";
	}
	for (let i = 0; i < GEN; i++) {
		seed[genPath(i)] = Array.from({ length: LINES }, (_, j) => `export function t${i}_${j}(x: number) { return x * ${j} + ${i}; }`).join("\n") + "\n";
	}
	return seed;
}

export interface Codemod {
	intent: string;
	claims: string[];
	// Returns only the files it changed. `attempt` lets a codemod behave differently on a redo.
	apply(files: Record<string, string>, attempt: number): Record<string, string>;
}

const rewrite = (files: Record<string, string>, prefix: string, fn: (body: string) => string) =>
	Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith(prefix)).map(([p, b]) => [p, fn(b)]).filter(([p, b]) => b !== files[p]));

export const CODEMODS: Record<string, Codemod> = {
	rename: {
		intent: "Rename legacyFetch to fetchJson across the HTTP client and every legacy module",
		claims: ["src/http.ts", "src/legacy/"],
		apply: (files) => ({
			"src/http.ts": files["src/http.ts"].replaceAll("legacyFetch", "fetchJson"),
			...rewrite(files, "src/legacy/", (b) => b.replaceAll("legacyFetch", "fetchJson")),
		}),
	},
	constify: {
		intent: "Replace var with const in every legacy module",
		claims: ["src/legacy/"],
		apply: (files) => rewrite(files, "src/legacy/", (b) => b.replace(/^var /gm, "const ")),
	},
	arrows: {
		intent: "Convert generated table functions to exported arrow functions",
		claims: ["src/gen/"],
		apply: (files) =>
			rewrite(files, "src/gen/", (b) => b.replace(/^export function (\w+)\(x: number\) \{ return (.*); \}$/gm, "export const $1 = (x: number) => $2;")),
	},
	docs: {
		intent: "Write docs/MODULES.md indexing every legacy and generated module",
		claims: ["docs/"],
		apply: (files, attempt) => {
			const mods = Object.keys(files).filter((p) => p.startsWith("src/legacy/") || p.startsWith("src/gen/")).sort();
			const out: Record<string, string> = {
				"docs/MODULES.md": `# Modules\n\n${mods.length} modules.\n\n` + mods.map((p) => `- \`${p}\``).join("\n") + "\n",
			};
			// First attempt over-reaches into files it never claimed; the lease check sends it back.
			if (attempt === 1) Object.assign(out, rewrite(files, "src/gen/", (b) => `// Indexed in docs/MODULES.md\n${b}`));
			return out;
		},
	},
};

export const SCALE_GOALS: { agent: string; goal: string; codemod?: string }[] = [
	{ agent: "rex", goal: CODEMODS.rename.intent, codemod: "rename" },
	{ agent: "mia", goal: CODEMODS.arrows.intent, codemod: "arrows" },
	{ agent: "ola", goal: CODEMODS.constify.intent, codemod: "constify" },
	{ agent: "sly", goal: CODEMODS.docs.intent, codemod: "docs" },
	...DEMO_GOALS.filter((g) => ["ada", "cleo", "gus", "ivy"].includes(g.agent)),
];
