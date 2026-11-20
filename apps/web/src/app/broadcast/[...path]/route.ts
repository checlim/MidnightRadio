import { serveBroadcast } from "../../../server/broadcast";
import { loadWebConfig } from "../../../server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

/** Published episodes and stations.json from the data volume (public demo playback; never gated). */
async function handle(request: Request, ctx: Ctx): Promise<Response> {
  return serveBroadcast(request, (await ctx.params).path, loadWebConfig().broadcastDir);
}
export const GET = handle;
export const HEAD = handle;
