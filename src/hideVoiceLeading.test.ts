/**
 * hideVoiceLeading.test.ts — voice leading observation API の単体テスト
 *
 * descriptive (記述的) な observation 設計の検証:
 *  - voice deltas の数値計算
 *  - parallel 5/8 度・direct 5/8 度・voice crossing・large leap の検出
 *  - contrary / oblique は安全 (= observation を出さない)
 *  - パートペアは全組合せ C(N,2) を検査する (5パートで 10 通り)
 *  - 「禁則」ではなく「caution」フレーミング = フィールド名は `observations`
 *
 * Hamoren はポップ/現代アカペラを対象としているため、これらは「禁則」では
 * なく単なる「注意」として浮上させる。テストは単に検出の正しさを確認するだけ
 * で、何が「正しい」「悪い」かの価値判断はしない。
 */

import { describe, it, expect } from 'vitest';
import { analyzeVoiceLeading, analyzeMatrix } from './index';

describe('analyzeVoiceLeading — voice deltas', () => {
  it('computes signed semitone deltas per part across 1 transition', () => {
    // 4/4 DIV=64, 2 measures, 2 parts. C5→D5 (+2), G4→A4 (+2)
    const source = '[1]| C5m | D5m |\n[2]| G4m | A4m |';
    const { matrix } = analyzeMatrix(source);
    const { transitions } = analyzeVoiceLeading(matrix);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].voiceDeltas.get('1')).toBe(2);
    expect(transitions[0].voiceDeltas.get('2')).toBe(2);
  });

  it('treats descending motion as negative delta', () => {
    const source = '[1]| C5m | A4m |';
    const { matrix } = analyzeMatrix(source);
    const { transitions } = analyzeVoiceLeading(matrix);
    expect(transitions[0].voiceDeltas.get('1')).toBe(-3);
  });
});

describe('analyzeVoiceLeading — parallel fifths/octaves', () => {
  it('flags parallel fifths between two voices in similar motion', () => {
    // C5-F4 = P5 (60-53=7), D5-G4 = P5 (62-55=7), 両方 +2 → parallel 5
    const source = '[1]| C5m | D5m |\n[2]| F4m | G4m |';
    const { matrix } = analyzeMatrix(source);
    const { observations } = analyzeVoiceLeading(matrix);
    const p5 = observations.find(o => o.kind === 'parallelFifths');
    expect(p5).toBeDefined();
    expect(p5!.parts).toEqual(['1', '2']);
  });

  it('flags parallel octaves', () => {
    // C5-C4 = P8, D5-D4 = P8, 両方 +2 → parallel 8
    const source = '[1]| C5m | D5m |\n[2]| C4m | D4m |';
    const { matrix } = analyzeMatrix(source);
    const { observations } = analyzeVoiceLeading(matrix);
    const p8 = observations.find(o => o.kind === 'parallelOctaves');
    expect(p8).toBeDefined();
  });

  it('does not flag contrary motion', () => {
    // [1] +2, [2] -1 (contrary). 安全 = no observation
    const source = '[1]| C5m | D5m |\n[2]| F4m | E4m |';
    const { matrix } = analyzeMatrix(source);
    const { observations } = analyzeVoiceLeading(matrix);
    expect(observations.filter(o => o.kind === 'parallelFifths')).toHaveLength(0);
    expect(observations.filter(o => o.kind === 'parallelOctaves')).toHaveLength(0);
  });

  it('does not flag oblique motion (one voice stays)', () => {
    // [1] +2, [2] 0 → oblique, 安全
    const source = '[1]| C5m | D5m |\n[2]| C4m | C4m |';
    const { matrix } = analyzeMatrix(source);
    const { observations } = analyzeVoiceLeading(matrix);
    expect(observations.filter(o => o.kind === 'parallelOctaves')).toHaveLength(0);
  });
});

describe('analyzeVoiceLeading — direct (hidden) fifths/octaves', () => {
  it('flags direct fifths arriving in similar motion', () => {
    // [1] C5→D5 (+2), [2] E4→G4 (+3) (similar)
    // i: C5-E4 = 60-52 = 8 (m6), j: D5-G4 = 62-55 = 7 (P5)
    // → directFifths (出発が P5 ではないが着地が P5)
    const source = '[1]| C5m | D5m |\n[2]| E4m | G4m |';
    const { matrix } = analyzeMatrix(source);
    const { observations } = analyzeVoiceLeading(matrix);
    const d5 = observations.find(o => o.kind === 'directFifths');
    expect(d5).toBeDefined();
    expect(d5!.parts).toEqual(['1', '2']);
  });

  it('flags direct octaves arriving in similar motion', () => {
    // [1] D5→E5 (+2), [2] C4→E4 (+4) (similar)
    // i: D5-C4 = 14, %12 = 2 (M2), j: E5-E4 = 12, %12 = 0 (P8)
    // → directOctaves
    const source = '[1]| D5m | E5m |\n[2]| C4m | E4m |';
    const { matrix } = analyzeMatrix(source);
    const { observations } = analyzeVoiceLeading(matrix);
    const d8 = observations.find(o => o.kind === 'directOctaves');
    expect(d8).toBeDefined();
  });
});

describe('analyzeVoiceLeading — voice crossing', () => {
  it('flags voice crossing when [1] goes below [2]', () => {
    // 小節 2 で [1]=E4 (52), [2]=G4 (55) → 上声 [1] が下声 [2] より下に
    const source = '[1]| C5m | E4m |\n[2]| G4m | G4m |';
    const { matrix } = analyzeMatrix(source);
    const { observations } = analyzeVoiceLeading(matrix);
    const cross = observations.find(o => o.kind === 'voiceCrossing');
    expect(cross).toBeDefined();
    expect(cross!.parts).toEqual(['1', '2']);
    expect(cross!.fromMeasureIndex).toBe(1);
    expect(cross!.toMeasureIndex).toBe(1);
  });
});

describe('analyzeVoiceLeading — large leap', () => {
  it('flags single-voice leap > 1 octave', () => {
    // [1] C4 → C#5 = +13 半音 (octave 超)
    // [2] は離して E3 にしておく (voice crossing が出ないように)
    const source = '[1]| C4m | C#5m |\n[2]| E3m | E3m  |';
    const { matrix } = analyzeMatrix(source);
    const { observations } = analyzeVoiceLeading(matrix);
    const leap = observations.find(o => o.kind === 'largeLeap');
    expect(leap).toBeDefined();
    expect(leap!.parts).toEqual(['1']);
  });

  it('does not flag exactly an octave (12 半音)', () => {
    // [1] C4 → C5 = +12 (octave). 閾値は > 12 なので safe
    const source = '[1]| C4m | C5m |\n[2]| E3m | E3m |';
    const { matrix } = analyzeMatrix(source);
    const { observations } = analyzeVoiceLeading(matrix);
    expect(observations.filter(o => o.kind === 'largeLeap')).toHaveLength(0);
  });
});

describe('analyzeVoiceLeading — skipping parts without notes', () => {
  it('omits parts whose cell is silent (all rests)', () => {
    const source = '[1]| C5m | D5m |\n[2]| Rm  | Rm  |';
    const { matrix } = analyzeMatrix(source);
    const { transitions } = analyzeVoiceLeading(matrix);
    expect(transitions[0].voiceDeltas.has('1')).toBe(true);
    expect(transitions[0].voiceDeltas.has('2')).toBe(false);
  });
});

describe('analyzeVoiceLeading — 5-part: all C(5,2)=10 pairs are checked', () => {
  it('flags parallel fifths between non-adjacent parts [1] and [3] in 5-voice texture', () => {
    // 5 parts. [1] と [3] のみが平行 5 度で動く。他は静止。
    // [1]: C5→D5 (+2)
    // [2]: G4→G4 (0)  → 隣接ペア (1,2)/(2,3) は oblique → 安全
    // [3]: F4→G4 (+2) → (1,3) ペアが C5-F4=P5 から D5-G4=P5 に進む = parallelFifths
    // [4]: C4→C4 (0)
    // [5]: F3→F3 (0)
    // 隣接ペア (4,5)/(2,4)/(2,5)/(1,4)/(1,5) は全部 oblique か static。
    // → 「全 10 ペアを検査するので非隣接 (1,3) も検出される」ことを保証する回帰
    const source =
      '[1]| C5m | D5m |\n' +
      '[2]| G4m | G4m |\n' +
      '[3]| F4m | G4m |\n' +
      '[4]| C4m | C4m |\n' +
      '[5]| F3m | F3m |';
    const { matrix } = analyzeMatrix(source);
    const { observations } = analyzeVoiceLeading(matrix);
    const p5_13 = observations.find(
      o => o.kind === 'parallelFifths' && o.parts.join(',') === '1,3',
    );
    expect(p5_13).toBeDefined();
  });
});

describe('analyzeVoiceLeading — descriptive framing (no `issues` field)', () => {
  it('exposes observations field, not issues', () => {
    const source = '[1]| C5m | D5m |\n[2]| F4m | G4m |';
    const { matrix } = analyzeMatrix(source);
    const result = analyzeVoiceLeading(matrix);
    expect(result.observations).toBeDefined();
    expect(Array.isArray(result.observations)).toBe(true);
    // descriptive 設計の証跡: prescriptive な `issues` は存在しない
    expect((result as { issues?: unknown }).issues).toBeUndefined();
  });
});
