export { RepoCoordinator } from "./coordinator";
export { SwarmAgent } from "./agent";
import { DEMO_GOALS, DEMO_SEED } from "./demo";

const NAME = /^[a-z0-9][a-z0-9-]{1,30}$/;

export default {
	async fetch(req, env): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname === "/health") return Response.json({ ok: true });

		// /p/:project[/...]
		const m = url.pathname.match(/^\/p\/([^/]+)(\/.*)?$/);
		if (!m) return new Response("not found", { status: 404 });
		const [, project, rest = "/"] = m;
		if (!NAME.test(project)) return Response.json({ error: "bad project name" }, { status: 400 });
		const coord = env.COORDINATOR.get(env.COORDINATOR.idFromName(project));
		const body = req.method === "POST" ? await req.json<any>().catch(() => ({})) : {};

		// Reads are public so the dashboard can be shared. Anything that writes,
		// or hands out a repo token, needs the API key once one is configured.
		const secretRoute = req.method === "POST" || /^\/tasks\/[a-z0-9]+$/.test(rest);
		if (secretRoute && rest !== "/demo" && env.AQ_API_KEY && req.headers.get("Authorization") !== `Bearer ${env.AQ_API_KEY}`) {
			return Response.json({ error: "unauthorized" }, { status: 401 });
		}

		try {
			if (rest === "/ws") return coord.fetch(req);
			if (rest === "/" && req.method === "GET") return Response.json(await coord.state());
			if (rest === "/init" && req.method === "POST") return Response.json(await coord.init(project, body));
			if (rest === "/files") return Response.json(await coord.listFiles());
			if (rest === "/commits") return Response.json(await coord.commits());
			if (rest === "/swarm" && req.method === "POST") {
				if (!Array.isArray(body.goals)) return Response.json({ error: "goals[] required" }, { status: 400 });
				return Response.json(await coord.swarm(body.goals));
			}
			// One-click demo for visitors: fresh demo-* projects only, globally rate limited.
			if (rest === "/demo" && req.method === "POST") {
				if (!project.startsWith("demo-")) return Response.json({ error: "demo projects must be named demo-*" }, { status: 400 });
				if ((await coord.state()).tasks.length) return Response.json({ error: "project already has tasks" }, { status: 409 });
				if (!(await env.DEMO_LIMIT.limit({ key: "global" })).success) return Response.json({ error: "demo busy, try again in a minute" }, { status: 429 });
				// "~" can't appear in a project name, so this instance never collides with a real project.
				const budget = env.COORDINATOR.get(env.COORDINATOR.idFromName("~demo-budget"));
				if (!(await budget.spendDemo(Number(env.DEMO_DAILY_LIMIT) || 40))) return Response.json({ error: "today's demo budget is used up; run it locally or try tomorrow" }, { status: 429 });
				await coord.init(project, { seed: DEMO_SEED });
				return Response.json(await coord.swarm(DEMO_GOALS));
			}
			if (rest === "/tasks" && req.method === "POST") {
				if (!body.intent || !Array.isArray(body.claims)) return Response.json({ error: "intent and claims[] required" }, { status: 400 });
				return Response.json(await coord.claim({ intent: body.intent, claims: body.claims, agent: body.agent ?? "anonymous" }));
			}
			const t = rest.match(/^\/tasks\/([a-z0-9]+)(\/submit|\/abandon|\/approve)?$/);
			if (t && req.method === "GET" && !t[2]) return Response.json(await coord.assignment(t[1]));
			if (t && req.method === "POST" && t[2] === "/submit") return Response.json(await coord.submit(t[1]));
			if (t && req.method === "POST" && t[2] === "/abandon") return Response.json(await coord.abandon(t[1]));
			if (t && req.method === "POST" && t[2] === "/approve") return Response.json(await coord.approve(t[1]));
		} catch (e) {
			return Response.json({ error: String(e instanceof Error ? e.message : e) }, { status: 409 });
		}
		return new Response("not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
