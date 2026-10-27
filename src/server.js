/**
 * PartyKit authoritative rooms for Pass the Boom (ptb-XXXX) and Quiet Courier (qc-XXXX).
 * Clients send input; server runs sim ~20 Hz and broadcasts snapshots.
 */
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

function send(conn, msg) {
  try {
    conn.send(JSON.stringify(msg));
  } catch (_) {}
}

function broadcast(room, msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const c of room.getConnections()) {
    if (exceptId && c.id === exceptId) continue;
    try {
      c.send(data);
    } catch (_) {}
  }
}

export default class Server {
  constructor(room) {
    this.room = room;
    this.meta = parseRoomId(room.id) || { game: "ptb", code: "????" };
    this.players = []; // { id, name, connId, isHost }
    this.hostConnId = null;
    this.match = null;
    this.kidsMode = false;
    this.phase = "lobby"; // lobby | play | win
    this._alarmArmed = false;
  }

  // Keep room warm while people are connected (lobby + match state is in-memory).
  options = { hibernate: false };

  async onStart() {
    // Durable Object wake — nothing sticky needed beyond in-memory for free ephemeral rooms
  }

  onConnect(conn, ctx) {
    // Wait for hello message before adding to lobby
    send(conn, {
      type: "hello_ack",
      game: this.meta.game,
      code: this.meta.code,
      needHello: true,
    });
  }

  onClose(conn) {
    const leaving = this.players.find((p) => p.connId === conn.id);
    if (!leaving) return;
    this.players = this.players.filter((p) => p.connId !== conn.id);

    if (this.hostConnId === conn.id) {
      this.hostConnId = this.players[0] ? this.players[0].connId : null;
      for (const p of this.players) p.isHost = p.connId === this.hostConnId;
    }

    // If match in progress, mark player out / remove carefully
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
        // QC: leave player frozen in place
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

  onMessage(message, sender) {
    let msg;
    try {
      msg = typeof message === "string" ? JSON.parse(message) : message;
    } catch (_) {
      return;
    }
    if (!msg || !msg.type) return;

    if (msg.type === "hello") {
      this._handleHello(msg, sender);
      return;
    }

    const player = this.players.find((p) => p.connId === sender.id);
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
      broadcast(this.room, { type: "again" });
      this._emitLobby();
      return;
    }

    if (msg.type === "input") {
      if (!this.match || this.phase !== "play") return;
      if (this.meta.game === "ptb") {
        PTB.applyInput(this.match, player.id, msg.dx || 0, msg.dy || 0);
      } else {
        QC.applyInput(this.match, player.id, msg.dx || 0, msg.dy || 0, msg.action || null);
      }
      // Keep alarm chain alive
      this._armAlarm();
      return;
    }
  }

  async onAlarm() {
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

  _handleHello(msg, sender) {
    const intent = msg.intent === "join" ? "join" : "create";
    const name = String(msg.name || "Player")
      .slice(0, 12)
      .trim() || "Player";
    const game = this.meta.game;

    if (intent === "join" && this.players.length === 0) {
      send(sender, {
        type: "error",
        message: "No room with that code. Check the code or Create a room.",
      });
      try {
        sender.close();
      } catch (_) {}
      return;
    }

    if (intent === "create" && this.players.length > 0) {
      send(sender, {
        type: "error",
        message: "That room code is busy — try Create again.",
      });
      try {
        sender.close();
      } catch (_) {}
      return;
    }

    if (this.players.length >= (MAX_PLAYERS[game] || 8)) {
      send(sender, { type: "error", message: "Room is full." });
      try {
        sender.close();
      } catch (_) {}
      return;
    }

    if (this.phase !== "lobby") {
      send(sender, {
        type: "error",
        message: "Match already in progress — wait for the next lobby.",
      });
      try {
        sender.close();
      } catch (_) {}
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
    if (isHost) this.hostConnId = sender.id;

    const player = { id, name: finalName, connId: sender.id, isHost };
    this.players.push(player);

    send(sender, {
      type: "welcome",
      id,
      name: finalName,
      game,
      code: this.meta.code,
      isHost,
      kidsMode: this.kidsMode,
      players: this._lobbyPlayers(),
    });
    this._emitLobby(sender.id);
  }

  _lobbyPlayers() {
    return this.players.map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
    }));
  }

  _emitLobby(exceptId) {
    const payload = {
      type: "lobby",
      players: this._lobbyPlayers(),
      code: this.meta.code,
      kidsMode: this.kidsMode,
      hostId: (this.players.find((p) => p.connId === this.hostConnId) || {}).id || null,
    };
    broadcast(this.room, payload);
  }

  _startMatch(kidsMode) {
    const game = this.meta.game;
    const min = MIN_PLAYERS[game] || 2;
    if (this.players.length < min) {
      broadcast(this.room, {
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

    // Personalized start for QC (role secrecy); PTB can share one snapshot
    for (const c of this.room.getConnections()) {
      const pl = this.players.find((p) => p.connId === c.id);
      if (!pl) continue;
      let snapshot;
      if (game === "ptb") {
        snapshot = PTB.serialize(this.match);
      } else {
        snapshot = QC.serializeFor(this.match, pl.id);
      }
      send(c, {
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
    for (const c of this.room.getConnections()) {
      const pl = this.players.find((p) => p.connId === c.id);
      if (!pl) continue;
      let snapshot;
      if (game === "ptb") {
        snapshot = PTB.serialize(this.match);
      } else {
        snapshot = QC.serializeFor(this.match, pl.id);
      }
      send(c, {
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
      await this.room.storage.setAlarm(Date.now() + TICK_MS);
    } catch (e) {
      this._alarmArmed = false;
      // Fallback: if alarms unavailable, rely on input-driven soft ticks
      console.warn("setAlarm failed", e);
    }
  }
}

