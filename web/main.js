import init, {
  set_dict,
  kana_table,
  shanten,
  ukeire,
  discard_analysis,
  word_candidates,
  kan_candidates,
  kakan_candidates,
  win_breakdown,
} from "./pkg/hiragana_mahjong_core.js";

// ---------------------------------------------------------------- state

let KANA = "";
const N = 81;

const state = {
  wall: new Array(N).fill(4), // 山の残り枚数
  hand: [], // 牌IDの配列 (常にソートして表示)
  discards: [],
  melds: [], // {word, tiles:[id]}
  pendingDraws: 0, // ツモるべき枚数 (通常ツモ1 / 嶺上)
  lastDrawn: null,
  won: false,
  exhausted: false,
  minKanLen: parseInt(localStorage.getItem("minKanLen") || "4", 10),
};

let cache = { ukeire: [], keepTiles: new Set(), shanten: null, kanCount: 0 };

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

// ---------------------------------------------------------------- game flow

function newGame() {
  state.wall = new Array(N).fill(4);
  state.hand = [];
  state.discards = [];
  state.melds = [];
  state.lastDrawn = null;
  state.won = false;
  state.exhausted = false;
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
  state.wall = new Array(N).fill(4);
  state.hand = [...tiles].sort((a, b) => a - b);
  for (const t of state.hand) state.wall[t]--;
  state.discards = [];
  state.melds = [];
  state.lastDrawn = null;
  state.won = false;
  state.exhausted = false;
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

function discardTile(index) {
  if (!handIs14like() || state.won) return;
  const t = state.hand[index];
  state.hand.splice(index, 1);
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

function declareAnkan(word, tiles) {
  // tiles: ソート済みの牌ID列 (文字数ぶん)
  for (const t of tiles) {
    const i = state.hand.indexOf(t);
    state.hand.splice(i, 1);
  }
  state.melds.push({ word, tiles: [...tiles] });
  state.pendingDraws += tiles.length - 3;
  state.lastDrawn = null;
  $("dlg-kan").close();
  render();
}

function declareKakan(meldIndex, word, add) {
  const i = state.hand.indexOf(add);
  state.hand.splice(i, 1);
  const m = state.melds[meldIndex];
  m.word = word;
  m.tiles = [...m.tiles, add].sort((a, b) => a - b);
  state.pendingDraws += 1;
  state.lastDrawn = null;
  $("dlg-kan").close();
  render();
}

// ---------------------------------------------------------------- analysis

function analyze() {
  cache = { ukeire: [], keepTiles: new Set(), shanten: null, kanCount: 0 };
  if (state.won) return;
  const hand = Uint8Array.from(state.hand);
  const md = meldsDone();

  if (handIs14like()) {
    // 和了チェック
    const win = JSON.parse(win_breakdown(hand, md));
    if (win) {
      state.won = true;
      cache.shanten = -1;
      showWin(win);
      return;
    }
    const infos = JSON.parse(discard_analysis(hand, md, false));
    let min = 99;
    for (const i of infos) min = Math.min(min, i.shanten);
    cache.shanten = min;
    for (const i of infos) if (i.shanten === min) cache.keepTiles.add(i.tile);
    // カン候補数
    let kans = JSON.parse(kan_candidates(hand, state.minKanLen)).length;
    for (let mi = 0; mi < state.melds.length; mi++) {
      kans += JSON.parse(
        kakan_candidates(Uint8Array.from(state.melds[mi].tiles), hand)
      ).length;
    }
    cache.kanCount = kans;
  } else {
    cache.shanten = shanten(hand, md);
    cache.ukeire = Array.from(ukeire(hand, md)).filter((t) => state.wall[t] > 0);
  }
}

// ---------------------------------------------------------------- rendering

const KB_MAIN = [
  "あいうえお", "かきくけこ", "さしすせそ", "たちつてと", "なにぬねの",
  "はひふへほ", "まみむめも", "や ゆ よ", "らりるれろ", "わ を ん",
];
const KB_SUB = [
  "がぎぐげご", "ざじずぜぞ", "だぢづでど", "ばびぶべぼ", "ぱぴぷぺぽ",
  "ぁぃぅぇぉ", "っゃゅょー",
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
    b.classList.toggle("eff", effSet.has(t));
    b.disabled = !active || n === 0;
  });
}

function tileEl(t, cls = "") {
  const b = document.createElement("button");
  b.className = `tile ${cls}`;
  b.textContent = KANA[t];
  return b;
}

function render() {
  analyze();

  // 手牌
  const handEl = $("hand");
  handEl.innerHTML = "";
  const sorted = [...state.hand].sort((a, b) => a - b);
  // 直近ツモ牌は右端に分離表示
  let drawnShown = false;
  const display = [...sorted];
  if (state.lastDrawn !== null) {
    const i = display.indexOf(state.lastDrawn);
    if (i >= 0) {
      display.splice(i, 1);
      display.push(state.lastDrawn);
      drawnShown = true;
    }
  }
  display.forEach((t, i) => {
    const isDrawn = drawnShown && i === display.length - 1;
    const el = tileEl(t, isDrawn ? "drawn" : "");
    if (handIs14like() && cache.keepTiles.has(t)) el.classList.add("keep");
    el.addEventListener("click", () => {
      const idx = state.hand.indexOf(t);
      discardTile(idx);
    });
    handEl.appendChild(el);
  });

  // 宣言済み面子
  const meldsEl = $("melds");
  meldsEl.innerHTML = "";
  state.melds.forEach((m, mi) => {
    const div = document.createElement("div");
    div.className = "meld";
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
  else msg = "捨てる牌をタップしてください";
  $("message").textContent = msg;

  $("btn-kan").hidden = !(handIs14like() && cache.kanCount > 0);
  $("btn-kan").textContent = `カン(${cache.kanCount})`;
  $("btn-random").hidden = !(state.pendingDraws > 0 && !state.won && !state.exhausted);

  updateKeyboard();
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

function openKan() {
  const hand = Uint8Array.from(state.hand);
  const list = $("kan-list");
  list.innerHTML = "";
  const ankans = JSON.parse(kan_candidates(hand, state.minKanLen));
  for (const k of ankans) {
    const b = document.createElement("button");
    b.className = "kan-item";
    b.innerHTML = `<span>${k.word}</span><span class="kan-kind">暗槓 ${k.word.length}枚</span>`;
    b.addEventListener("click", () => declareAnkan(k.word, k.tiles));
    list.appendChild(b);
  }
  state.melds.forEach((m, mi) => {
    const kakans = JSON.parse(kakan_candidates(Uint8Array.from(m.tiles), hand));
    for (const k of kakans) {
      const b = document.createElement("button");
      b.className = "kan-item";
      b.innerHTML = `<span>${m.word} → <b>${k.word}</b></span><span class="kan-kind">加槓 +${KANA[k.add]}</span>`;
      b.addEventListener("click", () => declareKakan(mi, k.word, k.add));
      list.appendChild(b);
    }
  });
  if (!list.children.length) list.textContent = "カンできる単語がありません";
  $("dlg-kan").showModal();
}

// ---------------------------------------------------------------- editor

let draft = [];

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
    const used = draft.filter((x) => x === t).length;
    b.querySelector(".cnt").textContent = 4 - used;
    b.classList.toggle("empty", used >= 4);
    b.disabled = used >= 4 || draft.length >= 13;
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
  $("btn-kan").addEventListener("click", openKan);
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
    const w = new Array(N).fill(4);
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

  newGame();
}

boot();
