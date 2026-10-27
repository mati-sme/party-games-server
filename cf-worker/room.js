/**
 * Durable Object room — same JSON WebSocket protocol as PartyKit src/server.js.
 * Clients connect to /parties/main/{ptb|qc}-XXXX
 */
import { DurableObject } from "cloudflare:workers";
import * as PTB from "./games/ptb.js";
import * as QC from "./games/qc.js";

const TICK_MS = 50; // 20 Hz
const MAX_PLAYERS = { ptb: 8, qc: 8 };
const MIN_PLAYERS = { ptb: 2, qc: 3 };

function parseRoomId(id) {
  const m = String(id || "").match(/^(ptb|qc)-([A-Z0-9]{4})$/i);
  if (!m) return null;
  return { game: m[1].toLowerCase(), code: m[2].toUpperCase() };
}

function send(ws, msg) {
  try {
    ws.send(JSON.stringify(msg));
  } catch (_) {}
}

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.roomId = null;
    this.meta = { game: "ptb", code: "????" };
    this.players = []; // { id, name, connId, isHost }
    this.hostConnId = null;
    this.match = null;
    this.kidsMode = false;
    this.phase = "lobby"; // lobby | play | win
    this._alarmArmed = false;
    /** @type {Map<string, WebSocket>} */
    this.sockets = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (!this.roomId) {
      this.roomId =
        url.searchParams.get("roomId") ||
        decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
      this.meta = parseRoomId(this.roomId) || { game: "ptb", code: "????" };
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "party-games",
          roomId: this.roomId,
          game: this.meta.game,
          phase: this.phase,
          players: this.players.length,
        }),
        { headers: { "content-type": "application/json" } }
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Non-hibernating accept keeps in-memory lobby/match state warm (PartyKit hibernate:false).
    server.accept();
    const connId = crypto.randomUUID();
    this.sockets.set(connId, server);

    send(server, {
      type: "hello_ack",
      game: this.meta.game,
      code: this.meta.code,
      needHello: true,
    });

    server.addEventListener("message", (evt) => {
      this._onMessage(evt.data, connId);
    });
    server.addEventListener("close", () => {
      this._onClose(connId);
    });
    server.addEventListener("error", () => {
      this._onClose(connId);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm() {
    this._alarmArmed = false;
    if (!this.match || this.phase !== "play") return;

    const dt = TICK_MS / 1000;
    let events = [];
    if (this.meta.game === "ptb") {
      events = PTB.step(this.match, dt);
      if (this.match.phase === "win") this.phase = "win";
    } else {
      events = QC.step(this.match, dt);
      if (this.match.phase === "win") this.phase = "win";
    }

    this._broadcastState(events);

    if (this.phase === "play") {
      await this._armAlarm();
    }
  }

  _onClose(connId) {
    const leaving = this.players.find((p) => p.connId === connId);
    this.sockets.delete(connId);
    if (!leaving) return;
    this.players = this.players.filter((p) => p.connId !== connId);

    if (this.hostConnId === connId) {
      this.hostConnId = this.players[0] ? this.players[0].connId : null;
      for (const p of this.players) p.isHost = p.connId === this.hostConnId;
    }

    if (this.match && this.phase === "play") {
      if (this.meta.game === "ptb") {
        const mp = this.match.players.find((p) => p.id === leaving.id);
        if (mp && mp.alive) {
          mp.alive = false;
          mp.out = true;
          mp.vx = mp.vy = 0;
          if (this.match.boomId === leaving.id) {
            const pool = this.match.players.filter((p) => p.alive);
            if (pool.length <= 1) {
              this.match.phase = "win";
              this.match.winnerId = pool[0] ? pool[0].id : null;
              this.match.boomId = null;
              this.phase = "win";
            } else {
              const next = pool[(Math.random() * pool.length) | 0];
              this.match.boomId = next.id;
              this.match.fuse = this.match.fuseMax;
            }
          }
        }
      } else {
        const mp = this.match.players.find((p) => p.id === leaving.id);
        if (mp) {
          mp.vx = mp.vy = 0;
          if (mp.carrying) {
            const pkg = this.match.packages.find((k) => k.id === mp.carrying);
            if (pkg) {
              pkg.carriedBy = null;
              pkg.x = mp.x;
              pkg.y = mp.y;
            }
            mp.carrying = null;
          }
        }
      }
    }

    this._emitLobby();
    if (this.players.length === 0) {
      this.match = null;
      this.phase = "lobby";
      this._alarmArmed = false;
    }
  }

  _onMessage(message, connId) {
    let msg;
    try {
      msg = typeof message === "string" ? JSON.parse(message) : message;
    } catch (_) {
      return;
    }
    if (!msg || !msg.type) return;

    const senderWs = this.sockets.get(connId);
    if (!senderWs) return;

    if (msg.type === "hello") {
      this._handleHello(msg, connId, senderWs);
      return;
    }

    const player = this.players.find((p) => p.connId === connId);
    if (!player) return;

    if (msg.type === "kids") {
      if (player.connId !== this.hostConnId) return;
      this.kidsMode = !!msg.kidsMode;
      this._emitLobby();
      return;
    }

    if (msg.type === "start") {
      if (player.connId !== this.hostConnId) return;
      this._startMatch(!!msg.kidsMode);
      return;
    }

    if (msg.type === "again") {
      if (player.connId !== this.hostConnId) return;
      this.match = null;
      this.phase = "lobby";
      this._alarmArmed = false;
      this._broadcast({ type: "again" });
      this._emitLobby();
      return;
    }

    if (msg.type === "input") {
      if (!this.match || this.phase !== "play") return;
      if (this.meta.game === "ptb") {
        PTB.applyInput(this.match, player.id, msg.dx || 0, msg.dy || 0);
      } else {
        QC.applyInput(
          this.match,
          player.id,
          msg.dx || 0,
          msg.dy || 0,
          msg.action || null
        );
      }
      this._armAlarm();
      return;
    }
  }

  _handle(connId, msg) {
    const ws = this.sockets.get(connId);
    if (ws) send(ws, msg);
  }

  _close(connId) {
    const ws = this.sockets.get(connId);
    if (!ws) return;
    try {
      ws.close(1000, "bye");
    } catch (_) {}
    this.sockets.delete(connId);
  }

  _broadcast(msg, exceptId) {
    const data = JSON.stringify(msg);
    for (const [id, ws] of this.sockets) {
      if (exceptId && id === exceptId) continue;
      try {
        ws.send(data);
      } catch (_) {}
    }
  }

  _handleHello(msg, connId, senderWs) {
    const intent = msg.intent === "join" ? "join" : "create";
    const name =
      String(msg.name || "Player")
        .slice(0, 12)
        .trim() || "Player";
    const game = this.meta.game;

    if (intent === "join" && this.players.length === 0) {
      send(senderWs, {
        type: "error",
        message: "No room with that code. Check the code or Create a room.",
      });
      this._close(connId);
      return;
    }

    if (intent === "create" && this.players.length > 0) {
      send(senderWs, {
        type: "error",
        message: "That room code is busy — try Create again.",
      });
      this._close(connId);
      return;
    }

    if (this.players.length >= (MAX_PLAYERS[game] || 8)) {
      send(senderWs, { type: "error", message: "Room is full." });
      this._close(connId);
      return;
    }

    if (this.phase !== "lobby") {
      send(senderWs, {
        type: "error",
        message: "Match already in progress — wait for the next lobby.",
      });
      this._close(connId);
      return;
    }

    let finalName = name;
    let n = 2;
    while (this.players.some((p) => p.name === finalName)) {
      finalName = name.slice(0, 10) + n;
      n++;
    }

    const id =
      (intent === "create" ? "host_" : "p_") +
      Math.random().toString(36).slice(2, 8);
    const isHost = this.players.length === 0;
    if (isHost) this.hostConnId = connId;

    const player = { id, name: finalName, connId, isHost };
    this.players.push(player);

    send(senderWs, {
      type: "welcome",
      id,
      name: finalName,
      game,
      code: this.meta.code,
      isHost,
      kidsMode: this.kidsMode,
      players: this._lobbyPlayers(),
    });
    this._emitLobby();
  }

  _lobbyPlayers() {
    return this.players.map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
    }));
  }

  _emitLobby() {
    this._broadcast({
      type: "lobby",
      players: this._lobbyPlayers(),
      code: this.meta.code,
      kidsMode: this.kidsMode,
      hostId:
        (this.players.find((p) => p.connId === this.hostConnId) || {}).id ||
        null,
    });
  }

  _startMatch(kidsMode) {
    const game = this.meta.game;
    const min = MIN_PLAYERS[game] || 2;
    if (this.players.length < min) {
      this._broadcast({
        type: "error",
        message: `Need at least ${min} players to start`,
      });
      return;
    }
    if (game === "qc" && this.players.length > 8) return;

    this.kidsMode = !!kidsMode;
    const roster = this.players.map((p) => ({ id: p.id, name: p.name }));

    if (game === "ptb") {
      this.match = PTB.createMatch(roster, this.kidsMode);
    } else {
      this.match = QC.createMatch(roster, this.kidsMode);
    }
    this.phase = "play";

    for (const [connId, ws] of this.sockets) {
      const pl = this.players.find((p) => p.connId === connId);
      if (!pl) continue;
      let snapshot;
      if (game === "ptb") {
        snapshot = PTB.serialize(this.match);
      } else {
        snapshot = QC.serializeFor(this.match, pl.id);
      }
      send(ws, {
        type: "start",
        kidsMode: this.kidsMode,
        snapshot,
        localId: pl.id,
      });
    }

    this._armAlarm();
  }

  _broadcastState(events) {
    const game = this.meta.game;
    for (const [connId, ws] of this.sockets) {
      const pl = this.players.find((p) => p.connId === connId);
      if (!pl) continue;
      let snapshot;
      if (game === "ptb") {
        snapshot = PTB.serialize(this.match);
      } else {
        snapshot = QC.serializeFor(this.match, pl.id);
      }
      send(ws, {
        type: "state",
        snapshot,
        events: events || [],
      });
    }
  }

  async _armAlarm() {
    if (this._alarmArmed) return;
    this._alarmArmed = true;
    try {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    } catch (e) {
      this._alarmArmed = false;
      console.warn("setAlarm failed", e);
    }
  }
}
