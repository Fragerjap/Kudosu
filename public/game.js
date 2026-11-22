/*
 * Bolt: Kudosu game logic.
 * Screens: map -> puzzle / castle shop / settings (no login — local-only).
 * Economy: gold, HP (regen 1/5h * level speed), XP levels, castle debt.
 * Board: selection, highlights, digit dials with progress rects, candidates,
 * undo (restores removed candidates too), wrong-move lock, digit animations.
 */
"use strict";

// ---------------------------------------------------------------------------
// Bolt: constants — zones, economy, level curve
// ---------------------------------------------------------------------------
const ZONES = {
  1: { name: "Meadow", dir: "west", reward: 1 },
  2: { name: "Forest", dir: "south", reward: 3 },
  3: { name: "Peaks", dir: "east", reward: 5 },
  4: { name: "Volcano", dir: "north", reward: 6 },
};
const MAX_HP_BASE = 5;
const REGEN_MS = 5 * 60 * 60 * 1000 /5/60*5; // one HP per 5 hours // per 5 mins for tests
const DEBT_LIMIT = -50;
const SHOP_HP_COST = 3;      // gold per HP when player can afford it
const SHOP_HP_DEBT_COST = 4; // gold per HP added as debt when broke
const MAXHP_BASE_COST = 500; // first +1 max HP; each next +100
const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

// ---------------------------------------------------------------------------
// Bolt: game state (single source of truth)
// ---------------------------------------------------------------------------
// Bolt: removed session field — local-only, no auth.
const Game = {
  stats: null,        // { gold, hp, maxHp, maxHpBuys, xp, hpUpdatedAt, lastModified }
  active: null,       // active puzzle { puzzle, difficulty, cells[81], notes[81], history[], startedAt }
  selected: -1,       // selected cell index (-1 = none)
  noteMode: false,    // candidate (notes) mode
  highlightDigit: 0,  // digit tapped on the board to highlight everywhere
  undoStack: [],      // snapshots of { cells, notes } before each move
  generating: false,
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Bolt: level curve — thresholds 3, 4, 5, ... (level 2 needs 3 XP, next +1)
// ---------------------------------------------------------------------------
function xpForLevel(level) { return 2 + level; } // xp needed to leave `level`
function levelFromXp(xp) {
  let level = 1, remaining = xp;
  while (remaining >= xpForLevel(level)) { remaining -= xpForLevel(level); level++; }
  return { level, into: remaining, need: xpForLevel(level) };
}
// Regen speed bonus: level 1 = 100% base, each level +2% speed.
function regenIntervalMs(level) { return REGEN_MS / (1 + (level - 1) * 0.02); }

// ---------------------------------------------------------------------------
// Bolt: HP regen (offline included). Computes elapsed time and tops up HP.
// ---------------------------------------------------------------------------
function applyRegen() {
  const s = Game.stats;
  if (!s) return;
  const { level } = levelFromXp(s.xp);
  const interval = regenIntervalMs(level);
  const now = Date.now();
  let changed = false;
  while (s.hp < s.maxHp && now - s.hpUpdatedAt >= interval) {
    s.hp += 1;
    s.hpUpdatedAt += interval;
    changed = true;
  }
  if (s.hp >= s.maxHp) s.hpUpdatedAt = now; // full: regen clock resets
  if (changed) touchStats();
  renderStats(false);
}

function touchStats() {
  Game.stats.lastModified = Date.now();
  KudosuDB.saveLocalStats(Game.stats);
}

// ---------------------------------------------------------------------------
// Bolt: screens — tiny router (login screen removed — local-only)
// ---------------------------------------------------------------------------
function showScreen(name) {
  ["screen-map", "screen-puzzle", "screen-shop", "screen-settings"].forEach((id) => {
    $(id).hidden = id !== `screen-${name}`;
  });
  // Bolt: HUD (gold/HP/level) always visible now.
  $("hud").hidden = false;
  document.body.dataset.screen = name;
  if (name === "map") renderMap();
}

// ---------------------------------------------------------------------------
// Bolt: boot — load local stats and go straight to the map (no login)
// ---------------------------------------------------------------------------
async function loadAndStart() {
  Game.stats = await KudosuDB.loadLocalStats();
  applyRegen();
  showScreen("map");
}

// ---------------------------------------------------------------------------
// Bolt: map screen — castle + 4 themed zone buttons
// ---------------------------------------------------------------------------
function renderMap() {
  const map = $("map-art");
  map.className = "map-art"; // reset zones
  // Restore unfinished puzzle entry point.
  const act = Game.active;
  $("map-resume").hidden = !act;
  if (act) {
    $("map-resume-zone").textContent = ZONES[act.difficulty].name;
  }
}

async function enterZone(difficulty) {
  if (Game.generating) return;
  const act = Game.active;
  if (act && act.difficulty !== difficulty) {
    // Leaving to another zone keeps the unfinished puzzle; confirm new one.
    if (!confirm(`Leave the unfinished ${ZONES[act.difficulty].name} puzzle and generate a new ${ZONES[difficulty].name} one? The old puzzle stays saved and can be continued from the map.`)) {
      return;
    }
    // Return to the saved puzzle if the player backs out via Cancel.
  }
  if (act && act.difficulty === difficulty) {
    startPuzzleScreen();
    return;
  }
  await generateAndStart(difficulty);
}

// Bolt: reroll until an unsolved puzzle appears (bounded retries).
async function generateAndStart(difficulty, attempt = 0) {
  const MAX_TRIES = 4;
  Game.generating = true;
  let solution = null;
  showLoading(ZONES[difficulty].name, attempt > 0 ? `Retrying (${attempt + 1}/${MAX_TRIES})…` : "Consulting the stars…");
  // Small delay so the overlay paints before the heavy generation.
  await new Promise((r) => setTimeout(r, 50));
  try {
    let puzzle = null;
    let solution = null;
    try {
      // Bolt: detailed result also gives the solution string, needed for
      // strict right-digit validation on the board.
      const det = window.SudokuGenerator.generateSudokuDetailed(difficulty);
      puzzle = det.puzzle;
      solution = det.solution;
    } catch (e) {
      puzzle = null; // generator gave up within its attempt budget
    }
    if (!puzzle) {
      if (attempt + 1 < MAX_TRIES) {
        Game.generating = false;
        hideLoading();
        return generateAndStart(difficulty, attempt + 1);
      }
      throw new Error("The puzzle spirits are silent. Try again.");
    }
    if (await KudosuDB.isPuzzleSolved(puzzle)) {
      Game.generating = false;
      hideLoading();
      if (attempt + 1 < MAX_TRIES) return generateAndStart(difficulty, attempt + 1);
      toast("All fresh puzzles solved — try again in a moment.");
      return;
    }
    Game.active = {
      puzzle,
      solution, // 81-char solution string (used to validate placements)
      difficulty,
      cells: puzzle.split("").map((ch) => Number(ch)), // 0 = empty, negatives = wrong-ghost
      notes: Array(81).fill(0), // bitmask of candidate digits
      startedAt: Date.now(),
    };
    Game.selected = -1;
    Game.noteMode = false;
    Game.highlightDigit = 0;
    Game.undoStack = [];
    persistActive();
    Game.generating = false;
    hideLoading();
    startPuzzleScreen();
  } catch (e) {
    Game.generating = false;
    hideLoading();
    toast(e.message);
  }
}

function showLoading(zoneName, sub) {
  $("loading-zone").textContent = zoneName;
  $("loading-sub").textContent = sub || "Consulting the stars…";
  $("screen-loading").hidden = false;
}
function hideLoading() { $("screen-loading").hidden = true; }

// ---------------------------------------------------------------------------
// Bolt: puzzle screen setup
// ---------------------------------------------------------------------------
function startPuzzleScreen() {
  const act = Game.active;
  $("puzzle-zone").textContent = ZONES[act.difficulty].name;
  document.documentElement.dataset.zone = act.difficulty;
  buildBoard();
  buildDial();
  renderBoard();
  renderDial();
  renderStats();
  showScreen("puzzle");
}

// ---------------------------------------------------------------------------
// Bolt: board construction (81 cells, 9 boxes, thicker 3x3 borders)
// ---------------------------------------------------------------------------
function buildBoard() {
  const grid = $("sudoku-grid");
  grid.innerHTML = "";
  for (let i = 0; i < 81; i++) {
    const cell = document.createElement("button");
    cell.className = "cell";
    cell.dataset.i = i;
    cell.dataset.r = Math.floor(i / 9);
    cell.dataset.c = i % 9;
    cell.addEventListener("click", () => onCellTap(i));
    grid.appendChild(cell);
  }
}

function cellValue(i) {
  const v = Game.active.cells[i];
  return v > 0 ? v : 0;
}
function isGiven(i) {
  return Game.active.puzzle[i] !== "0";
}
function isWrongLocked(i) {
  return Game.active.cells[i] < 0;
}

// ---------------------------------------------------------------------------
// Bolt: interactions — cell tap / digit dial / note toggle / eraser / undo
// ---------------------------------------------------------------------------
function onCellTap(i) {
  if (!Game.active) return;
  const v = cellValue(i);
  // Bolt: instant highlight — tapping any filled cell highlights all same
  // digits immediately; persists until another filled cell is tapped (or all
  // of that digit get placed). Tapping the same cell again clears it.
  Game.highlightDigit = (Game.selected === i && Game.highlightDigit === v) ? 0 : v;
  Game.selected = i;
  renderBoard();
}

function onDialDigit(d) {
  const i = Game.selected;
  if (i === -1 || isGiven(i)) return;
  const act = Game.active;

  if (Game.noteMode) {
    pushUndo();
    act.notes[i] ^= (1 << (d - 1)); // toggle small digit
    afterPlayerMove(i, false);
    return;
  }

  // Bolt: dial-done gate — a digit fully placed (9 on the board) cannot be
  // entered again, so it can never count as a mistake.
  if (countPlaced(d) >= 9) return;

  // Bolt: HP gate — no placements at 0 HP; offer the castle shop or waiting.
  if (Game.stats.hp <= 0) {
    openHpPrompt();
    return;
  }

  // Bolt: absolute validation — a digit may only go in if it matches the
  // puzzle's solution (no wrong placement even without visible conflicts).
  if (Number(act.solution[i]) !== d) {
    pushUndo();
    act.cells[i] = -d; // red ghost digit — shown, but NOT counted as placed
    Game.stats.hp = Math.max(0, Game.stats.hp - 1);
    Game.stats.hpUpdatedAt = Date.now();
    touchStats();
    splash("hp", "-1");
    afterPlayerMove(i, true);
    return;
  }

  // Correct placement: locks permanently (not undoable) and cleans notes.
  act.cells[i] = d;
  act.notes[i] = 0;
  cleanPeersNotes(i, d);
  // Bolt: when a digit becomes complete on the dial, remove it from ALL
  // remaining notes (keep the other noted digits).
  if (countPlaced(d) >= 9) stripDigitNotes(d);
  afterPlayerMove(i, false);
  checkWin();
}

function stripDigitNotes(d) {
  const bit = 1 << (d - 1);
  for (let k = 0; k < 81; k++) {
    if (Game.active.notes[k] & bit) Game.active.notes[k] &= ~bit;
  }
}

function countPlaced(d) {
  let n = 0;
  for (let k = 0; k < 81; k++) if (cellValue(k) === d) n++;
  return n;
}

// Bolt: 0-HP prompt — castle shop (gold restore) or natural regen.
function openHpPrompt() {
  if (confirm("No hitpoints left! You can't place digits until you restore HP.\n\nOK — open the castle shop (restore with gold)\nCancel — wait for regen (1 HP / 5 hours)")) {
    shopOpen();
  }
}

function conflictsAt(i, d) {
  const out = [];
  const r = Math.floor(i / 9), c = i % 9;
  for (let k = 0; k < 81; k++) {
    if (k === i) continue;
    const kr = Math.floor(k / 9), kc = k % 9;
    const sameUnit = kr === r || kc === c ||
      (Math.floor(kr / 3) === Math.floor(r / 3) && Math.floor(kc / 3) === Math.floor(c / 3));
    if (sameUnit && Math.abs(Game.active.cells[k]) === d && Game.active.cells[k] !== 0) out.push(k);
  }
  return out;
}

function cleanPeersNotes(i, d) {
  const bit = 1 << (d - 1);
  const r = Math.floor(i / 9), c = i % 9;
  for (let k = 0; k < 81; k++) {
    if (k === i) continue;
    const kr = Math.floor(k / 9), kc = k % 9;
    const sameUnit = kr === r || kc === c ||
      (Math.floor(kr / 3) === Math.floor(r / 3) && Math.floor(kc / 3) === Math.floor(c / 3));
    if (sameUnit && (Game.active.notes[k] & bit)) Game.active.notes[k] &= ~bit;
  }
}

function afterPlayerMove(i, keepSelection) {
  if (!keepSelection) { /* keep the cell selected for quick notes/redo */ }
  persistActive();
  renderBoard();
  renderDial();
  renderStats();
}

function onErase() {
  const i = Game.selected;
  if (i === -1 || isGiven(i)) return;
  const v = Game.active.cells[i];
  // Bolt: correct digits lock permanently; only red ghosts can be erased.
  if (v > 0) { toast("Locked — correct digits can't be removed."); return; }
  pushUndo();
  Game.active.cells[i] = 0;
  afterPlayerMove(i, false);
}

function onNoteToggle() {
  Game.noteMode = !Game.noteMode;
  $("btn-notes").classList.toggle("active", Game.noteMode);
  $("btn-notes").setAttribute("aria-pressed", String(Game.noteMode));
}

function pushUndo() {
  const act = Game.active;
  // Bolt: correct placements are permanent — the undo stack only needs the
  // board as it was BEFORE the first correct placement. We store, for each
  // snapshot, which cells were still editable at that moment.
  const editable = act.cells.map((v, k) => !isGiven(k) && v <= 0);
  Game.undoStack.push({ cells: act.cells.slice(), notes: act.notes.slice(), editable });
  if (Game.undoStack.length > 500) Game.undoStack.shift();
}

function onUndo() {
  const snap = Game.undoStack.pop();
  if (!snap) { toast("Nothing to undo."); return; }
  const act = Game.active;
  // Bolt: restore only cells that were still editable in the snapshot —
  // correctly placed digits are permanent and survive the undo.
  act.cells = act.cells.map((v, k) => snap.editable[k] ? snap.cells[k] : v);
  act.notes = snap.notes;
  persistActive();
  renderBoard();
  renderDial();
  renderStats(false);
}

// ---------------------------------------------------------------------------
// Bolt: rendering — board cells with highlights, conflicts, animations
// ---------------------------------------------------------------------------
function renderBoard() {
  const act = Game.active;
  if (!act) return;
  const sel = Game.selected;
  const selR = sel === -1 ? -1 : Math.floor(sel / 9);
  const selC = sel === -1 ? -1 : sel % 9;
  const selBox = sel === -1 ? -1 : Math.floor(selR / 3) * 3 + Math.floor(selC / 3);
  const cells = $("sudoku-grid").children;

  // Count placed per digit (for the dial fade-out + highlight auto-clear).
  const placed = Array(10).fill(0);
  for (let k = 0; k < 81; k++) {
    const v = cellValue(k);
    if (v) placed[v]++;
  }
  // Bolt: auto-clear the highlight once the last of that digit is placed.
  if (Game.highlightDigit && placed[Game.highlightDigit] >= 9) {
    Game.highlightDigit = 0;
  }

  for (let k = 0; k < 81; k++) {
    const el = cells[k];
    const v = cellValue(k);
    const r = Math.floor(k / 9), c = k % 9;
    const box = Math.floor(r / 3) * 3 + Math.floor(c / 3);

    el.classList.toggle("given", isGiven(k));
    el.classList.toggle("wrong", isWrongLocked(k));
    el.classList.toggle("selected", k === sel);
    el.classList.toggle("peer", k !== sel && sel !== -1 &&
      (r === selR || c === selC || box === selBox));
    const same = Game.highlightDigit && v === Game.highlightDigit;
    el.classList.toggle("same-digit", !!same);
    // Bolt: red-ghost cell active — flash every same-digit position in its
    // block, row and column (where the conflicts with the ghost would be).
    let conflict = false;
    if (sel !== -1 && isWrongLocked(sel)) {
      const wd = Math.abs(act.cells[sel]);
      conflict = k !== sel && Math.abs(act.cells[k]) === wd &&
        (r === selR || c === selC || box === selBox);
    }
    el.classList.toggle("conflict-flash", conflict);

    // Bolt: what the cell shows — given, locked correct, red ghost, or notes.
    const raw = act.cells[k];
    const shown = isGiven(k) ? Number(act.puzzle[k]) : (raw < 0 ? -raw : raw);
    const prev = el.dataset.shown || "";
    if (!shown) {
      const mask = act.notes[k];
      if (mask) {
        el.innerHTML = '<div class="notes">' + DIGITS.map((d) => {
          const on = mask & (1 << (d - 1));
          return `<span class="${on ? "on" : ""}">${d}</span>`;
        }).join("") + "</div>";
        el.dataset.shown = "notes";
      } else if (prev) {
        el.textContent = "";
        el.dataset.shown = "";
      }
    } else if (prev !== String(shown) || prev === "notes") {
      // Bolt: digit appears with a draw-on animation (CSS class).
      // Bolt: player-placed correct digits wear the same ink as the givens.
      el.classList.toggle("placed", !isGiven(k) && raw > 0);
      el.innerHTML = `<span class="digit pop">${shown}</span>`;
      el.dataset.shown = String(shown);
    }
  }
}

// ---------------------------------------------------------------------------
// Bolt: digit dial — 9 digit buttons with colored progress rectangles
// ---------------------------------------------------------------------------
function buildDial() {
  const dial = $("dial");
  dial.innerHTML = "";
  DIGITS.forEach((d) => {
    const btn = document.createElement("button");
    btn.className = "dial-btn";
    btn.dataset.d = d;
    btn.innerHTML = `
      <span class="dial-rects" aria-hidden="true"></span>
      <span class="dial-digit">${d}</span>`;
    btn.addEventListener("click", () => onDialDigit(Number(d)));
    dial.appendChild(btn);
  });
}

function renderDial() {
  const act = Game.active;
  if (!act) return;
  const placed = Array(10).fill(0);
  for (let k = 0; k < 81; k++) {
    const v = cellValue(k);
    if (v) placed[v]++;
  }
  document.querySelectorAll(".dial-btn").forEach((btn) => {
    const d = Number(btn.dataset.d);
    const left = 9 - placed[d];
    btn.classList.toggle("done", left === 0);
    const rects = btn.querySelector(".dial-rects");
    // Bolt: color code — 7-9 left orange, 4-6 yellow, 1-3 green.
    const color = left === 0 ? "" : left >= 7 ? "orange" : left >= 4 ? "yellow" : "green";
    btn.dataset.color = color;
    rects.innerHTML = Array.from({ length: Math.max(0, Math.min(9, left)) },
      () => `<i class="${color}"></i>`).join("");
  });
}

// ---------------------------------------------------------------------------
// Bolt: stats header — rolling number wheel + splashes
// ---------------------------------------------------------------------------
function renderStats(animate = true) {
  const s = Game.stats;
  if (!s) return;
  const { level, into, need } = levelFromXp(s.xp);
  setRolling($("stat-gold"), s.gold, animate);
  setRolling($("stat-hp"), `${s.hp}/${s.maxHp}`, animate);
  setRolling($("stat-level"), level, animate);
  // Bolt: guard — these elements can be missing on a cached old page.
  const xpEl = $("stat-xp");
  if (xpEl) xpEl.textContent = `${into}/${need} XP`;
  const barEl = $("xp-bar");
  if (barEl) barEl.style.width = `${Math.round((into / need) * 100)}%`;
}

// Bolt: number wheel — old value scrolls up over the new one (absolutely
// positioned so the counter never shifts sideways mid-animation).
function setRolling(el, value, animate) {
  const str = String(value);
  if (el.dataset.val === str) return;
  el.dataset.val = str;
  if (!animate) { el.textContent = str; return; }
  const oldV = el.textContent;
  el.innerHTML = `<span class="roll-wrap"><span class="roll">${oldV}</span><span class="roll new">${str}</span></span>`;
  requestAnimationFrame(() => el.classList.add("rolling"));
  setTimeout(() => {
    el.textContent = str;
    el.classList.remove("rolling");
  }, 350);
}

// Bolt: splash — floating "+2" / "-1" indicator next to a stat.
function splash(stat, text) {
  const el = $(`stat-${stat}`);
  if (!el) return;
  const s = document.createElement("span");
  s.className = `splash ${text.startsWith("-") ? "bad" : "good"}`;
  s.textContent = text;
  el.parentElement.appendChild(s);
  setTimeout(() => s.remove(), 900);
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.hidden = true; }, 3200);
}

// ---------------------------------------------------------------------------
// Bolt: win check + rewards
// ---------------------------------------------------------------------------
async function checkWin() {
  const act = Game.active;
  for (let k = 0; k < 81; k++) {
    if (!cellValue(k)) return; // still empty cells
  }
  // Solved! Reward by difficulty tier.
  const reward = ZONES[act.difficulty].reward;
  Game.stats.gold += reward;
  Game.stats.xp += reward;
  touchStats();
  splash("gold", `+${reward}`);
  await KudosuDB.markPuzzleSolved(act.puzzle);
  clearActivePuzzle();
  Game.active = null;
  celebrateVictory(reward);
}

function celebrateVictory(reward) {
  $("win-reward").textContent = `+${reward} gold, +${reward} XP`;
  $("screen-win").hidden = false;
  renderStats();
}

// ---------------------------------------------------------------------------
// Bolt: castle shop
// ---------------------------------------------------------------------------
function shopOpen() {
  renderShop();
  showScreen("shop");
}

function renderShop() {
  const s = Game.stats;
  const goldEl = $("shop-gold");
  const hpEl = $("shop-hp");
  if (goldEl) goldEl.textContent = s.gold;
  if (hpEl) hpEl.textContent = `${s.hp}/${s.maxHp}`;
  const hpFull = s.hp >= s.maxHp;
  const afford = s.gold >= SHOP_HP_COST;
  const debtRoom = s.gold > DEBT_LIMIT;
  $("shop-buy-hp").disabled = hpFull || (!afford && !debtRoom);
  $("shop-buy-hp").textContent = hpFull ? "HP is full"
    : afford ? `Restore 1 HP — ${SHOP_HP_COST} gold`
    : `Restore 1 HP — ${SHOP_HP_DEBT_COST} gold (castle debt)`;
  const cost = MAXHP_BASE_COST + s.maxHpBuys * 100;
  $("shop-buy-maxhp").textContent = `+1 Max HP — ${cost} gold`;
  $("shop-buy-maxhp").disabled = s.gold < cost;
  $("shop-debt").hidden = s.gold >= 0;
  $("shop-debt").textContent = `Castle debt: ${Math.abs(s.gold)} coins. Earned gold pays the debt first.`;
}

function shopBuyHp() {
  const s = Game.stats;
  if (s.hp >= s.maxHp) return;
  const afford = s.gold >= SHOP_HP_COST;
  const cost = afford ? SHOP_HP_COST : SHOP_HP_DEBT_COST;
  if (!afford && s.gold <= DEBT_LIMIT) return;
  s.gold -= cost;
  s.hp += 1;
  s.hpUpdatedAt = Date.now();
  touchStats();
  splash("gold", `-${cost}`);
  splash("hp", "+1");
  renderShop();
  renderStats();
}

function shopBuyMaxHp() {
  const s = Game.stats;
  const cost = MAXHP_BASE_COST + s.maxHpBuys * 100;
  if (s.gold < cost) return;
  s.gold -= cost;
  s.maxHp += 1;
  s.maxHpBuys += 1;
  s.hp += 1;
  touchStats();
  splash("gold", `-${cost}`);
  splash("hp", "+1");
  renderShop();
  renderStats();
}

// ---------------------------------------------------------------------------
// Bolt: settings — export/import (local-only), theme, speed, offline status
// ---------------------------------------------------------------------------
// Bolt: export — player stats + solved puzzles in one .txt file.
async function settingsExport() {
  const btn = $("set-export");
  btn.disabled = true;
  try {
    const text = await KudosuDB.exportData();
    const solvedCount = (text.split("\n").length - 2);
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "kudosu-save.txt";
    a.click();
    URL.revokeObjectURL(url);
    toast(`Exported stats + ${Math.max(0, solvedCount)} solved puzzles.`);
  } catch (e) {
    toast(`Export failed: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

// Bolt: import — read a .txt file (stats row + solved puzzle rows) and merge.
function settingsImport() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".txt,text/plain";
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const result = await KudosuDB.importData(text);
      // Bolt: reload stats into the game so the HUD reflects imported values.
      Game.stats = await KudosuDB.loadLocalStats();
      applyRegen();
      renderStats();
      const parts = [];
      if (result.statsImported) parts.push("stats restored");
      if (result.puzzlesAdded > 0) parts.push(`${result.puzzlesAdded} new solved puzzles`);
      toast(parts.length ? `Imported: ${parts.join(", ")}.` : "Nothing new to import.");
    } catch (e) {
      toast(`Import failed: ${e.message}`);
    }
  });
  input.click();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("set-theme").value = theme;
  localStorage.setItem("kudosu_theme", theme);
}
function applySpeed(speed) {
  document.documentElement.dataset.speed = speed;
  $("set-speed").value = speed;
  localStorage.setItem("kudosu_speed", speed);
}

// ---------------------------------------------------------------------------
// Bolt: persistence of active puzzle (localStorage, sync on visibility change)
// ---------------------------------------------------------------------------
function persistActive() {
  if (Game.active) KudosuDB.saveActivePuzzle(Game.active);
}

function saveOnHide() {
  if (document.visibilityState === "hidden") persistActive();
}

// Bolt: HP regen heartbeat — re-checks every minute while the app is open,
// so regen is visible in real time; offline catch-up happens in applyRegen
// (called on load and when the app becomes visible again).
setInterval(() => { if (Game.stats) applyRegen(); }, 60000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Game.stats) applyRegen();
});

// ---------------------------------------------------------------------------
// Bolt: boot — wire up events, restore state
// ---------------------------------------------------------------------------
async function boot() {
  // Theme / speed prefs.
  applyTheme(localStorage.getItem("kudosu_theme") || "dark");
  applySpeed(localStorage.getItem("kudosu_speed") || "normal");

  // Bolt: auth buttons removed — local-only, no login screen.

  // Map.
  document.querySelectorAll(".zone-btn, .btn-castle").forEach((btn) => {
    btn.addEventListener("pointerdown", () => {
      btn.classList.add("touched");
      window.setTimeout(() => btn.classList.remove("touched"), 420);
    });
  });
  document.querySelectorAll(".zone-btn").forEach((btn) => {
    btn.addEventListener("click", () => enterZone(Number(btn.dataset.d)));
  });
  $("btn-castle").addEventListener("click", shopOpen);
  $("map-resume").addEventListener("click", () => startPuzzleScreen());

  // Puzzle controls.
  $("btn-notes").addEventListener("click", onNoteToggle);
  $("btn-erase").addEventListener("click", onErase);
  $("btn-undo").addEventListener("click", onUndo);
  $("btn-abandon").addEventListener("click", () => {
    if (confirm("Abandon this puzzle? A new one will be generated next time.")) {
      clearActivePuzzle();
      Game.active = null;
      showScreen("map");
    }
  });

  // Shop.
  $("shop-buy-hp").addEventListener("click", shopBuyHp);
  $("shop-buy-maxhp").addEventListener("click", shopBuyMaxHp);
  $("shop-back").addEventListener("click", () => showScreen("map"));

  // Bolt: settings — no nickname (local-only), just theme/speed/export/import.
  $("btn-settings").addEventListener("click", () => {
    Game.settingsReturn = document.body.dataset.screen || "map";
    if (Game.settingsReturn === "settings") Game.settingsReturn = "map";
    showScreen("settings");
  });
  $("set-back").addEventListener("click", () => showScreen(Game.settingsReturn || "map"));
  $("set-export").addEventListener("click", settingsExport);
  $("set-import").addEventListener("click", settingsImport);
  $("set-theme").addEventListener("change", (e) => applyTheme(e.target.value));
  $("set-speed").addEventListener("change", (e) => applySpeed(e.target.value));
  // Bolt: logout button removed — local-only, no account.

  // Win screen.
  $("win-close").addEventListener("click", () => {
    $("screen-win").hidden = true;
    showScreen("map");
  });

  // Bolt: save the active puzzle the instant the app is hidden (iOS PWA).
  document.addEventListener("visibilitychange", saveOnHide);
  window.addEventListener("pagehide", persistActive);

  // Service worker / offline readiness note.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js")
      .then(() => { $("set-offline").textContent = "Offline mode ready — you can play without internet."; })
      .catch(() => { $("set-offline").textContent = "Offline mode not available in this browser context."; });
  }

  // Bolt: load local stats + active puzzle, go straight to map (no login).
  Game.stats = await KudosuDB.loadLocalStats();
  applyRegen();

  const act = KudosuDB.loadActivePuzzle();
  if (act && act.puzzle && act.cells && act.cells.length === 81) {
    Game.active = act;
  }

  showScreen("map");
}

document.addEventListener("DOMContentLoaded", boot);
