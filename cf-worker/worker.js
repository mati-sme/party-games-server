/**
 * Party-games edge Worker — routes PartyKit-compatible paths to GameRoom DOs.
 * Path: /parties/main/{roomId}  (roomId = ptb-XXXX | qc-XXXX)
 */
import { GameRoom } from "./room.js";

export { GameRoom };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "party-games",
          protocol: "parties/main/{ptb|qc}-XXXX",
        }),
        { headers: { "content-type": "application/json" } }
      );
    }

    const m = url.pathname.match(/^\/parties\/main\/([^/]+)\/?$/);
    if (!m) {
      return new Response(
        "party-games: connect via /parties/main/{ptb|qc}-XXXX",
        { status: 404 }
      );
    }

    const roomId = decodeURIComponent(m[1]);
    const id = env.ROOMS.idFromName(roomId.toLowerCase());
    const stub = env.ROOMS.get(id);
    const forward = new URL(request.url);
    forward.searchParams.set("roomId", roomId);
    return stub.fetch(new Request(forward.toString(), request));
  },
};
