/* tslint:disable */
/* eslint-disable */

/**
 * tiles (牌 ID の多重集合、順不同) が辞書語のアナグラムかどうかを判定する。
 * 一致する語をすべて返す (通常は0個か1個、まれに複数の同形異義語)。
 */
export function check_word(tiles: Uint8Array): string;

/**
 * 14枚形の手牌について、各牌を切った後のシャンテン数と有効牌を返す。
 * 有効牌は with_ukeire が真のとき、シャンテン数が最小になる打牌についてのみ計算する。
 */
export function discard_analysis(hand: Uint8Array, melds_done: number, with_ukeire: boolean): string;

/**
 * 加槓候補: 宣言済みの単語 (meld) に手牌の1枚を足して作れる 1 文字長い単語
 */
export function kakan_candidates(meld: Uint8Array, hand: Uint8Array): string;

/**
 * 暗槓候補: 手牌に含まれる min_len 文字以上の単語
 */
export function kan_candidates(hand: Uint8Array, min_len: number): string;

/**
 * 牌 ID -> 文字 の対応表 (75 文字)
 */
export function kana_table(): string;

/**
 * 辞書 (1行1語) を読み込む。読み込んだ語数を返す。
 */
export function set_dict(text: string): number;

/**
 * シャンテン数。hand は牌 ID 列、melds_done は宣言済み面子(カン)の数。
 * 13枚形・14枚形どちらでも計算できる。和了形は -1。
 */
export function shanten(hand: Uint8Array, melds_done: number): number;

/**
 * 有効牌: 13枚形の手牌に加えるとシャンテン数が下がる牌の種類
 */
export function ukeire(hand: Uint8Array, melds_done: number): Uint8Array;

/**
 * 和了形なら分解 (面子の単語と雀頭) を JSON で返す。違えば "null"。
 */
export function win_breakdown(hand: Uint8Array, melds_done: number): string;

/**
 * 手牌から作れる単語 (complete) と、あと1枚で作れる3文字語 (near)
 */
export function word_candidates(hand: Uint8Array): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly check_word: (a: number, b: number) => [number, number];
    readonly discard_analysis: (a: number, b: number, c: number, d: number) => [number, number];
    readonly kakan_candidates: (a: number, b: number, c: number, d: number) => [number, number];
    readonly kan_candidates: (a: number, b: number, c: number) => [number, number];
    readonly kana_table: () => [number, number];
    readonly set_dict: (a: number, b: number) => number;
    readonly shanten: (a: number, b: number, c: number) => number;
    readonly ukeire: (a: number, b: number, c: number) => [number, number];
    readonly win_breakdown: (a: number, b: number, c: number) => [number, number];
    readonly word_candidates: (a: number, b: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
