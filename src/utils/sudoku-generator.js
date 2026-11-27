/*
 * SUDOKU GENERATOR — standalone, dependency-free Sudoku puzzle generator.
 *
 * Quick start:
 *   const { generateSudoku } = require("./sudoku-generator");
 *   console.log(generateSudoku(1)); // easy puzzle as an 81-character string
 *   console.log(generateSudoku(3, {
 *     minFilledCells: 29, maxFilledCells: 36,
 *     techniquesUsed: ["hiddenSingles", "subsets", "fish", "xWind"],
 *   }));
 *
 * CLI:
 *   node sudoku-generator.js 1
 *   node sudoku-generator.js 4 --json
 *
 * Copy this file into another project, or load it in a browser (where it
 * exposes window.SudokuGenerator). The implementation is self-contained:
 * it makes randomized complete grids, removes clues while preserving a
 * unique solution, and checks each puzzle with the logical strategies below.
 * Backtracking is used only to build a complete solution and verify uniqueness;
 * the human-style puzzle solver never guesses.
 *
 * SUDOKU GENERATOR — supported technique names, ordered roughly by difficulty:
 *   fullHouse, nakedSingles, hiddenSingles,
 *   lockedCandidates,
 *   nakedPairs / hiddenPairs, nakedTriples / hiddenTriples,
 *   nakedQuads / hiddenQuads,
 *   xWing, swordfish, jellyfish,
 *   xyWing,
 *   aicChains (bounded alternating-inference chains).
 *
 * Group names are also accepted: "singles", "subsets", "basicSubsets", and "fish".
 * "xWind" is accepted as an alias for "xWing".
 */
(function attachSudokuGenerator(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SudokuGenerator = api;
  if (typeof require === "function" && typeof module === "object" &&
      require.main === module) {
    api.runCli(typeof process === "object" ? process.argv.slice(2) : []);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createSudokuGenerator() {
  "use strict";

  const SIZE = 9;
  const CELL_COUNT = 81;
  const ALL_DIGITS = 0x1ff;
  const DIGIT_BITS = Array.from({ length: 9 }, (_, i) => 1 << i);
  const DIGITS = DIGIT_BITS.map((_, i) => String(i + 1));

  const ROWS = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (_, c) => r * 9 + c));
  const COLUMNS = Array.from({ length: 9 }, (_, c) =>
    Array.from({ length: 9 }, (_, r) => r * 9 + c));
  const BOXES = Array.from({ length: 9 }, (_, b) => {
    const row = Math.floor(b / 3) * 3;
    const col = (b % 3) * 3;
    return Array.from({ length: 9 }, (_, i) =>
      (row + Math.floor(i / 3)) * 9 + col + (i % 3));
  });
  const UNITS = [...ROWS, ...COLUMNS, ...BOXES];
  const CELL_UNITS = Array.from({ length: CELL_COUNT }, (_, cell) =>
    UNITS.filter((unit) => unit.includes(cell)));
  const PEERS = Array.from({ length: CELL_COUNT }, (_, cell) => {
    const peers = new Set(CELL_UNITS[cell].flat());
    peers.delete(cell);
    return [...peers];
  });

  const PRESETS = {
    1: {
      name: "easy",
      minFilledCells: 44,
      maxFilledCells: 50,
      techniquesUsed: ["fullHouse", "nakedSingles"],
      requiredFamilies: [],
      requiredTechniques: [],
    },
    2: {
      name: "normal",
      minFilledCells: 37,
      maxFilledCells: 43,
      techniquesUsed: [
        "fullHouse", "nakedSingles", "hiddenSingles", "lockedCandidates",
        "basicSubsets",
      ],
      requiredFamilies: [],
      requiredTechniques: ["lockedCandidates"],
    },
    3: {
      name: "hard",
      minFilledCells: 27,
      maxFilledCells: 36,
      techniquesUsed: [
        "fullHouse", "nakedSingles", "hiddenSingles", "lockedCandidates",
        "basicSubsets", "nakedQuads", "hiddenQuads", "xWing", "xyWing",
      ],
      requiredFamilies: [],
      requiredAnyFamilies: ["fish", "xyWing"],
      requiredTechniques: [],
    },
    4: {
      name: "insane",
      minFilledCells: 17,
      maxFilledCells: 26,
      techniquesUsed: [
        "fullHouse", "nakedSingles", "hiddenSingles", "lockedCandidates",
        "basicSubsets", "nakedQuads", "hiddenQuads", "xWing", "swordfish", "xyWing",
      ],
      requiredFamilies: [],
      requiredTechniques: ["swordfish"],
    },
  };

  const TECHNIQUE_ALIASES = {
    singles: ["fullHouse", "nakedSingles", "hiddenSingles"],
    subset: ["subsets"],
    subsets: ["subsets"],
    basicsubsets: ["nakedPairs", "hiddenPairs", "nakedTriples", "hiddenTriples"],
    fish: ["fish"],
    xwind: ["xWing"],
    xwing: ["xWing"],
    swordfish: ["swordfish"],
    jellyfish: ["jellyfish"],
    aic: ["aicChains"],
    chains: ["aicChains"],
    xywing: ["xyWing"],
    nakedpair: ["nakedPairs"],
    hiddenpair: ["hiddenPairs"],
    nakedtriple: ["nakedTriples"],
    hiddentriple: ["hiddenTriples"],
    nakedquad: ["nakedQuads"],
    hiddenquad: ["hiddenQuads"],
  };

  const SUPPORTED_TECHNIQUES = new Set([
    "fullHouse", "nakedSingles", "hiddenSingles", "lockedCandidates",
    "subsets", "nakedPairs", "hiddenPairs", "nakedTriples",
    "hiddenTriples", "nakedQuads", "hiddenQuads",
    "fish", "xWing", "swordfish", "jellyfish", "xyWing", "aicChains",
  ]);

  function bitCount(mask) {
    let n = 0;
    for (; mask; mask &= mask - 1) n++;
    return n;
  }

  function onlyDigit(mask) {
    return Math.log2(mask) + 1;
  }

  function digitsIn(mask) {
    const out = [];
    for (let d = 0; d < 9; d++) if (mask & DIGIT_BITS[d]) out.push(d + 1);
    return out;
  }

  function randInt(rng, max) {
    return Math.floor(rng() * max);
  }

  function shuffle(values, rng) {
    for (let i = values.length - 1; i > 0; i--) {
      const j = randInt(rng, i + 1);
      [values[i], values[j]] = [values[j], values[i]];
    }
    return values;
  }

  function parseGrid(grid) {
    if (Array.isArray(grid)) {
      if (grid.length !== CELL_COUNT) throw new Error("A Sudoku grid must contain 81 cells.");
      const values = grid.map((v) => Number(v) || 0);
      if (values.some((v) => !Number.isInteger(v) || v < 0 || v > 9)) {
        throw new Error("Grid values must be digits 1-9 or empty cells (0).");
      }
      return values;
    }
    if (typeof grid !== "string" || grid.length !== CELL_COUNT ||
        !/^[0-9.]+$/.test(grid)) {
      throw new Error("A Sudoku puzzle must be an 81-character string of digits, dots, or zeroes.");
    }
    return Array.from(grid, (char) => char === "." ? 0 : Number(char));
  }

  function gridToString(grid) {
    return grid.map((value) => value || "0").join("");
  }

  function makeState(grid) {
    const values = grid.slice();
    const candidates = Array(CELL_COUNT).fill(ALL_DIGITS);
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (!values[cell]) continue;
      const bit = DIGIT_BITS[values[cell] - 1];
      for (const peer of PEERS[cell]) {
        if (values[peer] === values[cell]) return null;
        candidates[peer] &= ~bit;
      }
      candidates[cell] = bit;
    }
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (values[cell] === 0 && candidates[cell] === 0) return null;
    }
    for (const unit of UNITS) {
      for (let d = 0; d < 9; d++) {
        const bit = DIGIT_BITS[d];
        if (unit.some((cell) => values[cell] === d + 1)) continue;
        if (!unit.some((cell) => candidates[cell] & bit)) return null;
      }
    }
    return { values, candidates };
  }

  function place(state, cell, digit) {
    const bit = DIGIT_BITS[digit - 1];
    if (state.values[cell] || !(state.candidates[cell] & bit)) return false;
    state.values[cell] = digit;
    state.candidates[cell] = bit;
    for (const peer of PEERS[cell]) {
      if (state.values[peer] === digit) return false;
      if (!state.values[peer]) {
        state.candidates[peer] &= ~bit;
        if (!state.candidates[peer]) return false;
      }
    }
    return true;
  }

  function eliminate(state, removals) {
    let changed = false;
    for (const [cell, bits] of removals) {
      const next = state.candidates[cell] & ~bits;
      if (next !== state.candidates[cell]) {
        if (!next) return false;
        state.candidates[cell] = next;
        changed = true;
      }
    }
    return changed;
  }

  function enabledSet(techniquesUsed) {
    const enabled = new Set();
    for (let name of techniquesUsed) {
      const key = String(name).replace(/[\s_-]/g, "").toLowerCase();
      if (TECHNIQUE_ALIASES[key]) {
        for (const alias of TECHNIQUE_ALIASES[key]) enabled.add(alias);
      } else {
        const canonical = [...SUPPORTED_TECHNIQUES].find(
          (supported) => supported.toLowerCase() === key);
        if (!canonical) {
          throw new Error(`Unknown technique "${name}". See SudokuGenerator.getSupportedTechniques().`);
        }
        enabled.add(canonical);
      }
    }
    if (enabled.has("subsets")) {
      for (const name of ["nakedPairs", "hiddenPairs", "nakedTriples",
        "hiddenTriples", "nakedQuads", "hiddenQuads"]) enabled.add(name);
    }
    if (enabled.has("fish")) {
      for (const name of ["xWing", "swordfish", "jellyfish"]) enabled.add(name);
    }
    return enabled;
  }

  function strategyEnabled(enabled, strategy) {
    return enabled.has(strategy);
  }

  function getNakedSingle(state) {
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (!state.values[cell] && bitCount(state.candidates[cell]) === 1) {
        return { type: "place", technique: "nakedSingle", family: "singles",
          cell, digit: onlyDigit(state.candidates[cell]) };
      }
    }
    return null;
  }

  function getFullHouse(state) {
    for (const unit of UNITS) {
      let empty = -1;
      let emptyCount = 0;
      let placed = 0;
      for (const cell of unit) {
        if (!state.values[cell]) {
          empty = cell;
          emptyCount++;
        } else placed |= DIGIT_BITS[state.values[cell] - 1];
      }
      if (emptyCount === 1) {
        const missing = ALL_DIGITS & ~placed;
        if (bitCount(missing) === 1) {
          return { type: "place", technique: "fullHouse", family: "singles",
            cell: empty, digit: onlyDigit(missing) };
        }
      }
    }
    return null;
  }

  function getHiddenSingle(state) {
    for (const unit of UNITS) {
      let placed = 0;
      for (const cell of unit) {
        if (state.values[cell]) placed |= DIGIT_BITS[state.values[cell] - 1];
      }
      for (let d = 0; d < 9; d++) {
        const bit = DIGIT_BITS[d];
        if (placed & bit) continue;
        let found = -1;
        for (const cell of unit) {
          if (!state.values[cell] && (state.candidates[cell] & bit)) {
            if (found !== -1) {
              found = -2;
              break;
            }
            found = cell;
          }
        }
        if (found >= 0) {
          return { type: "place", technique: "hiddenSingle", family: "singles",
            cell: found, digit: d + 1 };
        }
      }
    }
    return null;
  }

  function getLockedCandidate(state) {
    for (let boxIndex = 0; boxIndex < 9; boxIndex++) {
      const box = BOXES[boxIndex];
      for (let d = 0; d < 9; d++) {
        const bit = DIGIT_BITS[d];
        const places = box.filter((cell) =>
          !state.values[cell] && (state.candidates[cell] & bit));
        if (places.length < 2) continue;
        const rows = new Set(places.map((cell) => Math.floor(cell / 9)));
        const cols = new Set(places.map((cell) => cell % 9));
        const removals = [];
        if (rows.size === 1) {
          const row = [...rows][0];
          for (const cell of ROWS[row]) {
            if (!box.includes(cell) && !state.values[cell] &&
                (state.candidates[cell] & bit)) removals.push([cell, bit]);
          }
        }
        if (cols.size === 1) {
          const col = [...cols][0];
          for (const cell of COLUMNS[col]) {
            if (!box.includes(cell) && !state.values[cell] &&
                (state.candidates[cell] & bit)) removals.push([cell, bit]);
          }
        }
        if (removals.length) {
          return { type: "eliminate", technique: "lockedCandidates",
            family: "lockedCandidates", removals };
        }
      }
    }
    // Claiming: a row or column confines a digit to one box.
    for (const line of [...ROWS, ...COLUMNS]) {
      for (let d = 0; d < 9; d++) {
        const bit = DIGIT_BITS[d];
        const places = line.filter((cell) =>
          !state.values[cell] && (state.candidates[cell] & bit));
        if (places.length < 2) continue;
        const boxes = new Set(places.map((cell) =>
          Math.floor(Math.floor(cell / 9) / 3) * 3 + Math.floor((cell % 9) / 3)));
        if (boxes.size !== 1) continue;
        const box = BOXES[[...boxes][0]];
        const removals = box
          .filter((cell) => !line.includes(cell) && !state.values[cell] &&
            (state.candidates[cell] & bit))
          .map((cell) => [cell, bit]);
        if (removals.length) {
          return { type: "eliminate", technique: "lockedCandidates",
            family: "lockedCandidates", removals };
        }
      }
    }
    return null;
  }

  function combinations(values, count, callback, start = 0, picked = []) {
    if (picked.length === count) {
      callback(picked.slice());
      return;
    }
    for (let i = start; i <= values.length - (count - picked.length); i++) {
      picked.push(values[i]);
      combinations(values, count, callback, i + 1, picked);
      picked.pop();
    }
  }

  function getNakedSubset(state, size) {
    for (const unit of UNITS) {
      const cells = unit.filter((cell) => !state.values[cell] &&
        bitCount(state.candidates[cell]) >= 2 &&
        bitCount(state.candidates[cell]) <= size);
      let move = null;
      combinations(cells, size, (group) => {
        if (move) return;
        const union = group.reduce((mask, cell) => mask | state.candidates[cell], 0);
        if (bitCount(union) !== size) return;
        const removals = unit
          .filter((cell) => !group.includes(cell) && !state.values[cell] &&
            (state.candidates[cell] & union))
          .map((cell) => [cell, union]);
        if (removals.length) move = {
          type: "eliminate",
          technique: `naked${size === 2 ? "Pair" : size === 3 ? "Triple" : "Quad"}`,
          family: "subsets",
          removals,
        };
      });
      if (move) return move;
    }
    return null;
  }

  function getHiddenSubset(state, size) {
    for (const unit of UNITS) {
      let placed = 0;
      for (const cell of unit) {
        if (state.values[cell]) placed |= DIGIT_BITS[state.values[cell] - 1];
      }
      const digits = DIGIT_BITS.map((bit, i) => i)
        .filter((d) => !(placed & DIGIT_BITS[d]) &&
          unit.some((cell) => !state.values[cell] &&
            (state.candidates[cell] & DIGIT_BITS[d])));
      let move = null;
      combinations(digits, size, (group) => {
        if (move) return;
        const groupMask = group.reduce((mask, d) => mask | DIGIT_BITS[d], 0);
        const cells = unit.filter((cell) => !state.values[cell] &&
          (state.candidates[cell] & groupMask));
        if (cells.length !== size) return;
        const removals = cells.map((cell) =>
          [cell, state.candidates[cell] & ~groupMask]);
        if (removals.some(([, bits]) => bits)) move = {
          type: "eliminate",
          technique: `hidden${size === 2 ? "Pair" : size === 3 ? "Triple" : "Quad"}`,
          family: "subsets",
          removals,
        };
      });
      if (move) return move;
    }
    return null;
  }

  function getFish(state, size) {
    for (let d = 0; d < 9; d++) {
      const bit = DIGIT_BITS[d];
      for (const bases of [ROWS, COLUMNS]) {
        const covers = bases.map((line) => line.filter((cell) =>
          !state.values[cell] && (state.candidates[cell] & bit)));
        const eligible = covers.map((cells, index) => ({ cells, index }))
          .filter(({ cells }) => cells.length >= 2 && cells.length <= size);
        let move = null;
        combinations(eligible, size, (group) => {
          if (move) return;
          const coverSet = new Set(group.flatMap(({ cells }) =>
            cells.map((cell) => bases === ROWS ? cell % 9 : Math.floor(cell / 9))));
          if (coverSet.size !== size) return;
          const baseIndices = new Set(group.map(({ index }) => index));
          const removals = [];
          for (const cover of coverSet) {
            const coverLine = bases === ROWS ? COLUMNS[cover] : ROWS[cover];
            for (const cell of coverLine) {
              const base = bases === ROWS ? Math.floor(cell / 9) : cell % 9;
              if (!baseIndices.has(base) && !state.values[cell] &&
                  (state.candidates[cell] & bit)) removals.push([cell, bit]);
            }
          }
          if (removals.length) move = {
            type: "eliminate",
            technique: size === 2 ? "xWing" : size === 3 ? "swordfish" : "jellyfish",
            family: "fish",
            removals,
          };
        });
        if (move) return move;
      }
    }
    return null;
  }

  function getXYWing(state) {
    const bivalue = [];
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (!state.values[cell] && bitCount(state.candidates[cell]) === 2) {
        bivalue.push({ cell, digits: digitsIn(state.candidates[cell]) });
      }
    }
    for (const pivot of bivalue) {
      const wings = bivalue.filter((wing) => wing.cell !== pivot.cell &&
        PEERS[pivot.cell].includes(wing.cell));
      for (const first of wings) {
        const sharedFirst = first.digits.filter((d) => pivot.digits.includes(d));
        if (sharedFirst.length !== 1) continue;
        const pivotOther = pivot.digits.find((d) => d !== sharedFirst[0]);
        const firstOther = first.digits.find((d) => d !== sharedFirst[0]);
        if (pivotOther === firstOther) continue;
        for (const second of wings) {
          if (second.cell === first.cell ||
              !second.digits.includes(pivotOther) ||
              !second.digits.includes(firstOther)) continue;
          const targetDigit = firstOther;
          const targets = PEERS[first.cell].filter((cell) =>
            PEERS[second.cell].includes(cell) && !state.values[cell] &&
            (state.candidates[cell] & DIGIT_BITS[targetDigit - 1]));
          if (targets.length) return {
            type: "eliminate",
            technique: "xyWing",
            family: "xyWing",
            removals: targets.map((cell) =>
              [cell, DIGIT_BITS[targetDigit - 1]]),
          };
        }
      }
    }
    return null;
  }

  function getAicMove(state, maxChainLength) {
    const graph = Array.from({ length: CELL_COUNT * 18 }, () => []);
    const literal = (cell, digit, truth) =>
      (cell * 9 + digit - 1) * 2 + (truth ? 0 : 1);
    const add = (from, to) => graph[from].push(to);

    // Weak links: two candidates sharing a cell or a peer unit cannot both be true.
    for (let a = 0; a < CELL_COUNT; a++) {
      if (state.values[a]) continue;
      const da = digitsIn(state.candidates[a]);
      for (const digit of da) {
        for (let b = a + 1; b < CELL_COUNT; b++) {
          if (state.values[b] || !PEERS[a].includes(b) ||
              !(state.candidates[b] & DIGIT_BITS[digit - 1])) continue;
          add(literal(a, digit, true), literal(b, digit, false));
          add(literal(b, digit, true), literal(a, digit, false));
        }
      }
      // All different candidates in a cell are weakly linked.
      for (const d1 of da) for (const d2 of da) {
        if (d1 !== d2) add(literal(a, d1, true), literal(a, d2, false));
      }
    }

    // Strong links: if one candidate is false, the other must be true.
    for (const unit of UNITS) {
      for (let digit = 1; digit <= 9; digit++) {
        const places = unit.filter((cell) => !state.values[cell] &&
          (state.candidates[cell] & DIGIT_BITS[digit - 1]));
        if (places.length === 2) {
          add(literal(places[0], digit, false), literal(places[1], digit, true));
          add(literal(places[1], digit, false), literal(places[0], digit, true));
        }
      }
    }
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (state.values[cell] || bitCount(state.candidates[cell]) !== 2) continue;
      const [first, second] = digitsIn(state.candidates[cell]);
      add(literal(cell, first, false), literal(cell, second, true));
      add(literal(cell, second, false), literal(cell, first, true));
    }

    // If assuming a candidate true leads to its negation, that candidate is false.
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (state.values[cell]) continue;
      for (const digit of digitsIn(state.candidates[cell])) {
        const start = literal(cell, digit, true);
        const goal = literal(cell, digit, false);
        const distance = new Int16Array(graph.length);
        distance.fill(-1);
        const queue = [start];
        distance[start] = 0;
        for (let head = 0; head < queue.length; head++) {
          const current = queue[head];
          const contradictionLength = distance[current ^ 1];
          if (current === goal || contradictionLength !== -1) return {
            type: "eliminate",
            technique: "aicChain",
            family: "aicChains",
            chainLength: Math.max(distance[current], contradictionLength),
            removals: [[cell, DIGIT_BITS[digit - 1]]],
          };
          if (distance[current] >= maxChainLength) continue;
          for (const next of graph[current]) {
            if (distance[next] !== -1) continue;
            distance[next] = distance[current] + 1;
            queue.push(next);
          }
        }
      }
    }
    return null;
  }

  function findMove(state, enabled, maxAicChainLength) {
    if (enabled.has("fullHouse")) {
      const move = getFullHouse(state);
      if (move) return move;
    }
    if (enabled.has("nakedSingles")) {
      const move = getNakedSingle(state);
      if (move) return move;
    }
    if (enabled.has("hiddenSingles")) {
      const move = getHiddenSingle(state);
      if (move) return move;
    }
    if (enabled.has("lockedCandidates")) {
      const move = getLockedCandidate(state);
      if (move) return move;
    }
    for (const size of [2, 3, 4]) {
      const nakedName = size === 2 ? "nakedPairs" :
        size === 3 ? "nakedTriples" : "nakedQuads";
      const hiddenName = size === 2 ? "hiddenPairs" :
        size === 3 ? "hiddenTriples" : "hiddenQuads";
      if (enabled.has(nakedName)) {
        const move = getNakedSubset(state, size);
        if (move) return move;
      }
      if (enabled.has(hiddenName)) {
        const move = getHiddenSubset(state, size);
        if (move) return move;
      }
    }
    for (const [size, name] of [[2, "xWing"], [3, "swordfish"], [4, "jellyfish"]]) {
      if (enabled.has(name)) {
        const move = getFish(state, size);
        if (move) return move;
      }
    }
    if (enabled.has("xyWing")) {
      const move = getXYWing(state);
      if (move) return move;
    }
    if (enabled.has("aicChains")) {
      return getAicMove(state, maxAicChainLength);
    }
    return null;
  }
// Bug may be below
// NOTE: place/eliminate may leave `state` partially mutated on failure.
// Do not read `state` after a false return. See wing/eliminate hardening TODO.
  function solveLogically(grid, techniquesUsed, options = {}) {
    const enabled = enabledSet(techniquesUsed);
    const state = makeState(grid);
    if (!state) return { solved: false, invalid: true, trace: [], counts: {} };
    const trace = [];
    const counts = {};
    const maxAicChains = options.maxAicChains == null ? 5 : options.maxAicChains;
    const maxAicChainLength = options.maxAicChainLength == null
      ? 14 : options.maxAicChainLength;
    let iterations = 0;
    while (state.values.some((value) => value === 0)) {
      if (++iterations > 1000) break;
      const move = findMove(state, enabled, maxAicChainLength);
      if (!move) break;

      if (move.family === "aicChains" &&
          (counts.aicChain || 0) >= maxAicChains) break;

      if (move.type === "place") {
        if (!place(state, move.cell, move.digit)) {
          return { solved: false, invalid: true, trace, counts };
        }
      } else {
        const changed = eliminate(state, move.removals);
        if (changed === false) break;
      }

      counts[move.technique] = (counts[move.technique] || 0) + 1;
      trace.push({
        technique: move.technique,
        family: move.family,
        cell: move.cell == null ? undefined : move.cell,
        digit: move.digit == null ? undefined : move.digit,
        chainLength: move.chainLength,
      });
    }
    const solved = state.values.every((value) => value > 0);
    return { solved, invalid: false, solution: solved ? gridToString(state.values) : null,
      trace, counts };
  }

  function countSolutions(grid, stopAfter = 2) {
    const state = makeState(grid);
    if (!state) return 0;
    let count = 0;
    function search(values) {
      if (count >= stopAfter) return;
      let bestCell = -1;
      let bestMask = 0;
      let bestCount = 10;
      for (let cell = 0; cell < CELL_COUNT; cell++) {
        if (values[cell]) continue;
        let mask = ALL_DIGITS;
        for (const peer of PEERS[cell]) {
          if (values[peer]) mask &= ~DIGIT_BITS[values[peer] - 1];
        }
        const candidates = bitCount(mask);
        if (!candidates) return;
        if (candidates < bestCount) {
          bestCell = cell;
          bestMask = mask;
          bestCount = candidates;
          if (candidates === 1) break;
        }
      }
      if (bestCell === -1) {
        count++;
        return;
      }
      for (const digit of digitsIn(bestMask)) {
        values[bestCell] = digit;
        search(values);
        values[bestCell] = 0;
        if (count >= stopAfter) return;
      }
    }
    search(state.values.slice());
    return count;
  }

  function makeFullGrid(rng) {
    const values = Array(CELL_COUNT).fill(0);
    function fill() {
      let bestCell = -1;
      let bestDigits = null;
      for (let cell = 0; cell < CELL_COUNT; cell++) {
        if (values[cell]) continue;
        let used = 0;
        for (const peer of PEERS[cell]) {
          if (values[peer]) used |= DIGIT_BITS[values[peer] - 1];
        }
        const available = DIGITS.filter((digit) =>
          !(used & DIGIT_BITS[Number(digit) - 1]));
        if (!available.length) return false;
        if (!bestDigits || available.length < bestDigits.length) {
          bestCell = cell;
          bestDigits = available;
          if (available.length === 1) break;
        }
      }
      if (bestCell === -1) return true;
      for (const digit of shuffle(bestDigits, rng)) {
        values[bestCell] = Number(digit);
        if (fill()) return true;
      }
      values[bestCell] = 0;
      return false;
    }
    if (!fill()) throw new Error("Unable to build a complete Sudoku grid.");
    return values;
  }

  function countFilled(grid) {
    return grid.reduce((count, value) => count + (value > 0 ? 1 : 0), 0);
  }

  function countFamilies(trace) {
    return new Set(trace.map((step) => step.family));
  }

  function normalizeRequest(difficultyOrOptions, extraOptions) {
    let difficulty = difficultyOrOptions;
    let options = extraOptions || {};
    if (difficultyOrOptions && typeof difficultyOrOptions === "object") {
      options = difficultyOrOptions;
      difficulty = options.difficulty == null ? 1 : options.difficulty;
    }
    difficulty = Number(difficulty);
    if (!Number.isInteger(difficulty) || !PRESETS[difficulty]) {
      throw new Error("Difficulty must be an integer from 1 (easy) through 4 (insane).");
    }
    const preset = PRESETS[difficulty];
    const minFilledCells = options.minFilledCells == null
      ? preset.minFilledCells : Number(options.minFilledCells);
    const maxFilledCells = options.maxFilledCells == null
      ? preset.maxFilledCells : Number(options.maxFilledCells);
    for (const [name, value] of [["minFilledCells", minFilledCells],
      ["maxFilledCells", maxFilledCells]]) {
      if (!Number.isInteger(value) || value < 17 || value > 81) {
        throw new Error(`${name} must be an integer in the range 17-81.`);
      }
    }
    if (minFilledCells > maxFilledCells) {
      throw new Error("minFilledCells cannot be greater than maxFilledCells.");
    }
    const techniquesUsed = options.techniquesUsed == null
      ? preset.techniquesUsed.slice()
      : (Array.isArray(options.techniquesUsed)
        ? options.techniquesUsed
        : String(options.techniquesUsed).split(","))
        .map((name) => String(name).trim()).filter(Boolean);
    if (!techniquesUsed.length) {
      throw new Error("techniquesUsed must include at least one supported technique.");
    }
    const enabled = enabledSet(techniquesUsed);
    const requiredFamilies = options.requiredFamilies == null &&
      options.techniquesUsed == null
      ? preset.requiredFamilies.slice()
      : (options.requiredFamilies || []).map(String);
    const requiredAnyFamilies = options.requiredAnyFamilies == null &&
      options.techniquesUsed == null
      ? (preset.requiredAnyFamilies || []).slice()
      : (options.requiredAnyFamilies || []).map(String);
    const requiredTechniques = options.requiredTechniques == null &&
      options.techniquesUsed == null
      ? preset.requiredTechniques.slice()
      : (options.requiredTechniques || []).map(String);
    const rng = options.rng == null ? Math.random : options.rng;
    if (typeof rng !== "function") throw new Error("rng must be a function returning values from 0 to 1.");
    const maxAttempts = options.maxAttempts == null
      ? (difficulty >= 3 ? 800 : 400) : Number(options.maxAttempts);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 1000) {
      throw new Error("maxAttempts must be an integer in the range 1-1000.");
    }
    const maxAicChains = options.maxAicChains == null ? 5 : Number(options.maxAicChains);
    const maxAicChainLength = options.maxAicChainLength == null
      ? 14 : Number(options.maxAicChainLength);
    if (!Number.isInteger(maxAicChains) || maxAicChains < 0) {
      throw new Error("maxAicChains must be a non-negative integer.");
    }
    if (!Number.isInteger(maxAicChainLength) || maxAicChainLength < 2 ||
        maxAicChainLength > 200) {
      throw new Error("maxAicChainLength must be an integer in the range 2-200.");
    }
    return {
      difficulty, preset, minFilledCells, maxFilledCells, techniquesUsed,
      enabled, requiredFamilies, requiredAnyFamilies, requiredTechniques, rng,
      maxAttempts, maxAicChains, maxAicChainLength,
    };
  }

  function generateSudokuDetailed(difficultyOrOptions = 1, extraOptions = {}) {
    const config = normalizeRequest(difficultyOrOptions, extraOptions);
    const {
      difficulty, minFilledCells, maxFilledCells, techniquesUsed,
      enabled, requiredFamilies, requiredAnyFamilies, requiredTechniques, rng,
      maxAttempts, maxAicChains, maxAicChainLength,
    } = config;
    const solverOptions = { maxAicChains, maxAicChainLength };
    let lastClueCount = 81;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const solution = makeFullGrid(rng);
      const puzzle = solution.slice();
      const target = minFilledCells + randInt(rng, maxFilledCells - minFilledCells + 1);
      let currentLogical = solveLogically(puzzle, techniquesUsed, solverOptions);
      for (const cell of shuffle(Array.from({ length: CELL_COUNT }, (_, i) => i), rng)) {
        const currentClues = countFilled(puzzle);
        const currentFamilies = countFamilies(currentLogical.trace);
        const requirementsMet =
          !requiredFamilies.length ||
            requiredFamilies.every((family) => currentFamilies.has(family));
        const anyRequirementsMet =
          !requiredAnyFamilies.length ||
            requiredAnyFamilies.some((family) => currentFamilies.has(family));
        const techniquesMet = requiredTechniques.every((technique) =>
          currentLogical.trace.some((step) => step.technique === technique));
        if ((currentClues <= target && requirementsMet && anyRequirementsMet &&
              techniquesMet) ||
            currentClues <= minFilledCells) break;
        const previous = puzzle[cell];
        puzzle[cell] = 0;
        if (countSolutions(puzzle, 2) !== 1) {
          puzzle[cell] = previous;
          continue;
        }
        const logical = solveLogically(puzzle, techniquesUsed, solverOptions);
        if (!logical.solved || logical.invalid) {
          puzzle[cell] = previous;
        } else {
          currentLogical = logical;
        }
      }

      const clueCount = countFilled(puzzle);
      lastClueCount = clueCount;
      if (clueCount < minFilledCells || clueCount > maxFilledCells) continue;
      const logical = solveLogically(puzzle, techniquesUsed, solverOptions);
      if (!logical.solved || logical.invalid) continue;
      const usedFamilies = countFamilies(logical.trace);
      if (requiredFamilies.some((family) => !usedFamilies.has(family))) continue;
      if (requiredAnyFamilies.length &&
          !requiredAnyFamilies.some((family) => usedFamilies.has(family))) continue;
      if (requiredTechniques.some((technique) =>
        !logical.trace.some((step) => step.technique === technique))) continue;
      const aicChainCount = logical.trace.filter((step) =>
        step.family === "aicChains").length;
      if (aicChainCount > maxAicChains) continue;
      return {
        puzzle: gridToString(puzzle),
        solution: gridToString(solution),
        difficulty,
        difficultyName: config.preset.name,
        clueCount,
        techniquesUsed: [...new Set(logical.trace.map((step) => step.technique))],
        techniqueCounts: logical.counts,
        aicChainCount,
        maxAicChainLengthUsed: logical.trace.reduce((max, step) =>
          step.chainLength == null ? max : Math.max(max, step.chainLength), 0),
        solveTrace: logical.trace,
        solutionCount: 1,
        attempts: attempt,
      };
    }
    const required = requiredFamilies.length
      ? ` Required logical technique families: ${requiredFamilies.join(" and ")}.` : "";
    const requiredAny = requiredAnyFamilies.length
      ? ` Required any of the logical technique families: ${requiredAnyFamilies.join(" or ")}.` : "";
    const requiredTechniqueText = requiredTechniques.length
      ? ` Required logical technique: ${requiredTechniques.join(" or ")}.` : "";
    throw new Error(
      `Could not generate a difficulty ${difficulty} puzzle in ${maxAttempts} attempts ` +
      `with ${minFilledCells}-${maxFilledCells} clues (last attempt: ${lastClueCount} clues).` +
      `${required}${requiredAny}${requiredTechniqueText} Increase maxAttempts, widen the clue range, or relax the strategy limits.`
    );
  }

  function generateSudoku(difficultyOrOptions = 1, options = {}) {
    return generateSudokuDetailed(difficultyOrOptions, options).puzzle;
  }

  function getSupportedTechniques() {
    return [
      { name: "fullHouse", family: "singles", grade: 1 },
      { name: "nakedSingles", family: "singles", grade: 1 },
      { name: "hiddenSingles", family: "singles", grade: 1 },
      { name: "lockedCandidates", family: "lockedCandidates", grade: 2 },
      { name: "nakedPairs", family: "subsets", grade: 2 },
      { name: "hiddenPairs", family: "subsets", grade: 2 },
      { name: "nakedTriples", family: "subsets", grade: 2 },
      { name: "hiddenTriples", family: "subsets", grade: 2 },
      { name: "nakedQuads", family: "subsets", grade: 2 },
      { name: "hiddenQuads", family: "subsets", grade: 2 },
      { name: "xWing", family: "fish", grade: 3 },
      { name: "swordfish", family: "fish", grade: 3 },
      { name: "jellyfish", family: "fish", grade: 3 },
      { name: "xyWing", family: "wings", grade: 3 },
      { name: "aicChains", family: "chains", grade: 4 },
    ];
  }

  function getDifficultyPresets() {
    return JSON.parse(JSON.stringify(PRESETS));
  }

  function analyzePuzzle(puzzle, options = {}) {
    const grid = parseGrid(puzzle);
    const difficulty = options.difficulty == null ? 4 : options.difficulty;
    const preset = PRESETS[difficulty];
    if (!preset) throw new Error("Difficulty must be an integer from 1 through 4.");
    const techniquesUsed = options.techniquesUsed || preset.techniquesUsed;
    const logical = solveLogically(grid, techniquesUsed, options);
    const solutionCount = countSolutions(grid, 2);
    return {
      solvableWithoutGuessing: logical.solved,
      unique: solutionCount === 1,
      solutionCount,
      clueCount: countFilled(grid),
      solution: logical.solution,
      techniquesUsed: [...new Set(logical.trace.map((step) => step.technique))],
      techniqueCounts: logical.counts,
      aicChainCount: logical.trace.filter((step) =>
        step.family === "aicChains").length,
      solveTrace: logical.trace,
    };
  }

  function runCli(args) {
    try {
      const difficulty = args.find((arg) => !arg.startsWith("--")) || "1";
      const details = generateSudokuDetailed(Number(difficulty));
      console.log(args.includes("--json") ? JSON.stringify(details, null, 2) : details.puzzle);
    } catch (error) {
      console.error(error.message);
      if (typeof process === "object") process.exitCode = 1;
    }
  }

  return {
    generateSudoku,
    generateSudokuDetailed,
    analyzePuzzle,
    countSolutions: (puzzle) => countSolutions(parseGrid(puzzle), 2),
    getSupportedTechniques,
    getDifficultyPresets,
    runCli,
  };
});
