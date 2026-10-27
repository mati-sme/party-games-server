/**
 * Authoritative match simulation (runs on host).
 * World units: map is MAP_W x MAP_H. Players are circles.
 */
'use strict';

export const MAP_W = 720;
export const MAP_H = 1100;
export const PLAYER_R = 28;
export const SPEED = 220;           // px/s
export const TAG_DIST = 56;         // center-to-center for pass
export const FUSE_NORMAL = 12;      // seconds
export const FUSE_KIDS = 22;
export const COLORS = ['#5b8cff', '#5dff8a', '#ff6b9d', '#ffd84a', '#b07cff', '#5de0ff', '#ff9a5b', '#e0e0e0'];

/** Simple obstacle rects (x,y,w,h) in world space. */
export const OBSTACLES = [
  { x: 160, y: 220, w: 120, h: 40 },
  { x: 440, y: 220, w: 120, h: 40 },
  { x: 300, y: 420, w: 120, h: 40 },
  { x: 80,  y: 560, w: 40,  h: 160 },
  { x: 600, y: 560, w: 40,  h: 160 },
  { x: 200, y: 780, w: 100, h: 40 },
  { x: 420, y: 780, w: 100, h: 40 },
  { x: 310, y: 960, w: 100, h: 40 },
];

const PAD = PLAYER_R + 4;

export function makePlayer(id, name, colorIdx, x, y) {
  return {
    id, name: (name || 'Player').slice(0, 12),
    color: COLORS[colorIdx % COLORS.length],
    x, y, vx: 0, vy: 0,
    alive: true, out: false,
  };
}

export function spawnPoints(n) {
  const pts = [];
  const cx = MAP_W / 2, cy = MAP_H / 2;
  const r = Math.min(MAP_W, MAP_H) * 0.28;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}

function circleHitsRect(cx, cy, r, o) {
  const nx = Math.max(o.x, Math.min(cx, o.x + o.w));
  const ny = Math.max(o.y, Math.min(cy, o.y + o.h));
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

function resolvePos(x, y) {
  x = Math.max(PAD, Math.min(MAP_W - PAD, x));
  y = Math.max(PAD, Math.min(MAP_H - PAD, y));
  for (const o of OBSTACLES) {
    if (!circleHitsRect(x, y, PLAYER_R, o)) continue;
    // push out along nearest axis
    const left = Math.abs((x + PLAYER_R) - o.x);
    const right = Math.abs((o.x + o.w) - (x - PLAYER_R));
    const top = Math.abs((y + PLAYER_R) - o.y);
    const bot = Math.abs((o.y + o.h) - (y - PLAYER_R));
    const m = Math.min(left, right, top, bot);
    if (m === left) x = o.x - PLAYER_R;
    else if (m === right) x = o.x + o.w + PLAYER_R;
    else if (m === top) y = o.y - PLAYER_R;
    else y = o.y + o.h + PLAYER_R;
  }
  x = Math.max(PAD, Math.min(MAP_W - PAD, x));
  y = Math.max(PAD, Math.min(MAP_H - PAD, y));
  return { x, y };
}

export function createMatch(players, kidsMode) {
  const fuseMax = kidsMode ? FUSE_KIDS : FUSE_NORMAL;
  const pts = spawnPoints(players.length);
  const list = players.map((p, i) => makePlayer(p.id, p.name, i, pts[i].x, pts[i].y));
  const alive = list.filter((p) => p.alive);
  const boomId = alive[Math.floor(Math.random() * alive.length)].id;
  return {
    phase: 'play', // play | win
    kidsMode: !!kidsMode,
    fuseMax,
    fuse: fuseMax,
    boomId,
    winnerId: null,
    players: list,
    tagCooldown: 0, // brief lock after pass so it doesn't bounce instantly
    events: [],     // consumed by host each tick for SFX/toasts
  };
}

export function applyInput(match, id, dx, dy) {
  const p = match.players.find((pl) => pl.id === id);
  if (!p || !p.alive) return;
  const len = Math.hypot(dx, dy);
  if (len > 1.01) { dx /= len; dy /= len; }
  p.vx = dx; p.vy = dy;
}

function pickRandomAlive(match, excludeId) {
  const pool = match.players.filter((p) => p.alive && p.id !== excludeId);
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function explode(match, holder) {
  holder.alive = false;
  holder.out = true;
  holder.vx = holder.vy = 0;
  match.events.push({ type: 'boom', id: holder.id, name: holder.name });
  const remaining = match.players.filter((p) => p.alive);
  if (remaining.length <= 1) {
    match.phase = 'win';
    match.winnerId = remaining[0] ? remaining[0].id : null;
    match.boomId = null;
    match.fuse = 0;
    match.events.push({ type: 'win', id: match.winnerId });
    return;
  }
  const next = pickRandomAlive(match, holder.id);
  match.boomId = next.id;
  match.fuse = match.fuseMax;
  match.tagCooldown = 0.6;
  match.events.push({ type: 'pass', id: next.id, name: next.name, reason: 'respawn' });
}

export function step(match, dt) {
  if (match.phase !== 'play') return match.events.splice(0);

  match.tagCooldown = Math.max(0, match.tagCooldown - dt);

  for (const p of match.players) {
    if (!p.alive) continue;
    const nx = p.x + p.vx * SPEED * dt;
    const ny = p.y + p.vy * SPEED * dt;
    const pos = resolvePos(nx, ny);
    p.x = pos.x; p.y = pos.y;
  }

  // Fuse only ticks while someone holds the boom
  if (match.boomId) {
    match.fuse -= dt;
    if (match.fuse <= 0) {
      const holder = match.players.find((p) => p.id === match.boomId);
      if (holder && holder.alive) explode(match, holder);
      else match.fuse = 0;
    }
  }

  // Proximity tag: boom holder must touch another alive player
  if (match.boomId && match.tagCooldown <= 0 && match.phase === 'play') {
    const holder = match.players.find((p) => p.id === match.boomId);
    if (holder && holder.alive) {
      for (const other of match.players) {
        if (!other.alive || other.id === holder.id) continue;
        const d = Math.hypot(holder.x - other.x, holder.y - other.y);
        if (d <= TAG_DIST) {
          match.boomId = other.id;
          match.fuse = match.fuseMax; // reset fuse on pass
          match.tagCooldown = 0.55;
          match.events.push({ type: 'pass', id: other.id, name: other.name, reason: 'tag' });
          break;
        }
      }
    }
  }

  return match.events.splice(0);
}

/** Compact snapshot for network. */
export function serialize(match) {
  return {
    phase: match.phase,
    kidsMode: match.kidsMode,
    fuseMax: match.fuseMax,
    fuse: +match.fuse.toFixed(2),
    boomId: match.boomId,
    winnerId: match.winnerId,
    tagCooldown: +match.tagCooldown.toFixed(2),
    players: match.players.map((p) => ({
      id: p.id, name: p.name, color: p.color,
      x: Math.round(p.x), y: Math.round(p.y),
      alive: p.alive, out: p.out,
    })),
  };
}

export function applySnapshot(match, snap) {
  if (!match) match = { players: [] };
  match.phase = snap.phase;
  match.kidsMode = snap.kidsMode;
  match.fuseMax = snap.fuseMax;
  match.fuse = snap.fuse;
  match.boomId = snap.boomId;
  match.winnerId = snap.winnerId;
  match.tagCooldown = snap.tagCooldown;
  match.events = match.events || [];
  const byId = new Map(match.players.map((p) => [p.id, p]));
  match.players = snap.players.map((sp) => {
    const prev = byId.get(sp.id);
    return prev
      ? Object.assign(prev, sp)
      : { ...sp, vx: 0, vy: 0 };
  });
  return match;
}
