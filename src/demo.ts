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
