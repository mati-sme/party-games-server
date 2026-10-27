/**
 * Quiet Courier — authoritative match simulation (runs on host).
 * Couriers deliver color-matched packages; one (or two) silent saboteur(s)
 * quietly mess with packages / drop zones. No kills, no voting (v1).
 */
'use strict';

export const MAP_W = 720;
export const MAP_H = 1100;
export const PLAYER_R = 26;
export const PKG_R = 16;
export const SPEED = 200;
export const PICK_DIST = 44;
export const DROP_DIST = 48;
export const SAB_RANGE = 70;

export const COLORS = ['#5b8cff', '#5dff8a', '#ff6b9d', '#ffd84a', '#b07cff', '#5de0ff', '#ff9a5b', '#e0e0e0'];
export const PKG_COLORS = [
  { id: 'red', hex: '#ff5a6a', label: 'Red' },
  { id: 'blue', hex: '#5b8cff', label: 'Blue' },
  { id: 'green', hex: '#5dff8a', label: 'Green' },
  { id: 'yellow', hex: '#ffd84a', label: 'Yellow' },
];

export const OBSTACLES = [
  // outer walls are map bounds; inner room dividers with door gaps
  { x: 0, y: 280, w: 260, h: 28 },
  { x: 400, y: 280, w: 320, h: 28 },
  { x: 0, y: 560, w: 200, h: 28 },
  { x: 340, y: 560, w: 380, h: 28 },
  { x: 0, y: 820, w: 280, h: 28 },
  { x: 420, y: 820, w: 300, h: 28 },
  { x: 200, y: 0, w: 28, h: 180 },
  { x: 480, y: 100, w: 28, h: 180 },
  { x: 340, y: 320, w: 28, h: 160 },
  { x: 140, y: 600, w: 28, h: 140 },
  { x: 520, y: 600, w: 28, h: 140 },
  { x: 300, y: 860, w: 28, h: 160 },
];

/** Pickup pads (packages spawn here). */
export const PICKUPS = [
  { x: 100, y: 120 },
  { x: 620, y: 120 },
  { x: 100, y: 420 },
  { x: 620, y: 420 },
  { x: 100, y: 700 },
  { x: 620, y: 700 },
  { x: 360, y: 980 },
];

/** Color-coded drop-off zones. */
export const DROPS = [
  { colorId: 'red', x: 90, y: 980, w: 100, h: 70 },
  { colorId: 'blue', x: 530, y: 980, w: 100, h: 70 },
  { colorId: 'green', x: 90, y: 40, w: 100, h: 70 },
  { colorId: 'yellow', x: 530, y: 40, w: 100, h: 70 },
];

const PET_EMOJIS = ['🐱', '🐶', '🐰', '🦊', '🐼'];
const PAD = PLAYER_R + 4;

function pkgColor(id) {
  return PKG_COLORS.find((c) => c.id === id) || PKG_COLORS[0];
}

export function makePlayer(id, name, colorIdx, x, y, role) {
  return {
    id,
    name: (name || 'Player').slice(0, 12),
    color: COLORS[colorIdx % COLORS.length],
    x, y, vx: 0, vy: 0,
    role, // 'courier' | 'saboteur'
    carrying: null, // package id or null
    action: null,   // pending saboteur action request
    misdirectT: 0,  // seconds of reversed controls left
  };
}

export function spawnPoints(n) {
  const pts = [];
  const cx = MAP_W / 2, cy = MAP_H / 2;
  const r = Math.min(MAP_W, MAP_H) * 0.26;
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

function resolvePos(x, y, radius) {
  const pad = (radius || PLAYER_R) + 4;
  x = Math.max(pad, Math.min(MAP_W - pad, x));
  y = Math.max(pad, Math.min(MAP_H - pad, y));
  for (const o of OBSTACLES) {
    if (!circleHitsRect(x, y, radius || PLAYER_R, o)) continue;
    const left = Math.abs((x + (radius || PLAYER_R)) - o.x);
    const right = Math.abs((o.x + o.w) - (x - (radius || PLAYER_R)));
    const top = Math.abs((y + (radius || PLAYER_R)) - o.y);
    const bot = Math.abs((o.y + o.h) - (y - (radius || PLAYER_R)));
    const m = Math.min(left, right, top, bot);
    if (m === left) x = o.x - (radius || PLAYER_R);
    else if (m === right) x = o.x + o.w + (radius || PLAYER_R);
    else if (m === top) y = o.y - (radius || PLAYER_R);
    else y = o.y + o.h + (radius || PLAYER_R);
  }
  x = Math.max(pad, Math.min(MAP_W - pad, x));
  y = Math.max(pad, Math.min(MAP_H - pad, y));
  return { x, y };
}

function assignRoles(n) {
  const sabCount = n >= 6 ? 2 : 1;
  const roles = Array(n).fill('courier');
  const idxs = [...Array(n).keys()];
  for (let i = idxs.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
  }
  for (let i = 0; i < sabCount; i++) roles[idxs[i]] = 'saboteur';
  return roles;
}

function makePackage(id, colorId, x, y) {
  return { id, colorId, x, y, carriedBy: null, wrongDrop: false };
}

function spawnPackages(count) {
  const pkgs = [];
  const pads = PICKUPS.slice();
  for (let i = pads.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [pads[i], pads[j]] = [pads[j], pads[i]];
  }
  for (let i = 0; i < count; i++) {
    const pad = pads[i % pads.length];
    const jitter = { x: pad.x + (Math.random() - 0.5) * 20, y: pad.y + (Math.random() - 0.5) * 20 };
    const colorId = PKG_COLORS[i % PKG_COLORS.length].id;
    pkgs.push(makePackage('pkg_' + i + '_' + Math.random().toString(36).slice(2, 5), colorId, jitter.x, jitter.y));
  }
  return pkgs;
}

function makePets(n) {
  const pets = [];
  for (let i = 0; i < n; i++) {
    pets.push({
      id: 'pet_' + i,
      emoji: PET_EMOJIS[i % PET_EMOJIS.length],
      x: 80 + Math.random() * (MAP_W - 160),
      y: 80 + Math.random() * (MAP_H - 160),
      vx: (Math.random() - 0.5) * 0.6,
      vy: (Math.random() - 0.5) * 0.6,
      wanderT: 1 + Math.random() * 3,
    });
  }
  return pets;
}

export function createMatch(players, kidsMode) {
  const n = players.length;
  const roles = assignRoles(n);
  const pts = spawnPoints(n);
  const list = players.map((p, i) => makePlayer(p.id, p.name, i, pts[i].x, pts[i].y, roles[i]));

  const roundTime = kidsMode ? 150 : 105; // seconds
  const quota = Math.max(4, Math.min(10, 2 + Math.floor(n * 1.2)));
  const sabCd = kidsMode ? 14 : 8; // seconds between sab powers

  const pkgCount = Math.max(5, Math.min(8, 3 + n));
  const packages = spawnPackages(pkgCount);
  const pets = makePets(2 + (n >= 5 ? 1 : 0));

  const jammed = {}; // colorId -> seconds remaining
  for (const d of DROPS) jammed[d.colorId] = 0;

  return {
    phase: 'play', // play | win
    kidsMode: !!kidsMode,
    timeLeft: roundTime,
    roundTime,
    quota,
    delivered: 0,
    failed: 0,
    failLimit: Math.max(3, Math.ceil(quota * 0.6)),
    winnerSide: null, // 'couriers' | 'saboteur'
    saboteurs: list.filter((p) => p.role === 'saboteur').map((p) => p.id),
    players: list,
    packages,
    pets,
    jammed,
    sabCooldown: {}, // playerId -> seconds
    nextPkgId: pkgCount,
    events: [],
    reveal: false, // end-of-round reveal flag
  };
}

export function applyInput(match, id, dx, dy, action) {
  const p = match.players.find((pl) => pl.id === id);
  if (!p || match.phase !== 'play') return;
  if (p.misdirectT > 0) { dx = -dx; dy = -dy; }
  const len = Math.hypot(dx, dy);
  if (len > 1.01) { dx /= len; dy /= len; }
  p.vx = dx; p.vy = dy;
  if (action) p.action = action;
}

function nearestFreePackage(match, x, y) {
  let best = null, bestD = PICK_DIST;
  for (const pkg of match.packages) {
    if (pkg.carriedBy) continue;
    const d = Math.hypot(pkg.x - x, pkg.y - y);
    if (d < bestD) { bestD = d; best = pkg; }
  }
  return best;
}

function dropZoneAt(x, y) {
  for (const d of DROPS) {
    if (x >= d.x && x <= d.x + d.w && y >= d.y && y <= d.y + d.h) return d;
  }
  // also accept near center
  for (const d of DROPS) {
    const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
    if (Math.hypot(x - cx, y - cy) <= DROP_DIST) return d;
  }
  return null;
}

function respawnPackage(match) {
  const pad = PICKUPS[(Math.random() * PICKUPS.length) | 0];
  const colorId = PKG_COLORS[(Math.random() * PKG_COLORS.length) | 0].id;
  const id = 'pkg_' + (match.nextPkgId++) + '_' + Math.random().toString(36).slice(2, 5);
  match.packages.push(makePackage(id, colorId, pad.x, pad.y));
}

function tryPickup(match, p) {
  if (p.carrying) return;
  const pkg = nearestFreePackage(match, p.x, p.y);
  if (!pkg) return;
  pkg.carriedBy = p.id;
  p.carrying = pkg.id;
  match.events.push({ type: 'pickup', id: p.id, name: p.name, colorId: pkg.colorId });
}

function tryDeliver(match, p) {
  if (!p.carrying) return;
  const pkg = match.packages.find((k) => k.id === p.carrying);
  if (!pkg) { p.carrying = null; return; }
  const zone = dropZoneAt(p.x, p.y);
  if (!zone) return;
  if (match.jammed[zone.colorId] > 0) {
    match.events.push({ type: 'jammed', id: p.id, name: p.name, colorId: zone.colorId });
    return;
  }
  // drop package from carrier
  pkg.carriedBy = null;
  p.carrying = null;
  match.packages = match.packages.filter((k) => k.id !== pkg.id);

  if (pkg.colorId === zone.colorId) {
    match.delivered++;
    match.events.push({ type: 'deliver', id: p.id, name: p.name, colorId: pkg.colorId });
    respawnPackage(match);
    if (match.delivered >= match.quota) {
      match.phase = 'win';
      match.winnerSide = 'couriers';
      match.reveal = true;
      match.events.push({ type: 'win', side: 'couriers' });
    }
  } else {
    match.failed++;
    match.events.push({ type: 'wrong', id: p.id, name: p.name, colorId: pkg.colorId, zone: zone.colorId });
    respawnPackage(match);
    if (match.failed >= match.failLimit) {
      match.phase = 'win';
      match.winnerSide = 'saboteur';
      match.reveal = true;
      match.events.push({ type: 'win', side: 'saboteur' });
    }
  }
}

function sabCdLeft(match, id) {
  return match.sabCooldown[id] || 0;
}

function setSabCd(match, id) {
  const base = match.kidsMode ? 14 : 8;
  match.sabCooldown[id] = base;
}

function doSaboteurAction(match, p) {
  if (p.role !== 'saboteur' || !p.action) return;
  const act = p.action;
  p.action = null;
  if (sabCdLeft(match, p.id) > 0) {
    match.events.push({ type: 'sab_cd', id: p.id });
    return;
  }

  if (act === 'jam') {
    // jam nearest drop zone
    let best = null, bestD = SAB_RANGE + 40;
    for (const d of DROPS) {
      const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
      const dist = Math.hypot(p.x - cx, p.y - cy);
      if (dist < bestD) { bestD = dist; best = d; }
    }
    if (!best) return;
    const dur = match.kidsMode ? 4 : 6;
    match.jammed[best.colorId] = dur;
    setSabCd(match, p.id);
    match.events.push({
      type: 'jam', id: p.id, colorId: best.colorId,
      tell: !!match.kidsMode, // clearer tell in kids mode
    });
    return;
  }

  if (act === 'swap') {
    // swap color of nearest free or carried package near saboteur
    let best = null, bestD = SAB_RANGE;
    for (const pkg of match.packages) {
      let px = pkg.x, py = pkg.y;
      if (pkg.carriedBy) {
        const carrier = match.players.find((pl) => pl.id === pkg.carriedBy);
        if (carrier) { px = carrier.x; py = carrier.y; }
      }
      const dist = Math.hypot(p.x - px, p.y - py);
      if (dist < bestD) { bestD = dist; best = pkg; }
    }
    if (!best) return;
    const cur = PKG_COLORS.findIndex((c) => c.id === best.colorId);
    best.colorId = PKG_COLORS[(cur + 1 + ((Math.random() * 2) | 0)) % PKG_COLORS.length].id;
    setSabCd(match, p.id);
    match.events.push({
      type: 'swap', id: p.id, pkgId: best.id, colorId: best.colorId,
      tell: !!match.kidsMode,
    });
    return;
  }

  if (act === 'misdirect') {
    // briefly reverse nearest other player's controls
    let best = null, bestD = SAB_RANGE + 30;
    for (const other of match.players) {
      if (other.id === p.id) continue;
      const dist = Math.hypot(p.x - other.x, p.y - other.y);
      if (dist < bestD) { bestD = dist; best = other; }
    }
    if (!best) return;
    // also make them drop package if carrying (subtle sabotage)
    if (best.carrying) {
      const pkg = match.packages.find((k) => k.id === best.carrying);
      if (pkg) {
        pkg.carriedBy = null;
        pkg.x = best.x + (Math.random() - 0.5) * 30;
        pkg.y = best.y + (Math.random() - 0.5) * 30;
      }
      best.carrying = null;
    }
    best.misdirectT = match.kidsMode ? 2.2 : 3.5;
    setSabCd(match, p.id);
    match.events.push({
      type: 'misdirect', id: p.id, targetId: best.id, targetName: best.name,
      tell: !!match.kidsMode,
    });
  }
}

function stepPets(match, dt) {
  const petSpeed = 55;
  for (const pet of match.pets) {
    pet.wanderT -= dt;
    if (pet.wanderT <= 0) {
      pet.vx = (Math.random() - 0.5) * 1.4;
      pet.vy = (Math.random() - 0.5) * 1.4;
      const len = Math.hypot(pet.vx, pet.vy) || 1;
      pet.vx /= len; pet.vy /= len;
      pet.wanderT = 1.5 + Math.random() * 3.5;
    }
    const nx = pet.x + pet.vx * petSpeed * dt;
    const ny = pet.y + pet.vy * petSpeed * dt;
    const pos = resolvePos(nx, ny, 14);
    // bounce if stuck on wall
    if (Math.abs(pos.x - nx) > 0.5) pet.vx *= -1;
    if (Math.abs(pos.y - ny) > 0.5) pet.vy *= -1;
    pet.x = pos.x; pet.y = pos.y;
  }
}

export function step(match, dt) {
  if (match.phase !== 'play') return match.events.splice(0);

  match.timeLeft -= dt;
  if (match.timeLeft <= 0) {
    match.timeLeft = 0;
    match.phase = 'win';
    match.winnerSide = 'saboteur';
    match.reveal = true;
    match.events.push({ type: 'win', side: 'saboteur', reason: 'timeout' });
    return match.events.splice(0);
  }

  // sab cooldowns
  for (const id of Object.keys(match.sabCooldown)) {
    match.sabCooldown[id] = Math.max(0, match.sabCooldown[id] - dt);
  }
  for (const c of Object.keys(match.jammed)) {
    match.jammed[c] = Math.max(0, match.jammed[c] - dt);
  }

  for (const p of match.players) {
    if (p.misdirectT > 0) p.misdirectT = Math.max(0, p.misdirectT - dt);
    const nx = p.x + p.vx * SPEED * dt;
    const ny = p.y + p.vy * SPEED * dt;
    const pos = resolvePos(nx, ny);
    p.x = pos.x; p.y = pos.y;

    // update carried package position
    if (p.carrying) {
      const pkg = match.packages.find((k) => k.id === p.carrying);
      if (pkg) { pkg.x = p.x; pkg.y = p.y - 28; }
    }

    doSaboteurAction(match, p);

    // auto pickup / deliver for couriers (and saboteurs can also deliver/fake)
    tryPickup(match, p);
    tryDeliver(match, p);
  }

  stepPets(match, dt);

  return match.events.splice(0);
}

export function serialize(match) {
  return {
    phase: match.phase,
    kidsMode: match.kidsMode,
    timeLeft: +match.timeLeft.toFixed(2),
    roundTime: match.roundTime,
    quota: match.quota,
    delivered: match.delivered,
    failed: match.failed,
    failLimit: match.failLimit,
    winnerSide: match.winnerSide,
    saboteurs: match.reveal ? match.saboteurs : [], // only reveal at end
    reveal: match.reveal,
    jammed: { ...match.jammed },
    sabCooldown: { ...match.sabCooldown },
    players: match.players.map((p) => ({
      id: p.id, name: p.name, color: p.color,
      x: Math.round(p.x), y: Math.round(p.y),
      role: match.reveal ? p.role : (p.id === undefined ? 'courier' : undefined),
      // each client learns ONLY their own role via separate welcome — see below
      carrying: p.carrying,
      misdirectT: +p.misdirectT.toFixed(2),
      _roleSelf: p.role, // host strips per-client; we include for host local; clients get patched
    })),
    packages: match.packages.map((k) => ({
      id: k.id, colorId: k.colorId,
      x: Math.round(k.x), y: Math.round(k.y),
      carriedBy: k.carriedBy,
    })),
    pets: match.pets.map((pet) => ({
      id: pet.id, emoji: pet.emoji,
      x: Math.round(pet.x), y: Math.round(pet.y),
    })),
  };
}

/** Build a snapshot for one client — hides other players' roles until reveal. */
export function serializeFor(match, viewerId) {
  const snap = serialize(match);
  snap.players = snap.players.map((p) => {
    const role = (match.reveal || p.id === viewerId) ? p._roleSelf : null;
    const { _roleSelf, ...rest } = p;
    return { ...rest, role };
  });
  // saboteur list only on reveal
  if (!match.reveal) snap.saboteurs = [];
  return snap;
}

export function applySnapshot(match, snap) {
  if (!match) match = { players: [], packages: [], pets: [], jammed: {}, sabCooldown: {}, events: [] };
  match.phase = snap.phase;
  match.kidsMode = snap.kidsMode;
  match.timeLeft = snap.timeLeft;
  match.roundTime = snap.roundTime;
  match.quota = snap.quota;
  match.delivered = snap.delivered;
  match.failed = snap.failed;
  match.failLimit = snap.failLimit;
  match.winnerSide = snap.winnerSide;
  match.saboteurs = snap.saboteurs || [];
  match.reveal = !!snap.reveal;
  match.jammed = snap.jammed || {};
  match.sabCooldown = snap.sabCooldown || {};
  match.events = match.events || [];

  const byId = new Map((match.players || []).map((p) => [p.id, p]));
  match.players = (snap.players || []).map((sp) => {
    const prev = byId.get(sp.id);
    const role = sp.role != null ? sp.role : (prev && prev.role);
    return prev
      ? Object.assign(prev, sp, { role: role || prev.role, vx: prev.vx || 0, vy: prev.vy || 0 })
      : { ...sp, role: role || 'courier', vx: 0, vy: 0, action: null, misdirectT: sp.misdirectT || 0 };
  });

  match.packages = (snap.packages || []).map((k) => ({ ...k }));
  match.pets = (snap.pets || []).map((pet) => ({ ...pet, vx: 0, vy: 0, wanderT: 1 }));
  return match;
}

export function myRole(match, localId) {
  const p = match && match.players.find((pl) => pl.id === localId);
  return p ? p.role : null;
}
