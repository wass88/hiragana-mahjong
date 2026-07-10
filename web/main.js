import init, {
  set_dict,
  kana_table,
  shanten,
  ukeire,
  discard_analysis,
  word_candidates,
  check_word,
  win_breakdown,
} from "./pkg/hiragana_mahjong_core.js";

// ---------------------------------------------------------------- state

let KANA = "";
let N = 0; // KANA.length (kana_table() 取得後に確定)

// KANA の並び順 (清音45 + 濁音20 + 半濁音5 + 拗音「っゃゅょ」4 + 長音「ー」1) は
// Rust 側 (crate/src/lib.rs の KANA 定数) の構成と一致している前提。
// 枚数: 清音は2枚、それ以外(濁音・半濁音・拗音・長音)は1枚。
const TILE_CATEGORY_COUNTS = [45, 20, 5, 4, 1];
const TILE_CATEGORY_TILES = [2, 1, 1, 1, 1];

function buildInitialWall() {
  const wall = new Array(N).fill(0);
  let idx = 0;
  for (let c = 0; c < TILE_CATEGORY_COUNTS.length; c++) {
    for (let i = 0; i < TILE_CATEGORY_COUNTS[c] && idx < N; i++, idx++) {
      wall[idx] = TILE_CATEGORY_TILES[c];
    }
  }
  return wall;
}

const state = {
  wall: [], // 山の残り枚数 (boot完了後に buildInitialWall() で初期化)
  hand: [], // 牌IDの配列 (常にソートして表示)
  discards: [],
  melds: [], // {word, tiles:[id]} 宣言済みのカン
  pendingDraws: 0, // ツモるべき枚数 (通常ツモ1 / 嶺上)
  lastDrawn: null,
  won: false,
  exhausted: false,
  minKanLen: parseInt(localStorage.getItem("minKanLen") || "4", 10),
  showEffective: localStorage.getItem("showEffective") !== "0",
  showHint: localStorage.getItem("showHint") !== "0",
};

// 手牌の見た目上のグループ化(トリオ)と選択状態。ゲームロジックには影響しない。
let groups = []; // [{tiles:[id,id,id](単語の並び順), word}]
let selected = new Map(); // 牌ID -> 選択中の枚数
let selectedMeldIndex = null; // 加槓の対象として選択中の宣言済み面子
let kanArmed = false; // 「カン」ボタンで選択モードに入っているか
let selectionRejected = false; // 直前の選択が不成立でアニメーション表示中

let cache = { ukeire: [], keepTiles: new Set(), shanten: null, winInfo: null, kanReady: null };

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- utils

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(Date.now() & 0xffffffff);

function wallTotal() {
  return state.wall.reduce((a, b) => a + b, 0);
}

function drawRandomFromWall() {
  const total = wallTotal();
  if (total === 0) return null;
  let r = Math.floor(rng() * total);
  for (let k = 0; k < N; k++) {
    r -= state.wall[k];
    if (r < 0) return k;
  }
  return null;
}

function handIs14like() {
  return state.pendingDraws === 0 && !state.won;
}

function meldsDone() {
  return state.melds.length;
}

// ---------------------------------------------------------------- 選択/トリオ

function totalSelectedCount() {
  let t = 0;
  for (const v of selected.values()) t += v;
  return t;
}

function selectedTilesArray() {
  const arr = [];
  for (const [k, c] of selected) for (let i = 0; i < c; i++) arr.push(k);
  return arr.sort((a, b) => a - b);
}

function resetSelection() {
  selected = new Map();
  selectedMeldIndex = null;
  kanArmed = false;
}

function clearHandSelection() {
  selected = new Map();
}

function resetGroups() {
  groups = [];
}

/// 現在の手牌に対してグループを検証しつつ消費し、残り(未グループ)の枚数を返す。
/// 手牌から消えた牌を含むグループは自動的に削除する。
function consumeGroups() {
  const counts = new Map();
  for (const t of state.hand) counts.set(t, (counts.get(t) || 0) + 1);
  const valid = [];
  for (const g of groups) {
    const need = new Map();
    for (const t of g.tiles) need.set(t, (need.get(t) || 0) + 1);
    let ok = true;
    for (const [k, c] of need) if ((counts.get(k) || 0) < c) { ok = false; break; }
    if (!ok) continue;
    for (const [k, c] of need) counts.set(k, counts.get(k) - c);
    valid.push(g);
  }
  groups = valid;
  return counts;
}

function rejectSelection() {
  selectionRejected = true;
  render();
  setTimeout(() => {
    resetSelection();
    selectionRejected = false;
    render();
  }, 280);
}

function tryAutoGroup() {
  if (kanArmed || totalSelectedCount() !== 3) return;
  const tiles = selectedTilesArray();
  const words = JSON.parse(check_word(Uint8Array.from(tiles)));
  if (words.length) {
    const word = words[0];
    // 選んだ順序に関わらず、実際の単語の並び順で表示する
    groups.push({ tiles: [...word].map((ch) => KANA.indexOf(ch)), word });
    resetSelection();
  } else {
    rejectSelection();
  }
}

function computeKanReady() {
  if (!handIs14like()) return null;
  if (selectedMeldIndex !== null) {
    const meld = state.melds[selectedMeldIndex];
    if (!meld || totalSelectedCount() !== 1) return null;
    const add = selectedTilesArray()[0];
    const key = [...meld.tiles, add].sort((a, b) => a - b);
    const words = JSON.parse(check_word(Uint8Array.from(key)));
    if (!words.length) return null;
    return { kind: "ka", word: words[0], add, meldIndex: selectedMeldIndex };
  }
  const tiles = selectedTilesArray();
  if (tiles.length < state.minKanLen) return null;
  const words = JSON.parse(check_word(Uint8Array.from(tiles)));
  if (!words.length) return null;
  return { kind: "an", word: words[0], tiles };
}

// ---------------------------------------------------------------- game flow

function newGame() {
  state.wall = buildInitialWall();
  state.hand = [];
  state.discards = [];
  state.melds = [];
  state.lastDrawn = null;
  state.won = false;
  state.exhausted = false;
  resetSelection();
  resetGroups();
  for (let i = 0; i < 13; i++) {
    const t = drawRandomFromWall();
    state.wall[t]--;
    state.hand.push(t);
  }
  state.hand.sort((a, b) => a - b);
  state.pendingDraws = 1;
  render();
}

function setHand(tiles) {
  state.wall = buildInitialWall();
  state.hand = [...tiles].sort((a, b) => a - b);
  for (const t of state.hand) state.wall[t]--;
  state.discards = [];
  state.melds = [];
  state.lastDrawn = null;
  state.won = false;
  state.exhausted = false;
  resetSelection();
  resetGroups();
  state.pendingDraws = 1;
  render();
}

function drawTile(t) {
  if (state.pendingDraws <= 0 || state.won) return;
  if (state.wall[t] <= 0) return;
  state.wall[t]--;
  state.hand.push(t);
  state.lastDrawn = t;
  state.pendingDraws--;
  render();
}

function discardSelected() {
  if (!handIs14like() || totalSelectedCount() !== 1 || selectedMeldIndex !== null) return;
  const t = selectedTilesArray()[0];
  resetSelection();
  const idx = state.hand.indexOf(t);
  state.hand.splice(idx, 1);
  state.discards.push(t);
  state.lastDrawn = null;
  if (wallTotal() === 0) {
    state.exhausted = true;
    state.pendingDraws = 0;
  } else {
    state.pendingDraws = 1;
  }
  render();
}

/// 嶺上ツモを count 枚ぶん山からランダムに補充する。山が尽きたら流局扱い。
function drawRinshan(count) {
  for (let i = 0; i < count; i++) {
    const t = drawRandomFromWall();
    if (t === null) {
      state.exhausted = true;
      return;
    }
    state.wall[t]--;
    state.hand.push(t);
    state.lastDrawn = t;
  }
}

function declareAnkan(word, tiles) {
  // tiles: ソート済みの牌ID列 (文字数ぶん)
  for (const t of tiles) {
    const i = state.hand.indexOf(t);
    state.hand.splice(i, 1);
  }
  state.melds.push({ word, tiles: [...tiles] });
  state.lastDrawn = null;
  resetSelection();
  drawRinshan(tiles.length - 3);
  render();
}

function declareKakan(meldIndex, word, add) {
  const i = state.hand.indexOf(add);
  state.hand.splice(i, 1);
  const m = state.melds[meldIndex];
  m.word = word;
  m.tiles = [...m.tiles, add].sort((a, b) => a - b);
  state.lastDrawn = null;
  resetSelection();
  drawRinshan(1);
  render();
}

function onKanButtonClick() {
  if (!kanArmed) {
    kanArmed = true;
    clearHandSelection();
    render();
    return;
  }
  const ready = computeKanReady();
  if (ready) {
    if (ready.kind === "an") declareAnkan(ready.word, ready.tiles);
    else declareKakan(ready.meldIndex, ready.word, ready.add);
  } else {
    rejectSelection();
  }
}

function declareTsumo() {
  if (!cache.winInfo) return;
  const win = cache.winInfo;
  state.won = true;
  showWin(win);
  render();
}

// ---------------------------------------------------------------- analysis

function analyze() {
  cache = { ukeire: [], keepTiles: new Set(), shanten: null, winInfo: null };
  if (state.won) return;
  const hand = Uint8Array.from(state.hand);
  const md = meldsDone();

  if (handIs14like()) {
    const win = JSON.parse(win_breakdown(hand, md));
    cache.winInfo = win;
    const infos = JSON.parse(discard_analysis(hand, md, false));
    let min = 99;
    for (const i of infos) min = Math.min(min, i.shanten);
    cache.shanten = win ? -1 : min;
    for (const i of infos) if (i.shanten === min) cache.keepTiles.add(i.tile);
  } else {
    cache.shanten = shanten(hand, md);
    cache.ukeire = Array.from(ukeire(hand, md)).filter((t) => state.wall[t] > 0);
  }
}

// ---------------------------------------------------------------- rendering

const KB_MAIN = [
  "あいうえお", "かきくけこ", "さしすせそ", "たちつてと", "なにぬねの",
  "はひふへほ", "まみむめも", "や ゆ よ", "らりるれろ", "わ   ん",
];
const KB_SUB = [
  "がぎぐげご", "ざじずぜぞ", "だぢづでど", "ばびぶべぼ", "ぱぴぷぺぽ",
  "っゃゅょー",
];

function buildKeyboard(mainEl, subEl, onTap) {
  for (const [el, cols] of [[mainEl, KB_MAIN], [subEl, KB_SUB]]) {
    el.innerHTML = "";
    el.style.gridTemplateColumns = `repeat(${cols.length}, 1fr)`;
    el.style.gridAutoFlow = "column";
    for (const col of cols) {
      for (const ch of col) {
        const b = document.createElement("button");
        b.className = "key";
        if (ch === " ") {
          b.classList.add("blank");
          b.tabIndex = -1;
        } else {
          const idx = KANA.indexOf(ch);
          b.dataset.tile = idx;
          b.innerHTML = `<span class="k">${ch}</span><span class="cnt"></span>`;
          b.addEventListener("click", () => onTap(idx));
        }
        el.appendChild(b);
      }
    }
  }
}

function updateKeyboard() {
  const active = state.pendingDraws > 0 && !state.won && !state.exhausted;
  $("keyboard").classList.toggle("disabled", !active);
  const effSet = new Set(cache.ukeire);
  document.querySelectorAll("#keyboard .key[data-tile]").forEach((b) => {
    const t = +b.dataset.tile;
    const n = state.wall[t];
    b.querySelector(".cnt").textContent = n;
    b.classList.toggle("empty", n === 0);
    b.classList.toggle("eff", state.showEffective && effSet.has(t));
    b.disabled = !active || n === 0;
  });
}

function tileEl(t, cls = "") {
  const b = document.createElement("button");
  b.className = `tile ${cls}`;
  b.textContent = KANA[t];
  return b;
}

/// 手牌が折り返さず一行に収まるよう、必要なら牌のサイズを縮める。
function fitHandWidth() {
  const area = $("hand-area");
  const handEl = $("hand");
  area.style.removeProperty("--tile-base");
  const avail = area.clientWidth;
  if (avail <= 0) return;
  // gap や box-shadow の丸め誤差を吸収するため、余裕を持たせつつ最大2回まで縮める
  for (let i = 0; i < 2; i++) {
    const natural = handEl.scrollWidth;
    if (natural <= avail) return;
    const base = parseFloat(getComputedStyle(area).getPropertyValue("--tile-base")) || 42;
    const newBase = Math.max(18, Math.floor(base * (avail / natural) * 0.97));
    area.style.setProperty("--tile-base", `${newBase}px`);
  }
}

function render() {
  analyze();

  // 手牌: まずグループ(トリオ)を左側に、残りをその右にソートして表示
  const handEl = $("hand");
  handEl.innerHTML = "";
  const remaining = consumeGroups();

  groups.forEach((g, gi) => {
    const box = document.createElement("div");
    box.className = "group";
    for (const t of g.tiles) {
      const el = tileEl(t, "small");
      el.addEventListener("click", () => {
        groups.splice(gi, 1);
        selected.set(t, (selected.get(t) || 0) + 1);
        render();
      });
      box.appendChild(el);
    }
    handEl.appendChild(box);
  });

  const kinds = [...remaining.keys()].filter((k) => remaining.get(k) > 0).sort((a, b) => a - b);
  let list = [];
  for (const k of kinds) {
    const c = remaining.get(k);
    const selCount = Math.min(selected.get(k) || 0, c);
    for (let i = 0; i < c; i++) list.push({ kind: k, sel: i < selCount });
  }
  // 直近ツモ牌は右端に分離表示
  let drawnShown = false;
  if (state.lastDrawn !== null) {
    const idx = list.findIndex((e) => e.kind === state.lastDrawn);
    if (idx >= 0) {
      const [e] = list.splice(idx, 1);
      list.push(e);
      drawnShown = true;
    }
  }
  list.forEach((e, i) => {
    const isDrawn = drawnShown && i === list.length - 1;
    const cls = [
      isDrawn ? "drawn" : "",
      e.sel ? "selected" : "",
      e.sel && selectionRejected ? "reject" : "",
    ].filter(Boolean).join(" ");
    const el = tileEl(e.kind, cls);
    if (state.showHint && handIs14like() && cache.keepTiles.has(e.kind)) el.classList.add("keep");
    el.addEventListener("click", () => {
      if (selectionRejected) return;
      if (e.sel) {
        selected.set(e.kind, Math.max(0, (selected.get(e.kind) || 0) - 1));
      } else {
        selected.set(e.kind, (selected.get(e.kind) || 0) + 1);
      }
      if (!kanArmed) tryAutoGroup();
      render();
    });
    handEl.appendChild(el);
  });

  // 宣言済み面子 (カン)。タップで加槓対象として選択/解除。
  const meldsEl = $("melds");
  meldsEl.innerHTML = "";
  state.melds.forEach((m, mi) => {
    const div = document.createElement("div");
    div.className = "meld";
    if (handIs14like()) div.classList.add("selectable");
    if (selectedMeldIndex === mi) div.classList.add("selected");
    for (const ch of m.word) {
      const t = KANA.indexOf(ch);
      const el = tileEl(t, "small");
      el.disabled = true;
      div.appendChild(el);
    }
    const w = document.createElement("span");
    w.className = "meld-word";
    w.textContent = `${m.tiles.length}枚`;
    div.appendChild(w);
    div.dataset.meld = mi;
    if (handIs14like()) {
      div.addEventListener("click", () => {
        selectedMeldIndex = selectedMeldIndex === mi ? null : mi;
        clearHandSelection();
        render();
      });
    }
    meldsEl.appendChild(div);
  });

  // 捨て牌
  const dEl = $("discards");
  dEl.innerHTML = "";
  for (const t of state.discards) {
    const el = tileEl(t, "mini");
    el.disabled = true;
    dEl.appendChild(el);
  }

  // シャンテン表示
  const s = cache.shanten;
  const lab = $("shanten-label");
  lab.textContent =
    s === null ? "--" :
    s === -1 ? "あがり！" :
    s === 0 ? "テンパイ" : `${s}シャンテン`;
  lab.classList.toggle("tenpai", s === 0);
  lab.classList.toggle("win", s === -1);

  // ステータス
  $("wall-count").textContent = `山 ${wallTotal()}`;
  let msg;
  if (state.won) msg = "あがり！🎉";
  else if (state.exhausted) msg = "山が尽きました…（流局）";
  else if (state.pendingDraws > 1) msg = `嶺上ツモ: あと${state.pendingDraws}枚 選んでください`;
  else if (state.pendingDraws === 1) msg = "ツモる牌をキーボードから選んでください";
  else if (selectionRejected) msg = "その組み合わせは単語ではありません";
  else if (kanArmed) msg = `カンする牌を選んで、もう一度「カン」を押してください(選択中${totalSelectedCount()}枚)`;
  else if (cache.winInfo) msg = "あがり形です。「ツモ」で宣言できます(打牌・カンも可)";
  else if (selectedMeldIndex !== null) msg = "加槓する牌を1枚選んで「カン」を押してください";
  else msg = "牌を選んで「捨てる」。3枚で単語ならトリオ、4枚以上で「カン」を押して選択";
  $("message").textContent = msg;

  $("btn-discard").hidden = !handIs14like() || kanArmed;
  $("btn-discard").disabled = totalSelectedCount() !== 1 || selectedMeldIndex !== null;

  $("btn-kan").hidden = !handIs14like();
  $("btn-kan").classList.toggle("armed", kanArmed);
  $("btn-kan").textContent = kanArmed ? `カン判定(${totalSelectedCount()})` : "カン";

  $("btn-tsumo").hidden = !(handIs14like() && cache.winInfo) || kanArmed;

  $("btn-random").hidden = !(state.pendingDraws > 0 && !state.won && !state.exhausted);

  updateKeyboard();
  fitHandWidth();
}

// ---------------------------------------------------------------- dialogs

function showWin(win) {
  const box = $("win-breakdown");
  box.innerHTML = "";
  const rows = [];
  for (const m of state.melds) rows.push(["カン", m.word]);
  for (const m of win.melds) rows.push(["面子", m.word]);
  rows.push(["雀頭", win.head.word]);
  for (const [tag, word] of rows) {
    const row = document.createElement("div");
    row.className = "win-row";
    const tagEl = document.createElement("span");
    tagEl.className = "win-tag";
    tagEl.textContent = tag;
    row.appendChild(tagEl);
    for (const ch of word) {
      const el = tileEl(KANA.indexOf(ch), "small");
      el.disabled = true;
      row.appendChild(el);
    }
    const w = document.createElement("span");
    w.className = "win-word";
    w.textContent = word;
    row.appendChild(w);
    box.appendChild(row);
  }
  $("dlg-win").showModal();
}

function openWords() {
  const hand = Uint8Array.from(state.hand);
  const res = JSON.parse(word_candidates(hand));
  const compEl = $("words-complete");
  compEl.innerHTML = "";
  const byLen = new Map();
  for (const c of res.complete) {
    const l = c.word.length;
    if (!byLen.has(l)) byLen.set(l, []);
    byLen.get(l).push(c);
  }
  for (const l of [...byLen.keys()].sort((a, b) => b - a)) {
    for (const c of byLen.get(l)) {
      const chip = document.createElement("span");
      chip.className = "word-chip";
      chip.innerHTML = `${c.word} <small>${l}字</small>`;
      compEl.appendChild(chip);
    }
  }
  if (!res.complete.length) compEl.textContent = "（なし）";

  const nearEl = $("words-near");
  nearEl.innerHTML = "";
  const near = res.near
    .map((n) => ({ ...n, left: state.wall[n.need] }))
    .filter((n) => n.left > 0)
    .sort((a, b) => b.left - a.left);
  for (const n of near.slice(0, 120)) {
    const chip = document.createElement("span");
    chip.className = "word-chip";
    chip.innerHTML = `${n.word} <small class="need">+${KANA[n.need]}(残${n.left})</small>`;
    nearEl.appendChild(chip);
  }
  if (!near.length) nearEl.textContent = "（なし）";
  $("dlg-words").showModal();
}

// ---------------------------------------------------------------- editor

let draft = [];
let TILE_MAX = []; // 牌種ごとの最大枚数 (boot完了後に確定)

function renderEditor() {
  const handEl = $("edit-hand");
  handEl.innerHTML = "";
  draft.sort((a, b) => a - b);
  draft.forEach((t, i) => {
    const el = tileEl(t, "small");
    el.addEventListener("click", () => {
      draft.splice(i, 1);
      renderEditor();
    });
    handEl.appendChild(el);
  });
  $("edit-ok").disabled = draft.length !== 13;
  $("edit-ok").textContent = `確定 (${draft.length}/13)`;
  document.querySelectorAll("#dlg-edit .key[data-tile]").forEach((b) => {
    const t = +b.dataset.tile;
    const max = TILE_MAX[t] || 1;
    const used = draft.filter((x) => x === t).length;
    b.querySelector(".cnt").textContent = max - used;
    b.classList.toggle("empty", used >= max);
    b.disabled = used >= max || draft.length >= 13;
  });
}

function openEditor() {
  draft = [...state.hand];
  if (draft.length > 13) draft = draft.slice(0, 13);
  renderEditor();
  $("dlg-edit").showModal();
}

// ---------------------------------------------------------------- boot

async function boot() {
  await init();
  KANA = kana_table();
  N = KANA.length;
  TILE_MAX = buildInitialWall();
  const text = await fetch("./dict.txt").then((r) => r.text());
  const n = set_dict(text);
  console.log(`dictionary: ${n} words`);

  buildKeyboard($("kb-main"), $("kb-sub"), drawTile);
  buildKeyboard($("edit-kb-main"), $("edit-kb-sub"), (t) => {
    if (draft.length < 13) {
      draft.push(t);
      renderEditor();
    }
  });

  $("btn-new").addEventListener("click", newGame);
  $("btn-edit").addEventListener("click", openEditor);
  $("btn-words").addEventListener("click", openWords);
  $("btn-rules").addEventListener("click", () => $("dlg-rules").showModal());
  $("btn-discard").addEventListener("click", discardSelected);
  $("btn-kan").addEventListener("click", onKanButtonClick);
  $("btn-tsumo").addEventListener("click", declareTsumo);
  $("btn-random").addEventListener("click", () => {
    const t = drawRandomFromWall();
    if (t !== null) drawTile(t);
  });
  $("win-new").addEventListener("click", () => {
    $("dlg-win").close();
    newGame();
  });
  $("edit-ok").addEventListener("click", () => {
    $("dlg-edit").close();
    setHand(draft);
  });
  $("edit-cancel").addEventListener("click", () => $("dlg-edit").close());
  $("edit-clear").addEventListener("click", () => {
    draft = [];
    renderEditor();
  });
  $("edit-random").addEventListener("click", () => {
    draft = [];
    const w = buildInitialWall();
    for (let i = 0; i < 13; i++) {
      let t;
      do { t = Math.floor(rng() * N); } while (w[t] === 0);
      w[t]--;
      draft.push(t);
    }
    renderEditor();
  });
  const sel = $("sel-kan-len");
  sel.value = String(state.minKanLen);
  $("rule-kan-len").textContent = String(state.minKanLen);
  sel.addEventListener("change", () => {
    state.minKanLen = parseInt(sel.value, 10);
    localStorage.setItem("minKanLen", sel.value);
    $("rule-kan-len").textContent = sel.value;
    render();
  });

  const chkEff = $("chk-show-eff");
  chkEff.checked = state.showEffective;
  chkEff.addEventListener("change", () => {
    state.showEffective = chkEff.checked;
    localStorage.setItem("showEffective", chkEff.checked ? "1" : "0");
    render();
  });

  const chkHint = $("chk-show-hint");
  chkHint.checked = state.showHint;
  chkHint.addEventListener("change", () => {
    state.showHint = chkHint.checked;
    localStorage.setItem("showHint", chkHint.checked ? "1" : "0");
    render();
  });

  newGame();
}

boot();
