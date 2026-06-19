// VoxelCraft Economy SMP Server
// ----------------------------------
// A Node.js WebSocket server with economy, leaderboard, and land claim systems.
// Inspired by the Donut SMP — grind to earn money, claim land, climb the leaderboard.
//
// Features:
//   • Player join/leave with username + mcUsername (skins) + deviceId (bans)
//   • Position relay + block change relay (with land claim enforcement)
//   • Economy: starting balance, kill rewards, death penalties, jobs
//   • Leaderboard: sorted by balance or kills, customizable colors/gradient
//   • Land claims: max 64x64, height limit, whitelist per claim, fluid containment
//   • AutoMod: profanity filter on all chat (VoxelCraft is 8+)
//   • Ban by deviceId (/ban [username] [days])
//   • Duplicate username prevention
//   • Server-side mods from config.json
//   • HTTP GET /status with economy + player info
//
// Requires Node.js 18+ and the `ws` package.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ---------- Load config ----------
const CONFIG_PATH = path.join(__dirname, 'config.json');
function loadConfig() {
  const defaults = {
    port: 3001, maxPlayers: 50, motd: 'Economy SMP', worldSeed: 'economy-smp',
    pvp: true, spawnProtection: true, allowCommands: false,
    mods: { sharks: false, skateboard: false },
    economy: {
      startingBalance: 1000, currencySymbol: '$', currencyName: 'Coins',
      killReward: 50, deathPenalty: 25, jobsEnabled: true,
      jobs: ['Miner', 'Farmer', 'Hunter', 'Builder', 'Fisherman']
    },
    leaderboard: {
      title: 'Top Players', sortBy: 'balance', maxEntries: 10,
      titleColor: '#ffd700', titleGradient: true,
      gradientFrom: '#ffd700', gradientTo: '#ff8c00',
      entryColor: '#ffffff', backgroundColor: 'rgba(0,0,0,0.7)',
      borderColor: '#ffd700', showKills: true, showDeaths: true
    },
    landClaim: {
      enabled: true, maxSize: 64, maxHeight: 'world',
      tool: 'golden_shovel', costPerBlock: 1, maxClaimsPerPlayer: 5,
      fluidContainment: true, whitelistOnly: true
    }
  };
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const merged = { ...defaults, ...parsed };
    merged.mods = { ...defaults.mods, ...(parsed.mods || {}) };
    merged.economy = { ...defaults.economy, ...(parsed.economy || {}) };
    merged.leaderboard = { ...defaults.leaderboard, ...(parsed.leaderboard || {}) };
    merged.landClaim = { ...defaults.landClaim, ...(parsed.landClaim || {}) };
    return merged;
  } catch (err) {
    console.warn('[config] Could not read config.json, using defaults:', err.message);
    return defaults;
  }
}
const config = loadConfig();

// ---------- AutoMod (profanity filter) ----------
const BAD_WORDS = new Set([
  'fuck','fucker','fucking','motherfucker','fuckin','fuk','fukkin',
  'shit','shitty','shite','bullshit','sh1t','bitch','bitching','bitches','bich',
  'ass','asshole','arse','arsehole','dumbass','jackass','dick','dickhead','dicks',
  'cock','cocks','cocksucker','pussy','pussies','cunt','twat','wanker','wank',
  'bollocks','prick','bastard','damn','goddamn','dammit','hell','crap','piss','pissed',
  'slut','sluts','slutty','whore','whores','douche','douchebag','dumbfuck','shitfuck',
  'porn','porno','pornography','hentai','sex','sexy','sexual','horny','nude','naked',
  'nudity','rape','raping','masturbate','masturbation','boob','boobs','breast','breasts',
  'penis','vagina','cum','ejaculate','milf','dildo','nigger','nigga','nig','negro',
  'faggot','fag','fagg','dyke','tranny','trannie','retard','retarded','tard','spaz',
  'spastic','midget','lame','gook','chink','wetback','spic','kraut','kike',
  'cocaine','heroin','meth','crack','weed','marijuana','lsd','ecstasy','nazi','nazis','hitler',
]);
const CHAR_SUBS = { '0':'o','1':'i','3':'e','4':'a','5':'s','7':'t','8':'b','@':'a','$':'s','!':'i','|':'i','+':'t','q':'k' };
function normalizeWord(input) {
  let s = input.toLowerCase();
  s = s.replace(/ph/g, 'f');
  let out = '';
  for (const ch of s) out += CHAR_SUBS[ch] || ch;
  out = out.replace(/v/g, 'u');
  out = out.replace(/[^a-z]/g, '');
  out = out.replace(/(.)\1+/g, '$1');
  return out;
}
function normalizeWordNoCollapse(input) {
  let s = input.toLowerCase();
  s = s.replace(/ph/g, 'f');
  let out = '';
  for (const ch of s) out += CHAR_SUBS[ch] || ch;
  out = out.replace(/v/g, 'u');
  out = out.replace(/[^a-z]/g, '');
  return out;
}
function isBad(normalized) {
  if (normalized.length < 2) return false;
  if (BAD_WORDS.has(normalized)) return true;
  if (normalized.length >= 3) {
    const vowels = 'aeiou';
    for (const bw of BAD_WORDS) {
      if (bw.length === normalized.length + 1) {
        for (let i = 0; i < bw.length; i++) {
          if (vowels.includes(bw[i]) && bw.slice(0, i) + bw.slice(i + 1) === normalized) return true;
        }
      }
    }
  }
  return false;
}
function filterProfanity(message) {
  if (!message) return message;
  return message.replace(/[a-z0-9@$.|!*~_\-+]+/gi, (chunk) => {
    if (isBad(normalizeWord(chunk)) || isBad(normalizeWordNoCollapse(chunk))) return '#'.repeat(chunk.length);
    return chunk;
  });
}

// ---------- Helpers ----------
function hashStringToSeed(str) {
  let h = 5381;
  for (let i = 0; i < String(str).length; i++) h = ((h << 5) + h + String(str).charCodeAt(i)) | 0;
  return h >>> 0;
}
function genId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

const SPAWN_RADIUS = 16;

// ---------- Ban system ----------
const BANS_PATH = path.join(__dirname, 'bans.json');
let bans = new Map();
function loadBans() {
  try {
    const raw = fs.readFileSync(BANS_PATH, 'utf8');
    const arr = JSON.parse(raw);
    let purged = 0;
    const now = Date.now();
    bans.clear();
    for (const b of arr) {
      if (b.until && b.until > 0 && b.until < now) { purged++; continue; }
      bans.set(b.deviceId, b);
    }
    console.log(`[bans] Loaded ${bans.size} ban(s) (purged ${purged} expired).`);
  } catch { bans.clear(); }
}
function saveBans() {
  try { fs.writeFileSync(BANS_PATH, JSON.stringify([...bans.values()], null, 2)); } catch {}
}
function addBan(deviceId, username, days) {
  const until = days > 0 ? Date.now() + days * 86400000 : 0;
  bans.set(deviceId, { deviceId, username, until, bannedAt: Date.now() });
  saveBans();
}
function isBanned(deviceId) { return bans.get(deviceId); }
function removeBan(deviceId) { bans.delete(deviceId); saveBans(); }
loadBans();

// ---------- Player state ----------
const players = new Map(); // ws -> { id, ws, username, mcUsername, deviceId, x, y, z, yaw, pitch, heldItemId, armor, balance, kills, deaths, job }

function snapshotPlayers() {
  const out = [];
  for (const p of players.values()) {
    if (!p.username) continue;
    out.push({
      id: p.id, username: p.username, mcUsername: p.mcUsername,
      x: p.x || 8.5, y: p.y || 40, z: p.z || 8.5, yaw: p.yaw || 0,
      heldItemId: p.heldItemId || 0, isOwner: false,
      balance: p.balance || 0, kills: p.kills || 0, deaths: p.deaths || 0,
    });
  }
  return out;
}

// ---------- Economy system ----------
function getPlayerBalance(p) { return p.balance || 0; }
function setPlayerBalance(p, amount) { p.balance = Math.max(0, Math.floor(amount)); }
function addPlayerBalance(p, amount) { p.balance = Math.max(0, Math.floor((p.balance || 0) + amount)); }
function getLeaderboard() {
  const sortBy = config.leaderboard.sortBy || 'balance';
  const arr = [...players.values()].filter(p => p.username).map(p => ({
    username: p.username, balance: p.balance || 0, kills: p.kills || 0, deaths: p.deaths || 0,
  }));
  arr.sort((a, b) => {
    if (sortBy === 'kills') return b.kills - a.kills;
    return b.balance - a.balance;
  });
  return arr.slice(0, config.leaderboard.maxEntries || 10);
}

// ---------- Land claim system ----------
// Claims: Map of "claimId" -> { id, owner, x1, z1, x2, z2, whitelist: Set, name }
const claims = new Map();
const CLAIMS_PATH = path.join(__dirname, 'claims.json');

function loadClaims() {
  try {
    const raw = fs.readFileSync(CLAIMS_PATH, 'utf8');
    const arr = JSON.parse(raw);
    claims.clear();
    for (const c of arr) {
      c.whitelist = new Set(c.whitelist || []);
      claims.set(c.id, c);
    }
    console.log(`[claims] Loaded ${claims.size} claim(s).`);
  } catch { claims.clear(); }
}
function saveClaims() {
  try {
    const arr = [...claims.values()].map(c => ({ ...c, whitelist: [...c.whitelist] }));
    fs.writeFileSync(CLAIMS_PATH, JSON.stringify(arr, null, 2));
  } catch {}
}
loadClaims();

function getClaimAt(x, z) {
  for (const c of claims.values()) {
    if (x >= c.x1 && x <= c.x2 && z >= c.z1 && z <= c.z2) return c;
  }
  return null;
}

function canBuildInClaim(p, x, z) {
  if (!config.landClaim.enabled) return true;
  const claim = getClaimAt(x, z);
  if (!claim) return true; // Unclaimed land — anyone can build.
  // Owner can always build.
  if (claim.owner === p.username) return true;
  // Whitelisted players can build.
  if (claim.whitelist.has(p.username)) return true;
  // Not whitelisted — denied.
  return false;
}

function createClaim(p, x1, z1, x2, z2) {
  // Normalize corners.
  const cx1 = Math.min(x1, x2), cz1 = Math.min(z1, z2);
  const cx2 = Math.max(x1, x2), cz2 = Math.max(z1, z2);
  const width = cx2 - cx1 + 1;
  const depth = cz2 - cz1 + 1;
  const maxSize = config.landClaim.maxSize || 64;
  if (width > maxSize || depth > maxSize) {
    return { ok: false, msg: `Claim too large! Max size is ${maxSize}x${maxSize}. Yours: ${width}x${depth}.` };
  }
  // Check claim count.
  let count = 0;
  for (const c of claims.values()) if (c.owner === p.username) count++;
  const maxClaims = config.landClaim.maxClaimsPerPlayer || 5;
  if (count >= maxClaims) {
    return { ok: false, msg: `You have reached the maximum of ${maxClaims} claims.` };
  }
  // Check overlap with existing claims.
  for (const c of claims.values()) {
    if (cx1 <= c.x2 && cx2 >= c.x1 && cz1 <= c.z2 && cz2 >= c.z1) {
      return { ok: false, msg: 'Claim overlaps with an existing claim.' };
    }
  }
  // Check balance cost.
  const cost = width * depth * (config.landClaim.costPerBlock || 1);
  if (getPlayerBalance(p) < cost) {
    return { ok: false, msg: `Not enough money! Claim costs ${config.economy.currencySymbol}${cost}. You have ${config.economy.currencySymbol}${getPlayerBalance(p)}.` };
  }
  setPlayerBalance(p, getPlayerBalance(p) - cost);
  const id = 'claim_' + genId();
  const claim = { id, owner: p.username, x1: cx1, z1: cz1, x2: cx2, z2: cz2, whitelist: new Set([p.username]), name: `Claim ${count + 1}` };
  claims.set(id, claim);
  saveClaims();
  return { ok: true, claim, cost };
}

function removeClaim(p, claimId) {
  const c = claims.get(claimId);
  if (!c) return { ok: false, msg: 'Claim not found.' };
  if (c.owner !== p.username) return { ok: false, msg: 'You do not own this claim.' };
  claims.delete(claimId);
  saveClaims();
  return { ok: true };
}

function addWhitelist(p, claimId, username) {
  const c = claims.get(claimId);
  if (!c) return { ok: false, msg: 'Claim not found.' };
  if (c.owner !== p.username) return { ok: false, msg: 'You do not own this claim.' };
  c.whitelist.add(username);
  saveClaims();
  return { ok: true };
}

function removeWhitelist(p, claimId, username) {
  const c = claims.get(claimId);
  if (!c) return { ok: false, msg: 'Claim not found.' };
  if (c.owner !== p.username) return { ok: false, msg: 'You do not own this claim.' };
  c.whitelist.delete(username);
  saveClaims();
  return { ok: true };
}

// Fluid containment: check if a block position is inside a claim.
// The client uses this to prevent water/lava from flowing OUT of a claim.
function isFluidContained(x, z) {
  const claim = getClaimAt(x, z);
  return claim !== null;
}

// ---------- Broadcast ----------
function broadcast(message, exceptWs = null) {
  const data = JSON.stringify(message);
  for (const p of players.values()) {
    if (p.ws === exceptWs) continue;
    if (!p.username) continue;
    try { p.ws.send(data); } catch {}
  }
}

// ---------- HTTP server ----------
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && (req.url === '/status' || req.url === '/status/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      online: true,
      serverType: 'economy',
      playerCount: players.size,
      maxPlayers: config.maxPlayers,
      motd: config.motd,
      pvp: config.pvp,
      worldSeed: config.worldSeed,
      mods: config.mods,
      economy: { currencyName: config.economy.currencyName, startingBalance: config.economy.startingBalance },
      leaderboard: getLeaderboard(),
      landClaim: { enabled: config.landClaim.enabled, maxSize: config.landClaim.maxSize },
    }));
    return;
  }
  if (req.method === 'GET' && (req.url === '/leaderboard' || req.url === '/leaderboard/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      leaderboard: getLeaderboard(),
      config: config.leaderboard,
    }));
    return;
  }
  if (req.method === 'GET' && (req.url === '/claims' || req.url === '/claims/')) {
    const arr = [...claims.values()].map(c => ({ ...c, whitelist: [...c.whitelist] }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(arr));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found. GET /status for server info.');
});

// ---------- WebSocket server ----------
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  const player = { id: genId(), ws, username: '', mcUsername: '', deviceId: '', x: 8.5, y: 40, z: 8.5, yaw: 0, pitch: 0, heldItemId: 0, armor: [null, null, null, null], balance: config.economy.startingBalance, kills: 0, deaths: 0, job: '' };
  players.set(ws, player);
  let alive = true;
  ws.on('pong', () => { alive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object' || !msg.type) return;
    const p = players.get(ws);
    if (!p) return;

    switch (msg.type) {
      case 'set_username': {
        const requestedName = String(msg.username || 'Player').slice(0, 32) || 'Player';
        // Ban check (by deviceId).
        const deviceId = String(msg.deviceId || '').slice(0, 128);
        p.deviceId = deviceId;
        const ban = isBanned(deviceId);
        if (ban) {
          try { ws.send(JSON.stringify({ type: 'banned', data: { msg: 'You are banned from this server', until: ban.until } })); } catch {}
          console.log(`[ban] Rejected ${requestedName} (device=${deviceId || '-'})`);
          players.delete(ws);
          try { ws.close(1008, 'Banned'); } catch {}
          return;
        }
        // Duplicate username check.
        const lowerName = requestedName.toLowerCase();
        for (const other of players.values()) {
          if (other === p) continue;
          if (other.username && other.username.toLowerCase() === lowerName) {
            try { ws.send(JSON.stringify({ type: 'duplicate_name', data: { msg: 'Sorry, someone already has that name in the server currently' } })); } catch {}
            players.delete(ws);
            try { ws.close(1008, 'Duplicate name'); } catch {}
            return;
          }
        }
        p.username = requestedName;
        p.mcUsername = String(msg.mcUsername || '').slice(0, 32);
        // Send join response.
        ws.send(JSON.stringify({
          type: 'joined',
          data: {
            id: p.id,
            players: snapshotPlayers(),
            serverMods: config.mods,
            serverType: 'economy',
            balance: p.balance,
            currencySymbol: config.economy.currencySymbol,
            currencyName: config.economy.currencyName,
            leaderboard: getLeaderboard(),
            leaderboardConfig: config.leaderboard,
            claims: [...claims.values()].map(c => ({ ...c, whitelist: [...c.whitelist] })),
            landClaimConfig: config.landClaim,
            jobs: config.economy.jobsEnabled ? config.economy.jobs : [],
          },
        }));
        broadcast({ type: 'player_joined', data: { id: p.id, username: p.username, mcUsername: p.mcUsername, x: p.x, y: p.y, z: p.z } }, ws);
        console.log(`[join] ${p.username} (balance: ${config.economy.currencySymbol}${p.balance})`);
        break;
      }
      case 'pos': {
        p.x = msg.x; p.y = msg.y; p.z = msg.z; p.yaw = msg.yaw; p.pitch = msg.pitch;
        p.heldItemId = msg.heldItemId || 0;
        if (msg.armor) p.armor = msg.armor;
        if (msg.mcUsername !== undefined) p.mcUsername = msg.mcUsername;
        // Relay to others (throttled by client).
        broadcast({ type: 'player_pos', data: { id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, heldItemId: p.heldItemId, armor: p.armor, mcUsername: p.mcUsername } }, ws);
        break;
      }
      case 'block': {
        const bx = msg.x, by = msg.y, bz = msg.z, blockId = msg.blockId;
        // Spawn protection.
        if (config.spawnProtection && blockId === 0 && Math.abs(bx) < SPAWN_RADIUS && Math.abs(bz) < SPAWN_RADIUS) return;
        // Land claim check: can this player break/place here?
        if (config.landClaim.enabled && !canBuildInClaim(p, bx, bz)) {
          try { ws.send(JSON.stringify({ type: 'claim_denied', data: { x: bx, y: by, z: bz, msg: 'This land is claimed! You are not whitelisted.' } })); } catch {}
          return;
        }
        // Relay the block change.
        broadcast({ type: 'block_update', data: { x: bx, y: by, z: bz, blockId } }, ws);
        break;
      }
      case 'chat': {
        let text = String(msg.msg || '').slice(0, 256);
        if (!text) break;
        text = filterProfanity(text);
        broadcast({ type: 'chat_msg', data: { username: p.username, msg: text } });
        console.log(`[chat] <${p.username}> ${text}`);
        break;
      }
      case 'player_hit': {
        // PvP: player hit another player.
        const target = [...players.values()].find(pp => pp.id === msg.targetId);
        if (!target || target === p) break;
        const damage = msg.damage || 4;
        // Kill reward + death penalty.
        target.deaths = (target.deaths || 0) + 1;
        p.kills = (p.kills || 0) + 1;
        const killReward = config.economy.killReward || 0;
        const deathPenalty = config.economy.deathPenalty || 0;
        addPlayerBalance(p, killReward);
        addPlayerBalance(target, -deathPenalty);
        // Notify both players.
        try { ws.send(JSON.stringify({ type: 'economy_update', data: { balance: p.balance, delta: killReward, reason: `Killed ${target.username}` } })); } catch {}
        try { target.ws.send(JSON.stringify({ type: 'economy_update', data: { balance: target.balance, delta: -deathPenalty, reason: `Killed by ${p.username}` } })); } catch {}
        // Relay hit to target.
        try { target.ws.send(JSON.stringify({ type: 'player_hit', data: { sourceId: p.id, targetId: target.id, damage } })); } catch {}
        // Broadcast updated leaderboard.
        broadcast({ type: 'leaderboard_update', data: { leaderboard: getLeaderboard(), config: config.leaderboard } });
        break;
      }
      case 'claim_create': {
        const result = createClaim(p, msg.x1, msg.z1, msg.x2, msg.z2);
        try { ws.send(JSON.stringify({ type: 'claim_result', data: result })); } catch {}
        if (result.ok) {
          broadcast({ type: 'claim_update', data: { claims: [...claims.values()].map(c => ({ ...c, whitelist: [...c.whitelist] })) } });
          try { ws.send(JSON.stringify({ type: 'economy_update', data: { balance: p.balance, delta: -result.cost, reason: 'Land claim purchase' } })); } catch {}
        }
        break;
      }
      case 'claim_remove': {
        const result = removeClaim(p, msg.claimId);
        try { ws.send(JSON.stringify({ type: 'claim_result', data: result })); } catch {}
        if (result.ok) broadcast({ type: 'claim_update', data: { claims: [...claims.values()].map(c => ({ ...c, whitelist: [...c.whitelist] })) } });
        break;
      }
      case 'claim_whitelist_add': {
        const result = addWhitelist(p, msg.claimId, msg.username);
        try { ws.send(JSON.stringify({ type: 'claim_result', data: result })); } catch {}
        if (result.ok) broadcast({ type: 'claim_update', data: { claims: [...claims.values()].map(c => ({ ...c, whitelist: [...c.whitelist] })) } });
        break;
      }
      case 'claim_whitelist_remove': {
        const result = removeWhitelist(p, msg.claimId, msg.username);
        try { ws.send(JSON.stringify({ type: 'claim_result', data: result })); } catch {}
        if (result.ok) broadcast({ type: 'claim_update', data: { claims: [...claims.values()].map(c => ({ ...c, whitelist: [...c.whitelist] })) } });
        break;
      }
      case 'economy_balance': {
        try { ws.send(JSON.stringify({ type: 'economy_update', data: { balance: p.balance } })); } catch {}
        break;
      }
      case 'leaderboard_request': {
        try { ws.send(JSON.stringify({ type: 'leaderboard_update', data: { leaderboard: getLeaderboard(), config: config.leaderboard } })); } catch {}
        break;
      }
      case 'job_select': {
        if (!config.economy.jobsEnabled) break;
        const jobName = String(msg.job || '').slice(0, 32);
        if (config.economy.jobs.includes(jobName)) {
          p.job = jobName;
          try { ws.send(JSON.stringify({ type: 'job_set', data: { job: jobName } })); } catch {}
          console.log(`[job] ${p.username} selected ${jobName}`);
        }
        break;
      }
      case 'mods': {
        const incoming = msg.mods && typeof msg.mods === 'object' ? msg.mods : {};
        if (typeof incoming.sharks === 'boolean') config.mods.sharks = incoming.sharks;
        if (typeof incoming.skateboard === 'boolean') config.mods.skateboard = incoming.skateboard;
        broadcast({ type: 'mod_sync', data: config.mods });
        console.log(`[mods] Updated: sharks=${config.mods.sharks} skateboard=${config.mods.skateboard}`);
        break;
      }
      default: break;
    }
  });

  ws.on('close', () => {
    const p = players.get(ws);
    if (p && p.username) {
      console.log(`[leave] ${p.username}`);
      broadcast({ type: 'player_left', data: { id: p.id } });
    }
    players.delete(ws);
  });

  ws.on('error', (err) => {
    console.warn('[ws] socket error:', err.message);
  });
});

// ---------- Console commands ----------
const stdin = process.stdin;
stdin.resume();
stdin.setEncoding('utf8');
stdin.on('data', (data) => {
  const line = data.trim();
  if (!line) return;
  const parts = line.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (cmd === '/ban') {
    const username = args[0];
    const days = args[1] ? parseInt(args[1], 10) || 0 : 0;
    if (!username) { console.log('Usage: /ban <username> [days]'); return; }
    const target = [...players.values()].find(p => p.username.toLowerCase() === username.toLowerCase());
    if (!target) { console.log(`Player "${username}" not found.`); return; }
    addBan(target.deviceId, target.username, days);
    try { target.ws.send(JSON.stringify({ type: 'banned', data: { msg: 'You are banned from this server', until: days > 0 ? Date.now() + days * 86400000 : 0 } })); } catch {}
    try { target.ws.close(1008, 'Banned'); } catch {}
    players.delete(target.ws);
    console.log(`[ban] Banned ${target.username} (device=${target.deviceId || '-'}) for ${days > 0 ? days + ' days' : 'permanent'}.`);
  } else if (cmd === '/unban') {
    const username = args[0];
    if (!username) { console.log('Usage: /unban <username>'); return; }
    let found = false;
    for (const [deviceId, b] of bans) {
      if (b.username.toLowerCase() === username.toLowerCase()) { bans.delete(deviceId); found = true; }
    }
    saveBans();
    console.log(found ? `[unban] Unbanned ${username}.` : `No ban found for "${username}".`);
  } else if (cmd === '/bans') {
    if (bans.size === 0) { console.log('No active bans.'); return; }
    console.log('Active bans:');
    for (const b of bans.values()) {
      console.log(`  ${b.username} (device=${b.deviceId || '-'}) ${b.until > 0 ? 'until ' + new Date(b.until).toISOString() : 'permanent'}`);
    }
  } else if (cmd === '/players' || cmd === '/list') {
    if (players.size === 0) { console.log('No players online.'); return; }
    console.log(`Online players (${players.size}):`);
    for (const p of players.values()) {
      if (p.username) console.log(`  ${p.username} | Balance: ${config.economy.currencySymbol}${p.balance || 0} | Kills: ${p.kills || 0} | Deaths: ${p.deaths || 0} | Job: ${p.job || 'none'}`);
    }
  } else if (cmd === '/leaderboard') {
    const lb = getLeaderboard();
    console.log('Leaderboard:');
    lb.forEach((entry, i) => {
      console.log(`  ${i + 1}. ${entry.username} — ${config.economy.currencySymbol}${entry.balance} | ${entry.kills} kills | ${entry.deaths} deaths`);
    });
  } else if (cmd === '/claims') {
    if (claims.size === 0) { console.log('No claims.'); return; }
    console.log(`Claims (${claims.size}):`);
    for (const c of claims.values()) {
      console.log(`  ${c.name} | Owner: ${c.owner} | Area: (${c.x1},${c.z1})-(${c.x2},${c.z2}) | Whitelist: ${[...c.whitelist].join(', ')}`);
    }
  } else if (cmd === '/help') {
    console.log('Commands:');
    console.log('  /ban <user> [days]    — ban a player by deviceId');
    console.log('  /unban <user>         — remove a ban');
    console.log('  /bans                 — list active bans');
    console.log('  /players              — list online players');
    console.log('  /leaderboard          — show leaderboard');
    console.log('  /claims               — list land claims');
    console.log('  /help                 — show this help');
  } else {
    console.log(`Unknown command: ${cmd}. Type /help for commands.`);
  }
});

// ---------- Start ----------
const PORT = Number(config.port) > 0 ? Number(config.port) : (process.env.PORT ? Number(process.env.PORT) : 3001);
httpServer.listen(PORT, () => {
  console.log('============================================');
  console.log('  VoxelCraft Economy SMP Server');
  console.log('============================================');
  console.log(`  Port:           ${PORT}`);
  console.log(`  Max players:    ${config.maxPlayers}`);
  console.log(`  MOTD:           ${config.motd}`);
  console.log(`  World seed:     ${config.worldSeed} (numeric: ${hashStringToSeed(config.worldSeed)})`);
  console.log(`  PVP:            ${config.pvp ? 'ON' : 'OFF'}`);
  console.log(`  Spawn protect:  ${config.spawnProtection ? 'ON (radius ' + SPAWN_RADIUS + ')' : 'OFF'}`);
  console.log(`  Commands:       ${config.allowCommands ? 'ALLOWED' : 'DISABLED (survival-only)'}`);
  console.log(`  Mods:           sharks=${config.mods.sharks ? 'ON' : 'off'}  skateboard=${config.mods.skateboard ? 'ON' : 'off'}`);
  console.log('--------------------------------------------');
  console.log(`  Economy:`);
  console.log(`    Currency:     ${config.economy.currencyName} (${config.economy.currencySymbol})`);
  console.log(`    Starting:     ${config.economy.currencySymbol}${config.economy.startingBalance}`);
  console.log(`    Kill reward:  ${config.economy.currencySymbol}${config.economy.killReward}`);
  console.log(`    Death penalty:${config.economy.currencySymbol}${config.economy.deathPenalty}`);
  console.log(`    Jobs:         ${config.economy.jobsEnabled ? config.economy.jobs.join(', ') : 'disabled'}`);
  console.log('--------------------------------------------');
  console.log(`  Leaderboard:`);
  console.log(`    Sort by:      ${config.leaderboard.sortBy}`);
  console.log(`    Title:        ${config.leaderboard.title}`);
  console.log(`    Gradient:     ${config.leaderboard.titleGradient ? config.leaderboard.gradientFrom + ' → ' + config.leaderboard.gradientTo : 'solid ' + config.leaderboard.titleColor}`);
  console.log('--------------------------------------------');
  console.log(`  Land Claims:`);
  console.log(`    Enabled:      ${config.landClaim.enabled ? 'YES' : 'NO'}`);
  console.log(`    Max size:     ${config.landClaim.maxSize}x${config.landClaim.maxSize}`);
  console.log(`    Max claims:   ${config.landClaim.maxClaimsPerPlayer} per player`);
  console.log(`    Cost:         ${config.economy.currencySymbol}${config.landClaim.costPerBlock}/block`);
  console.log(`    Fluid lock:   ${config.landClaim.fluidContainment ? 'YES (water/lava contained)' : 'NO'}`);
  console.log(`    Whitelist:    ${config.landClaim.whitelistOnly ? 'YES (only whitelisted can build)' : 'NO'}`);
  console.log('--------------------------------------------');
  console.log(`  WebSocket:      ws://localhost:${PORT}`);
  console.log(`  Status:         http://localhost:${PORT}/status`);
  console.log(`  Leaderboard:    http://localhost:${PORT}/leaderboard`);
  console.log(`  Claims:         http://localhost:${PORT}/claims`);
  console.log('============================================');
  console.log('');
  console.log('Console commands: /ban /unban /bans /players /leaderboard /claims /help');
  console.log('');
});

process.on('SIGTERM', () => { console.log('Shutting down...'); process.exit(0); });
process.on('SIGINT', () => { console.log('Shutting down...'); process.exit(0); });
