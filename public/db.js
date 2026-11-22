/*
 * Bolt: Kudosu storage layer.
 * 1) Local persistence: localForage (IndexedDB) for the solved-puzzle set and
 *    player stats; localStorage for the one active puzzle (fast synchronous
 *    save on visibility change).
 * 2) Accounts + sync: Supabase RPCs backed by our own tables
 *    (players / player_progress / solved_puzzles / player_sessions).
 *    Passwords are salted + SHA-256 hashed in the browser; the plain
 *    password never leaves the device. Sessions are bearer tokens that
 *    effectively never expire (10 years), so nobody is ever kicked out.
 */
"use strict";

// ---------------------------------------------------------------------------
// Bolt: Supabase REST endpoints (read from .env-style globals set in index.html)
// ---------------------------------------------------------------------------
const SUPABASE_URL = window.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || "";

// ---------------------------------------------------------------------------
// Bolt: localForage instances (IndexedDB, offline-first)
// ---------------------------------------------------------------------------
const solvedStore = localforage.createInstance({
  name: "kudosu",
  storeName: "solved_puzzles", // key = 81-char puzzle string, value = true
});

const statsStore = localforage.createInstance({
  name: "kudosu",
  storeName: "player_stats",
});

// Current player identity (nickname + session token), kept locally forever.
const sessionStore = localforage.createInstance({
  name: "kudosu",
  storeName: "session",
});

// ---------------------------------------------------------------------------
// Bolt: solved-puzzle tracking (81-char string primary key, memory-efficient)
// ---------------------------------------------------------------------------

/** Save a completed puzzle. `puzzleString` is the 81-char puzzle (0 = empty). */
async function markPuzzleSolved(puzzleString) {
  await solvedStore.setItem(puzzleString, true);
}

/** True if this exact puzzle (81-char string) was already solved. */
async function isPuzzleSolved(puzzleString) {
  const hit = await solvedStore.getItem(puzzleString);
  return hit === true;
}

/** All solved puzzles as an array of 81-char strings (for export / sync). */
async function getAllSolvedPuzzles() {
  const out = [];
  await solvedStore.iterate((value, key) => {
    if (value === true && typeof key === "string" && key.length === 81) {
      out.push(key);
    }
  });
  return out;
}

/** Import a batch of 81-char strings (used by sync + export/import). */
async function importSolvedPuzzles(list) {
  if (!Array.isArray(list)) return 0;
  let added = 0;
  for (const p of list) {
    if (typeof p === "string" && p.length === 81 && /^[0-9]{81}$/.test(p)) {
      const had = await solvedStore.getItem(p);
      if (had !== true) {
        await solvedStore.setItem(p, true);
        added++;
      }
    }
  }
  return added;
}

// ---------------------------------------------------------------------------
// Bolt: local player stats (single object, defaults applied on load)
// ---------------------------------------------------------------------------
const DEFAULT_STATS = {
  gold: 0,
  hp: 5,
  maxHp: 5,
  maxHpBuys: 0,
  xp: 0,
  hpUpdatedAt: Date.now(),
  lastModified: 0,
};

async function loadLocalStats() {
  const raw = await statsStore.getItem("stats");
  const stats = Object.assign({}, DEFAULT_STATS, raw || {});
  if (typeof stats.hpUpdatedAt !== "number") stats.hpUpdatedAt = Date.now();
  return stats;
}

async function saveLocalStats(stats) {
  await statsStore.setItem("stats", stats);
}

// ---------------------------------------------------------------------------
// Bolt: active puzzle in localStorage (synchronous, survives instant kills)
// Key: kudosu_active_puzzle = { puzzle, difficulty, cells, candidates, ... }
// ---------------------------------------------------------------------------
const ACTIVE_KEY = "kudosu_active_puzzle";

function saveActivePuzzle(state) {
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("Kudosu: could not save active puzzle", e);
  }
}

function loadActivePuzzle() {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function clearActivePuzzle() {
  try {
    localStorage.removeItem(ACTIVE_KEY);
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Bolt: password hashing (salted SHA-256, hex output)
// ---------------------------------------------------------------------------
// Bolt: password hashing — sha256(nickname + password + "kudosu"), hex output.
// Matches the scheme used for the admin account seed.
async function hashPassword(nickname, password) {
  const data = new TextEncoder().encode(
    `${nickname.toLowerCase()}${password}kudosu`
  );
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Bolt: session helpers
// ---------------------------------------------------------------------------
async function getSavedSession() {
  return sessionStore.getItem("session"); // { nickname, token } or null
}

async function setSavedSession(session) {
  if (session) {
    await sessionStore.setItem("session", session);
  } else {
    await sessionStore.removeItem("session");
  }
}

// ---------------------------------------------------------------------------
// Bolt: Supabase RPC wrapper (does NOT use the supabase-js SDK, plain fetch)
// ---------------------------------------------------------------------------
async function callRpc(fn, args) {
  // Bolt: direct call to the Supabase database (the project's connected
  // backend). No intermediate proxy.
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(args),
    });
  } catch (e) {
    throw new Error(
      "No connection to the game server. Check internet once to sign in or sync."
    );
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Bolt: account actions (first login requires network; after that offline)
// ---------------------------------------------------------------------------
async function registerAccount(nickname, password) {
  const hash = await hashPassword(nickname, password);
  const token = await callRpc("kudosu_register", {
    p_nickname: nickname,
    p_password_hash: hash,
  });
  const session = { nickname: nickname.toLowerCase(), token };
  await setSavedSession(session);
  return session;
}

async function loginAccount(nickname, password) {
  const hash = await hashPassword(nickname, password);
  const token = await callRpc("kudosu_login", {
    p_nickname: nickname,
    p_password_hash: hash,
  });
  const session = { nickname: nickname.toLowerCase(), token };
  await setSavedSession(session);
  return session;
}

async function logoutAccount() {
  await setSavedSession(null);
}

// ---------------------------------------------------------------------------
// Bolt: sync (Save button). Last-Write-Wins via lastModified; solved merged.
// ---------------------------------------------------------------------------
async function syncToServer() {
  const session = await getSavedSession();
  if (!session || !session.token) {
    throw new Error("Not signed in");
  }
  const stats = await loadLocalStats();
  const solved = await getAllSolvedPuzzles();

  const result = await callRpc("kudosu_save", {
    p_token: session.token,
    p_gold: Math.round(stats.gold),
    p_hp: Math.round(stats.hp),
    p_max_hp: Math.round(stats.maxHp),
    p_max_hp_buys: Math.round(stats.maxHpBuys),
    p_xp: Math.round(stats.xp),
    p_hp_updated_at: new Date(stats.hpUpdatedAt || Date.now()).toISOString(),
    p_last_modified: new Date(stats.lastModified || Date.now()).toISOString(),
    p_solved: solved,
  });
  return result;
}

/** Pull server progress (used after login on a fresh device). */
async function loadFromServer() {
  const session = await getSavedSession();
  if (!session || !session.token) {
    throw new Error("Not signed in");
  }
  return callRpc("kudosu_load", { p_token: session.token });
}

// Expose to the game layer (no modules needed — plain script tags).
window.KudosuDB = {
  markPuzzleSolved,
  isPuzzleSolved,
  getAllSolvedPuzzles,
  importSolvedPuzzles,
  loadLocalStats,
  saveLocalStats,
  saveActivePuzzle,
  loadActivePuzzle,
  clearActivePuzzle,
  getSavedSession,
  registerAccount,
  loginAccount,
  logoutAccount,
  syncToServer,
  loadFromServer,
};
