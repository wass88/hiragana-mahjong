//! ひらがな麻雀コアエンジン
//!
//! ルール:
//! - 牌 = ひらがな 75 種 (清音45(「を」は除く) / 濁音20 / 半濁音5 / 拗音「っゃゅょ」4 / 長音1)。
//!   枚数は清音2枚、それ以外(濁音・半濁音・拗音・長音)1枚
//! - 面子 = 辞書にある 3 文字の単語 (牌の並べ替え自由)
//! - 雀頭 = 辞書にある 2 文字の単語
//! - 和了 = 4面子 + 1雀頭 (カン宣言済みの単語は面子としてカウント)
//! - カン = 4文字以上の単語を手牌から宣言 (暗槓)。宣言済みの単語に手牌の1枚を
//!   加えて 1 文字長い単語にできる (加槓/小明槓、繰り返し可)

use serde::Serialize;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use wasm_bindgen::prelude::*;

/// 牌の種類。インデックスがそのまま牌 ID になる。
/// 清音(45, 「を」を除く) + 濁音(20) + 半濁音(5) + 拗音(4, 「ぁぃぅぇぉ」を除く) + 長音(1) の順。
/// この並び順は kana_table() を経由して web/main.js の枚数構成(buildInitialWall)からも
/// 前提とされている。
pub const KANA: &str = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわんがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽっゃゅょー";
pub const N_KINDS: usize = 75;

struct WordEntry {
    word: String,
    key: Vec<u8>, // ソート済み牌 ID 列
}

struct Dict {
    entries: Vec<WordEntry>, // 辞書順 (一般的な語が先頭)
    meld_set: HashSet<[u8; 3]>,
    head_set: HashSet<[u8; 2]>,
    /// 面子の 2 枚部分集合 -> それを完成させる牌の種類
    partial_map: HashMap<[u8; 2], Vec<u8>>,
    by_key: HashMap<Vec<u8>, Vec<u32>>,
    char_to_idx: HashMap<char, u8>,
}

impl Dict {
    fn new(text: &str) -> Dict {
        let char_to_idx: HashMap<char, u8> = KANA
            .chars()
            .enumerate()
            .map(|(i, c)| (c, i as u8))
            .collect();
        let mut d = Dict {
            entries: Vec::new(),
            meld_set: HashSet::new(),
            head_set: HashSet::new(),
            partial_map: HashMap::new(),
            by_key: HashMap::new(),
            char_to_idx,
        };
        for line in text.lines() {
            let w = line.trim();
            let n = w.chars().count();
            if !(2..=8).contains(&n) {
                continue;
            }
            let mut key: Vec<u8> = Vec::with_capacity(n);
            let mut ok = true;
            for c in w.chars() {
                match d.char_to_idx.get(&c) {
                    Some(&i) => key.push(i),
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
            if !ok {
                continue;
            }
            key.sort_unstable();
            let idx = d.entries.len() as u32;
            match n {
                2 => {
                    d.head_set.insert([key[0], key[1]]);
                }
                3 => {
                    let k3 = [key[0], key[1], key[2]];
                    if d.meld_set.insert(k3) {
                        for (a, b, c) in [(0, 1, 2), (0, 2, 1), (1, 2, 0)] {
                            let pk = [k3[a], k3[b]];
                            let e = d.partial_map.entry(pk).or_default();
                            if !e.contains(&k3[c]) {
                                e.push(k3[c]);
                            }
                        }
                    }
                }
                _ => {}
            }
            d.by_key.entry(key.clone()).or_default().push(idx);
            d.entries.push(WordEntry {
                word: w.to_string(),
                key,
            });
        }
        d
    }
}

thread_local! {
    static DICT: RefCell<Option<Dict>> = const { RefCell::new(None) };
}

fn with_dict<R>(f: impl FnOnce(&Dict) -> R) -> Option<R> {
    DICT.with(|d| d.borrow().as_ref().map(f))
}

fn counts_from(hand: &[u8]) -> [u8; N_KINDS] {
    let mut c = [0u8; N_KINDS];
    for &t in hand {
        if (t as usize) < N_KINDS {
            c[t as usize] += 1;
        }
    }
    c
}

/// 現在の手牌から作れる(=多重集合として含まれる)面子候補を列挙
fn enumerate_melds(counts: &[u8; N_KINDS], dict: &Dict) -> Vec<[u8; 3]> {
    let kinds: Vec<u8> = (0..N_KINDS as u8).filter(|&k| counts[k as usize] > 0).collect();
    let mut out = Vec::new();
    for (ai, &a) in kinds.iter().enumerate() {
        for (bi, &b) in kinds.iter().enumerate().skip(ai) {
            let need_b = 1 + (a == b) as u8;
            if counts[b as usize] < need_b {
                continue;
            }
            let _ = bi;
            for &c in kinds.iter().skip(bi) {
                let need_c = 1 + (b == c) as u8 + (a == c) as u8;
                if counts[c as usize] < need_c {
                    continue;
                }
                let key = [a, b, c];
                if dict.meld_set.contains(&key) {
                    out.push(key);
                }
            }
        }
    }
    out
}

/// 部分面子(ターツ)と雀頭の最大価値 (p + q, p <= cap, q <= 1) を求める。
/// 辞書が密でほぼ全ての 2 枚がターツになり得るため、分枝限定法で刈り込む。
fn best_partials(
    counts: &mut [u8; N_KINDS],
    orig: &[u8; N_KINDS],
    cap: i32,
    dict: &Dict,
) -> i32 {
    let tiles: i32 = counts.iter().map(|&c| c as i32).sum();
    let mut best = 0;
    bp_dfs(counts, orig, cap, false, 0, 0, tiles, &mut best, dict);
    best
}

#[allow(clippy::too_many_arguments)]
fn bp_dfs(
    counts: &mut [u8; N_KINDS],
    orig: &[u8; N_KINDS],
    cap: i32,
    q_used: bool,
    start: usize,
    taken: i32,
    tiles: i32,
    best: &mut i32,
    dict: &Dict,
) {
    if taken > *best {
        *best = taken;
    }
    // 上界: 残り牌数と残り枠からこれ以上は取れない
    let slots = cap + i32::from(!q_used);
    if taken + slots.min(tiles / 2) <= *best {
        return;
    }
    let kinds: Vec<u8> = (0..N_KINDS as u8).filter(|&k| counts[k as usize] > 0).collect();
    for (ii, &i) in kinds.iter().enumerate() {
        for &j in kinds.iter().skip(ii) {
            // 探索中に上界へ到達したら打ち切り
            if taken + slots.min(tiles / 2) <= *best {
                return;
            }
            let pos = i as usize * N_KINDS + j as usize;
            if pos < start {
                continue;
            }
            let need = if i == j { 2 } else { 1 };
            if counts[i as usize] < need || counts[j as usize] < 1 {
                continue;
            }
            let key = [i, j];
            // 雀頭 (2文字の単語) として使う
            if !q_used && dict.head_set.contains(&key) {
                counts[i as usize] -= 1;
                counts[j as usize] -= 1;
                bp_dfs(counts, orig, cap, true, pos, taken + 1, tiles - 2, best, dict);
                counts[i as usize] += 1;
                counts[j as usize] += 1;
            }
            // 面子の 2 枚 (ターツ) として使う: 完成牌がまだ残っている場合のみ
            if cap > 0 {
                if let Some(comps) = dict.partial_map.get(&key) {
                    if comps.iter().any(|&t| orig[t as usize] < 4) {
                        counts[i as usize] -= 1;
                        counts[j as usize] -= 1;
                        bp_dfs(counts, orig, cap - 1, q_used, pos, taken + 1, tiles - 2, best, dict);
                        counts[i as usize] += 1;
                        counts[j as usize] += 1;
                    }
                }
            }
        }
    }
}

struct ShantenCtx<'a> {
    dict: &'a Dict,
    orig: [u8; N_KINDS],
    m_req: i32,
    best: i32,
    memo: HashSet<(Vec<u8>, i32)>,
}

fn dfs_melds(counts: &mut [u8; N_KINDS], melds: i32, ctx: &mut ShantenCtx) {
    if ctx.best == -1 {
        return;
    }
    let need = ctx.m_req - melds;
    let orig = ctx.orig;
    let pq = best_partials(counts, &orig, need, ctx.dict);
    let s = 2 * need - pq;
    if s < ctx.best {
        ctx.best = s;
    }
    if need == 0 {
        return;
    }
    for m in enumerate_melds(counts, ctx.dict) {
        for &t in &m {
            counts[t as usize] -= 1;
        }
        if ctx.memo.insert((counts.to_vec(), melds + 1)) {
            dfs_melds(counts, melds + 1, ctx);
        }
        for &t in &m {
            counts[t as usize] += 1;
        }
        if ctx.best == -1 {
            return;
        }
    }
}

fn shanten_counts(counts: &mut [u8; N_KINDS], m_req: i32, dict: &Dict) -> i32 {
    let mut ctx = ShantenCtx {
        dict,
        orig: *counts,
        m_req,
        best: i32::MAX,
        memo: HashSet::new(),
    };
    dfs_melds(counts, 0, &mut ctx);
    ctx.best
}

fn m_req_of(melds_done: u32) -> i32 {
    (4i32 - melds_done as i32).max(0)
}

// ---------------------------------------------------------------- wasm API

/// 辞書 (1行1語) を読み込む。読み込んだ語数を返す。
#[wasm_bindgen]
pub fn set_dict(text: &str) -> usize {
    let d = Dict::new(text);
    let n = d.entries.len();
    DICT.with(|slot| *slot.borrow_mut() = Some(d));
    n
}

/// 牌 ID -> 文字 の対応表 (75 文字)
#[wasm_bindgen]
pub fn kana_table() -> String {
    KANA.to_string()
}

/// tiles (牌 ID の多重集合、順不同) が辞書語のアナグラムかどうかを判定する。
/// 一致する語をすべて返す (通常は0個か1個、まれに複数の同形異義語)。
#[wasm_bindgen]
pub fn check_word(tiles: &[u8]) -> String {
    let mut key: Vec<u8> = tiles.to_vec();
    key.sort_unstable();
    let words: Vec<String> = with_dict(|d| {
        d.by_key
            .get(&key)
            .map(|idxs| idxs.iter().map(|&i| d.entries[i as usize].word.clone()).collect())
            .unwrap_or_default()
    })
    .unwrap_or_default();
    serde_json::to_string(&words).unwrap_or_else(|_| "[]".into())
}

/// シャンテン数。hand は牌 ID 列、melds_done は宣言済み面子(カン)の数。
/// 13枚形・14枚形どちらでも計算できる。和了形は -1。
#[wasm_bindgen]
pub fn shanten(hand: &[u8], melds_done: u32) -> i32 {
    with_dict(|d| {
        let mut c = counts_from(hand);
        shanten_counts(&mut c, m_req_of(melds_done), d)
    })
    .unwrap_or(99)
}

/// 有効牌: 13枚形の手牌に加えるとシャンテン数が下がる牌の種類
#[wasm_bindgen]
pub fn ukeire(hand: &[u8], melds_done: u32) -> Vec<u8> {
    with_dict(|d| ukeire_inner(hand, m_req_of(melds_done), d)).unwrap_or_default()
}

#[derive(Serialize)]
struct DiscardInfo {
    tile: u8,
    shanten: i32,
    ukeire: Vec<u8>,
}

/// 14枚形の手牌について、各牌を切った後のシャンテン数と有効牌を返す。
/// 有効牌は with_ukeire が真のとき、シャンテン数が最小になる打牌についてのみ計算する。
#[wasm_bindgen]
pub fn discard_analysis(hand: &[u8], melds_done: u32, with_ukeire: bool) -> String {
    let res: Vec<DiscardInfo> = with_dict(|d| {
        let m_req = m_req_of(melds_done);
        let mut c = counts_from(hand);
        let kinds: Vec<u8> = (0..N_KINDS as u8).filter(|&k| c[k as usize] > 0).collect();
        let mut infos: Vec<DiscardInfo> = kinds
            .iter()
            .map(|&t| {
                c[t as usize] -= 1;
                let s = shanten_counts(&mut c, m_req, d);
                c[t as usize] += 1;
                DiscardInfo {
                    tile: t,
                    shanten: s,
                    ukeire: Vec::new(),
                }
            })
            .collect();
        let min_s = infos.iter().map(|i| i.shanten).min().unwrap_or(99);
        for info in infos
            .iter_mut()
            .filter(|i| with_ukeire && i.shanten == min_s)
        {
            let t = info.tile as usize;
            c[t] -= 1;
            let hand13: Vec<u8> = (0..N_KINDS as u8)
                .flat_map(|k| std::iter::repeat(k).take(c[k as usize] as usize))
                .collect();
            info.ukeire = ukeire_inner(&hand13, m_req, d);
            c[t] += 1;
        }
        infos
    })
    .unwrap_or_default();
    serde_json::to_string(&res).unwrap_or_else(|_| "[]".into())
}

fn ukeire_inner(hand: &[u8], m_req: i32, d: &Dict) -> Vec<u8> {
    let mut c = counts_from(hand);
    let s0 = shanten_counts(&mut c, m_req, d);
    let mut out = Vec::new();
    if s0 <= -1 {
        return out;
    }
    // 孤立牌を加えてもシャンテン数は下がらない。手牌のどれかと
    // ターツ (面子の部分) か雀頭を成す牌だけ試せばよい。
    let mut allowed = [false; N_KINDS];
    for x in 0..N_KINDS as u8 {
        if c[x as usize] == 0 {
            continue;
        }
        for t in 0..N_KINDS as u8 {
            if allowed[t as usize] {
                continue;
            }
            let key = if x <= t { [x, t] } else { [t, x] };
            if d.partial_map.contains_key(&key) || d.head_set.contains(&key) {
                allowed[t as usize] = true;
            }
        }
    }
    for t in 0..N_KINDS {
        if c[t] >= 4 || !allowed[t] {
            continue;
        }
        c[t] += 1;
        if shanten_counts(&mut c, m_req, d) < s0 {
            out.push(t as u8);
        }
        c[t] -= 1;
    }
    out
}

#[derive(Serialize)]
struct WordCand {
    word: String,
    tiles: Vec<u8>,
}

#[derive(Serialize)]
struct NearCand {
    word: String,
    need: u8,
}

#[derive(Serialize)]
struct WordCandidates {
    complete: Vec<WordCand>,
    near: Vec<NearCand>,
}

fn key_deficiency(key: &[u8], counts: &[u8; N_KINDS]) -> (u32, u8) {
    // key はソート済み。不足枚数と、不足が1枚のときの牌を返す
    let mut deficit = 0u32;
    let mut need = 0u8;
    let mut i = 0;
    while i < key.len() {
        let t = key[i];
        let mut n = 0;
        while i < key.len() && key[i] == t {
            n += 1;
            i += 1;
        }
        let have = counts[t as usize] as i32;
        if n as i32 > have {
            deficit += (n as i32 - have) as u32;
            need = t;
        }
    }
    (deficit, need)
}

/// 手牌から作れる単語 (complete) と、あと1枚で作れる3文字語 (near)
#[wasm_bindgen]
pub fn word_candidates(hand: &[u8]) -> String {
    let res = with_dict(|d| {
        let counts = counts_from(hand);
        let mut complete = Vec::new();
        let mut near = Vec::new();
        for e in &d.entries {
            let (deficit, need) = key_deficiency(&e.key, &counts);
            if deficit == 0 {
                if complete.len() < 400 {
                    complete.push(WordCand {
                        word: e.word.clone(),
                        tiles: e.key.clone(),
                    });
                }
            } else if deficit == 1 && e.key.len() == 3 && near.len() < 400 {
                near.push(NearCand {
                    word: e.word.clone(),
                    need,
                });
            }
        }
        WordCandidates { complete, near }
    })
    .unwrap_or(WordCandidates {
        complete: vec![],
        near: vec![],
    });
    serde_json::to_string(&res).unwrap_or_else(|_| "{}".into())
}

/// 暗槓候補: 手牌に含まれる min_len 文字以上の単語
#[wasm_bindgen]
pub fn kan_candidates(hand: &[u8], min_len: u32) -> String {
    let res: Vec<WordCand> = with_dict(|d| {
        let counts = counts_from(hand);
        d.entries
            .iter()
            .filter(|e| e.key.len() >= min_len as usize)
            .filter(|e| key_deficiency(&e.key, &counts).0 == 0)
            .map(|e| WordCand {
                word: e.word.clone(),
                tiles: e.key.clone(),
            })
            .take(200)
            .collect()
    })
    .unwrap_or_default();
    serde_json::to_string(&res).unwrap_or_else(|_| "[]".into())
}

#[derive(Serialize)]
struct KakanCand {
    word: String,
    add: u8,
}

/// 加槓候補: 宣言済みの単語 (meld) に手牌の1枚を足して作れる 1 文字長い単語
#[wasm_bindgen]
pub fn kakan_candidates(meld: &[u8], hand: &[u8]) -> String {
    let res: Vec<KakanCand> = with_dict(|d| {
        let counts = counts_from(hand);
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for t in 0..N_KINDS as u8 {
            if counts[t as usize] == 0 {
                continue;
            }
            let mut key: Vec<u8> = meld.to_vec();
            key.push(t);
            key.sort_unstable();
            if let Some(idxs) = d.by_key.get(&key) {
                for &i in idxs {
                    let w = &d.entries[i as usize].word;
                    if seen.insert((w.clone(), t)) {
                        out.push(KakanCand {
                            word: w.clone(),
                            add: t,
                        });
                    }
                }
            }
        }
        out
    })
    .unwrap_or_default();
    serde_json::to_string(&res).unwrap_or_else(|_| "[]".into())
}

#[derive(Serialize)]
struct WinBreakdown {
    melds: Vec<WordCand>,
    head: WordCand,
}

fn find_win(
    counts: &mut [u8; N_KINDS],
    need: i32,
    dict: &Dict,
    acc: &mut Vec<[u8; 3]>,
) -> Option<Vec<[u8; 3]>> {
    if need == 0 {
        // 残り 2 枚が雀頭になっているか
        let kinds: Vec<u8> = (0..N_KINDS as u8).filter(|&k| counts[k as usize] > 0).collect();
        let total: u8 = kinds.iter().map(|&k| counts[k as usize]).sum();
        if total != 2 {
            return None;
        }
        let key = if kinds.len() == 1 {
            [kinds[0], kinds[0]]
        } else {
            [kinds[0], kinds[1]]
        };
        return dict.head_set.contains(&key).then(|| acc.clone());
    }
    for m in enumerate_melds(counts, dict) {
        for &t in &m {
            counts[t as usize] -= 1;
        }
        acc.push(m);
        let r = find_win(counts, need - 1, dict, acc);
        acc.pop();
        for &t in &m {
            counts[t as usize] += 1;
        }
        if r.is_some() {
            return r;
        }
    }
    None
}

fn word_for_key(key: &[u8], d: &Dict) -> String {
    d.by_key
        .get(key)
        .and_then(|v| v.first())
        .map(|&i| d.entries[i as usize].word.clone())
        .unwrap_or_else(|| key.iter().map(|&t| KANA.chars().nth(t as usize).unwrap()).collect())
}

/// 和了形なら分解 (面子の単語と雀頭) を JSON で返す。違えば "null"。
#[wasm_bindgen]
pub fn win_breakdown(hand: &[u8], melds_done: u32) -> String {
    let res: Option<WinBreakdown> = with_dict(|d| {
        let mut c = counts_from(hand);
        let need = m_req_of(melds_done);
        if hand.len() as i32 != 3 * need + 2 {
            return None;
        }
        let mut acc = Vec::new();
        let melds = find_win(&mut c, need, d, &mut acc)?;
        for m in &melds {
            for &t in m {
                c[t as usize] -= 1;
            }
        }
        let kinds: Vec<u8> = (0..N_KINDS as u8).filter(|&k| c[k as usize] > 0).collect();
        let head_key: Vec<u8> = if kinds.len() == 1 {
            vec![kinds[0], kinds[0]]
        } else {
            vec![kinds[0], kinds[1]]
        };
        Some(WinBreakdown {
            melds: melds
                .iter()
                .map(|m| WordCand {
                    word: word_for_key(m, d),
                    tiles: m.to_vec(),
                })
                .collect(),
            head: WordCand {
                word: word_for_key(&head_key, d),
                tiles: head_key,
            },
        })
    })
    .flatten();
    serde_json::to_string(&res).unwrap_or_else(|_| "null".into())
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    fn idx(c: char) -> u8 {
        KANA.chars().position(|k| k == c).unwrap() as u8
    }

    fn hand(s: &str) -> Vec<u8> {
        s.chars().map(idx).collect()
    }

    fn test_dict() -> &'static str {
        // 雀頭: はひ / ふへ、面子: あいう かきく さしす たちつ なにぬ、カン: あいうえ あいうえお
        "はひ\nふへ\nあいう\nかきく\nさしす\nたちつ\nなにぬ\nあいうえ\nあいうえお\n"
    }

    #[test]
    fn shanten_win_and_tenpai() {
        set_dict(test_dict());
        // 和了形: 4面子 + 雀頭
        let h = hand("あいうかきくさしすたちつはひ");
        assert_eq!(shanten(&h, 0), -1);
        assert_ne!(win_breakdown(&h, 0), "null");
        // 1枚欠け = テンパイ
        let h13 = hand("あいうかきくさしすたちつは");
        assert_eq!(shanten(&h13, 0), 0);
        let u = ukeire(&h13, 0);
        assert!(u.contains(&idx('ひ')));
        // 面子の1枚欠け
        let h13b = hand("あいうかきくさしすたちはひ");
        assert_eq!(shanten(&h13b, 0), 0);
        let u = ukeire(&h13b, 0);
        assert!(u.contains(&idx('つ')));
    }

    #[test]
    fn shanten_with_declared_melds() {
        set_dict(test_dict());
        // カン1つ宣言済み: 残り 3面子+雀頭 (11枚で和了)
        let h = hand("あいうかきくさしすはひ");
        assert_eq!(shanten(&h, 1), -1);
        let h10 = hand("あいうかきくさしすは");
        assert_eq!(shanten(&h10, 1), 0);
    }

    #[test]
    fn kan_and_kakan() {
        set_dict(test_dict());
        let h = hand("あいうえかきくさしすたちつ");
        let kans = kan_candidates(&h, 4);
        assert!(kans.contains("あいうえ"));
        // 加槓: あいうえ + お
        let meld = hand("あいうえ");
        let h2 = hand("おかきく");
        let kakan = kakan_candidates(&meld, &h2);
        assert!(kakan.contains("あいうえお"));
    }

    #[test]
    fn partial_counts() {
        set_dict(test_dict());
        // 2面子 + 2ターツ + 雀頭 + 浮き牌1 → 1シャンテン
        // あい(ターツ) かき(ターツ) さしす たちつ はひ + わ
        let h = hand("あいかきさしすたちつはひわ");
        assert_eq!(shanten(&h, 0), 1);
        // ターツ1つだけ → 2シャンテン (あい かき はひ のうち片方はターツ扱い不可)
        let h2 = hand("あいさしすたちつはひわんー");
        assert_eq!(shanten(&h2, 0), 2);
    }
}
