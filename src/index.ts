import { DurableObject } from "cloudflare:workers";

// One coordinator per repo: the only writer allowed to move main.
export class RepoCoordinator extends DurableObject<Env> {
	async status() {
		return { repo: this.ctx.id.name ?? null, queue: [] as string[] };
	}
}

export default {
	async fetch(req, env): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname === "/health") return Response.json({ ok: true });
		const m = url.pathname.match(/^\/repos\/([\w.-]{2,63})\/status$/);
		if (m) {
			const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(m[1]));
			return Response.json(await stub.status());
		}
		return new Response("not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
