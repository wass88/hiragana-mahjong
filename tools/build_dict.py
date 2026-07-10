#!/usr/bin/env python3
"""mecab-ipadic の CSV から、ひらがな麻雀用の単語辞書 (web/dict.txt) を生成する。

- 読み(カタカナ)をひらがなに変換し、牌として使える文字だけで構成される語を採用
- 2〜8 文字のみ (2文字=雀頭, 3文字=面子, 4文字以上=カン宣言可能)
- 出力: 1行1語、コスト昇順(=一般的な語が先頭)で重複除去
"""
import csv
import io
import sys
import unicodedata
import urllib.request
from pathlib import Path

BASE = "https://raw.githubusercontent.com/taku910/mecab/master/mecab-ipadic/"
SOURCES = [
    "Noun.csv",          # 名詞,一般
    "Noun.verbal.csv",   # 名詞,サ変接続
    "Noun.adjv.csv",     # 名詞,形容動詞語幹
    "Noun.adverbal.csv", # 名詞,副詞可能
    "Adverb.csv",        # 副詞
]

# 牌の種類 (Rust 側 KANA と同一の 81 種)
SEION = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん"
DAKUON = "がぎぐげござじずぜぞだぢづでどばびぶべぼ"
HANDAKUON = "ぱぴぷぺぽ"
KOGAKI = "ぁぃぅぇぉっゃゅょ"
CHOON = "ー"
ALLOWED = set(SEION + DAKUON + HANDAKUON + KOGAKI + CHOON)


def kata_to_hira(s: str) -> str:
    out = []
    for ch in s:
        code = ord(ch)
        if 0x30A1 <= code <= 0x30F6:
            out.append(chr(code - 0x60))
        else:
            out.append(ch)
    return "".join(out)


def main() -> None:
    out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("web/dict.txt")
    best_cost: dict[str, int] = {}
    for name in SOURCES:
        with urllib.request.urlopen(BASE + name, timeout=60) as resp:
            raw = resp.read()
        text = raw.decode("euc-jp", errors="replace")
        n_before = len(best_cost)
        for row in csv.reader(io.StringIO(text)):
            if len(row) < 13:
                continue
            cost = int(row[3])
            reading = kata_to_hira(unicodedata.normalize("NFKC", row[11]))
            if not (2 <= len(reading) <= 8):
                continue
            if any(ch not in ALLOWED for ch in reading):
                continue
            if reading not in best_cost or cost < best_cost[reading]:
                best_cost[reading] = cost
        print(f"{name}: +{len(best_cost) - n_before} words")
    words = sorted(best_cost, key=lambda w: (best_cost[w], w))
    out_path.write_text("\n".join(words) + "\n", encoding="utf-8")
    by_len = {}
    for w in words:
        by_len[len(w)] = by_len.get(len(w), 0) + 1
    print(f"total: {len(words)} words -> {out_path}")
    print("by length:", dict(sorted(by_len.items())))


if __name__ == "__main__":
    main()
