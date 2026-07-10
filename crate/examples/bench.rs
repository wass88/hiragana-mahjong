//! 実辞書での性能確認: cargo run --release --example bench -- ../web/dict.txt
use hiragana_mahjong_core::*;
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).unwrap_or("../web/dict.txt".into());
    let text = std::fs::read_to_string(&path).expect("dict file");
    let t = Instant::now();
    let n = set_dict(&text);
    println!("dict: {} words, load {:?}", n, t.elapsed());

    // 単純な LCG で乱数手牌を作る (Date 依存なし)
    let mut state: u64 = 0x2545F4914F6CDD1D;
    let mut rng = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };

    let mut worst = std::time::Duration::ZERO;
    let t = Instant::now();
    let iters = 50;
    for _ in 0..iters {
        let mut counts = [0u8; N_KINDS];
        let hand: Vec<u8> = (0..13)
            .map(|_| loop {
                let k = (rng() % N_KINDS as u64) as u8;
                if counts[k as usize] < 4 {
                    counts[k as usize] += 1;
                    break k;
                }
            })
            .collect();
        let t1 = Instant::now();
        let s = shanten(&hand, 0);
        let u = ukeire(&hand, 0);
        let dt = t1.elapsed();
        worst = worst.max(dt);
        if s > 90 {
            println!("bad");
        }
        let _ = u;
    }
    println!(
        "shanten+ukeire x{}: avg {:?}, worst {:?}",
        iters,
        t.elapsed() / iters,
        worst
    );

    // 14枚形の discard_analysis
    let mut worst = std::time::Duration::ZERO;
    let t = Instant::now();
    for _ in 0..iters {
        let mut counts = [0u8; N_KINDS];
        let hand: Vec<u8> = (0..14)
            .map(|_| loop {
                let k = (rng() % N_KINDS as u64) as u8;
                if counts[k as usize] < 4 {
                    counts[k as usize] += 1;
                    break k;
                }
            })
            .collect();
        let t1 = Instant::now();
        let _ = discard_analysis(&hand, 0, true);
        worst = worst.max(t1.elapsed());
    }
    println!(
        "discard_analysis x{}: avg {:?}, worst {:?}",
        iters,
        t.elapsed() / iters,
        worst
    );
}
