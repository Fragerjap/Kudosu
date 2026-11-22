/*
 * Bolt: Kudosu storage layer (local-only, no external services).
 * 1) Local persistence: localForage (IndexedDB) for the solved-puzzle set and
 *    player stats; localStorage for the one active puzzle (fast synchronous
 *    save on visibility change).
 * 2) Export/import: one .txt file — row 1 is player stats (CSV header + values),
 *    remaining rows are 81-char solved-puzzle strings. Fully offline.
 */
"use strict";

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

/** All solved puzzles as an array of 81-char strings (for export). */
async function getAllSolvedPuzzles() {
  const out = [];
  await solvedStore.iterate((value, key) => {
    if (value === true && typeof key === "string" && key.length === 81) {
      out.push(key);
    }
  });
  return out;
}

/** Import a batch of 81-char strings (used by import). Returns count added. */
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
// Bolt: export — single .txt file. Row 1 = stats CSV, rows 2+ = solved puzzles.
// Format: gold,hp,maxHp,maxHpBuys,xp,hpUpdatedAt,lastModified
// ---------------------------------------------------------------------------
async function exportData() {
  const stats = await loadLocalStats();
  const solved = await getAllSolvedPuzzles();
  const header = "gold,hp,maxHp,maxHpBuys,xp,hpUpdatedAt,lastModified";
  const statsLine = [
    Math.round(stats.gold),
    Math.round(stats.hp),
    Math.round(stats.maxHp),
    Math.round(stats.maxHpBuys),
    Math.round(stats.xp),
    Math.round(stats.hpUpdatedAt),
    Math.round(stats.lastModified),
  ].join(",");
  const lines = [header, statsLine, ...solved];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Bolt: import — parse a .txt file produced by exportData().
// Row 1 = header (ignored), row 2 = stats CSV, rows 3+ = solved puzzles.
// Returns { statsImported: boolean, puzzlesAdded: number }.
// ---------------------------------------------------------------------------
async function importData(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) throw new Error("File is empty or invalid.");

  let statsImported = false;
  let puzzlesAdded = 0;

  // Bolt: row 2 = stats line (CSV). Validate by checking it starts with a number.
  if (lines.length >= 2 && /^\d/.test(lines[1])) {
    const parts = lines[1].split(",");
    if (parts.length >= 7) {
      const stats = {
        gold: Number(parts[0]) || 0,
        hp: Number(parts[1]) || 0,
        maxHp: Number(parts[2]) || 5,
        maxHpBuys: Number(parts[3]) || 0,
        xp: Number(parts[4]) || 0,
        hpUpdatedAt: Number(parts[5]) || Date.now(),
        lastModified: Number(parts[6]) || Date.now(),
      };
      await saveLocalStats(stats);
      statsImported = true;
    }
  }

  // Bolt: rows 3+ = solved puzzle strings (81-char, digits only).
  const puzzleLines = lines.slice(2).filter((l) => /^[0-9]{81}$/.test(l));
  if (puzzleLines.length > 0) {
    puzzlesAdded = await importSolvedPuzzles(puzzleLines);
  }

  return { statsImported, puzzlesAdded };
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
  exportData,
  importData,
};
