#!/usr/bin/env python3
"""mecab-ipadic の CSV から、ひらがな麻雀用の単語辞書 (web/dict.txt) を生成する。

- 読み(カタカナ)をひらがなに変換し、牌として使える文字だけで構成される語を採用
- 2〜8 文字のみ (2文字=雀頭, 3文字=面子, 4文字以上=カン宣言可能)
- 品詞は「名詞感のある」ものだけに限定 (副詞・形容動詞語幹は除外)
- 頻度語彙リスト (Leeds Corpus 由来) に収録されている語のみ採用し、
  古語・専門語をふるい落とす。mecab-ipadic の cost 列は約4割が同一の
  デフォルト値に偏っており頻度の指標として使えないため使用しない
- 出力: 1行1語、頻度順位の昇順(=一般的な語が先頭)で重複除去
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
    "Noun.adverbal.csv", # 名詞,副詞可能
]

FREQ_LIST_URL = (
    "https://raw.githubusercontent.com/hingston/japanese/master/"
    "44998-japanese-words.txt"
)

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


def load_freq_rank() -> dict[str, int]:
    with urllib.request.urlopen(FREQ_LIST_URL, timeout=60) as resp:
        raw = resp.read()
    rank: dict[str, int] = {}
    for i, line in enumerate(raw.decode("utf-8").splitlines()):
        w = line.strip()
        if w and w not in rank:
            rank[w] = i
    return rank


def main() -> None:
    out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("web/dict.txt")
    freq_rank = load_freq_rank()
    print(f"frequency list: {len(freq_rank)} words")

    # reading -> (frequency rank, mecab cost) の最良値
    best: dict[str, tuple[int, int]] = {}
    for name in SOURCES:
        with urllib.request.urlopen(BASE + name, timeout=60) as resp:
            raw = resp.read()
        text = raw.decode("euc-jp", errors="replace")
        n_before = len(best)
        for row in csv.reader(io.StringIO(text)):
            if len(row) < 13:
                continue
            cost = int(row[3])
            reading = kata_to_hira(unicodedata.normalize("NFKC", row[11]))
            if not (2 <= len(reading) <= 8):
                continue
            if any(ch not in ALLOWED for ch in reading):
                continue
            rank = freq_rank.get(row[10])
            if rank is None:
                continue  # 頻度語彙リストに載っていない語は除外
            key = (rank, cost)
            if reading not in best or key < best[reading]:
                best[reading] = key
        print(f"{name}: +{len(best) - n_before} words")
    words = sorted(best, key=lambda w: (best[w], w))
    out_path.write_text("\n".join(words) + "\n", encoding="utf-8")
    by_len = {}
    for w in words:
        by_len[len(w)] = by_len.get(len(w), 0) + 1
    print(f"total: {len(words)} words -> {out_path}")
    print("by length:", dict(sorted(by_len.items())))


if __name__ == "__main__":
    main()
