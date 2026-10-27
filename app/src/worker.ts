// Thin Worker: static assets + everything under /api goes to the single CutterDO.
export { CutterDO } from "./do";

export interface Env { DATA: R2Bucket; DB: D1Database; CUTTER: DurableObjectNamespace; ASSETS: Fetcher; }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      const stub = env.CUTTER.get(env.CUTTER.idFromName("alaska"));
      return stub.fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};
