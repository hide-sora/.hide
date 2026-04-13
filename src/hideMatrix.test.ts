/**
 * hideMatrix.test.ts — v2.0 matrix mode 単体テスト
 *
 * vitest による回帰スイート。public/test_hide.html のブラウザ手動テストの
 * うち、matrix mode 部分を自動化したもの。stream mode 側も最低限のスモーク
 * テストを置いて、barline emission 等の lexer 変更で既存挙動が壊れていない
 * ことを保証する。
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeMatrix,
  iterateMeasures,
  measureToChord,
  compileHide,
  tokenize,
} from './index';

function pitchToString(p: { step: string; alter: number; octave: number }): string {
  const acc = p.alter === 1 ? '#' : (p.alter === -1 ? 'b' : '');
  return `${p.step}${acc}${p.octave}`;
}

describe('hideMatrix — analyzeMatrix() basic structure', () => {
  it('parses 4-part grid form (B.5) into 3 measures × 4 parts with no issues', () => {
    // 各 cell = 全音符 1 個 = 64u = 4/4 DIV=64 で full measure
    // (matrix mode は cell.durationUnits == unitsPerMeasure を要求するため、
    //  C5k 等の partial cell を使うと measureDurationMismatch が出てしまう)
    const source =
      '[1]| C5m | B4m | C5m |\n' +
      '[2]| E4m | E4m | E4m |\n' +
      '[3]| G4m | G4m | G4m |\n' +
      '[4]| C3m | G2m | C3m |';
    const { matrix, issues } = analyzeMatrix(source);
    expect(matrix.partLabels).toEqual(['1', '2', '3', '4']);
    expect(matrix.measures).toHaveLength(3);
    expect(issues).toEqual([]);

    // 1小節目: C5 + E4 + G4 + C3 (Cメジャー)
    const m0Chord = measureToChord(matrix, matrix.measures[0]).map(pitchToString);
    expect(m0Chord).toEqual(['C5', 'E4', 'G4', 'C3']);

    // 2小節目: B4 + E4 + G4 + G2 (Eマイナー的)
    const m1Chord = measureToChord(matrix, matrix.measures[1]).map(pitchToString);
    expect(m1Chord).toEqual(['B4', 'E4', 'G4', 'G2']);
  });

  it('parses 6-part a-cappella with [P] voice percussion', () => {
    const source =
      '[1]| C5m | D5m | E5m | F5m |\n' +
      '[2]| G4m | A4m | B4m | C5m |\n' +
      '[3]| E4m | F4m | G4m | A4m |\n' +
      '[4]| C4m | D4m | E4m | F4m |\n' +
      '[5]| C3m | G3m | C4m | G3m |\n' +
      '[P]| C2m | Rm  | C2m | Rm  |';
    const { matrix, issues } = analyzeMatrix(source);
    expect(matrix.partLabels).toEqual(['1', '2', '3', '4', '5', 'P']);
    expect(matrix.measures).toHaveLength(4);
    expect(issues).toEqual([]);

    // [P] パートのメタ情報確認
    expect(matrix.partMetas.get('P')?.displayName).toBe('Voice Percussion');
    expect(matrix.partMetas.get('1')?.displayName).toBe('Voice 1');
  });

  it('handles stream-form (no barlines) as a single measure', () => {
    // 各パート = 全音符 1 個 = 64u (= full measure for 4/4 DIV=64)
    const source = '[1]C5m[2]E4m[3]G4m[4]C3m';
    const { matrix, issues } = analyzeMatrix(source);
    expect(matrix.partLabels).toEqual(['1', '2', '3', '4']);
    expect(matrix.measures).toHaveLength(1);
    expect(issues).toEqual([]);
    expect(matrix.measures[0].cells.get('1')!.pitches.map(pitchToString))
      .toEqual(['C5']);
  });

  it('treats source without any part declaration as a single "M" part', () => {
    // 各 cell = 全音符 1 個 = 64u = full measure
    const source = 'C4m|D4m|E4m|F4m';
    const { matrix, issues } = analyzeMatrix(source);
    expect(matrix.partLabels).toEqual(['M']);
    expect(matrix.measures).toHaveLength(4);
    expect(issues).toEqual([]);
  });
});

describe('hideMatrix — measure consistency checking', () => {
  it('reports measureDurationMismatch when a measure has different durations', () => {
    // [1] の2小節目 = 半音符 1 個 (32u)、他は全音符 (64u = full measure)
    // → 2小節目だけが unitsPerMeasure 不一致 + パート間不一致
    const source =
      '[1]| C4m | C4l | C4m |\n' +
      '[2]| E4m | G4m | C4m |';
    const { issues } = analyzeMatrix(source);
    const mismatch = issues.find(i => i.kind === 'measureDurationMismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch!.measureIndex).toBe(1);
  });

  it('reports measureCountMismatch when parts have different cell counts', () => {
    const source =
      '[1]| C4m | D4m | E4m |\n' +
      '[2]| F4m | G4m       |';
    const { issues } = analyzeMatrix(source);
    const mismatch = issues.find(i => i.kind === 'measureCountMismatch');
    expect(mismatch).toBeDefined();
  });

  it('reports measureDurationMismatch against header expected for partial cell', () => {
    // ヘッダー (4/4 DIV=64) は 64u 期待だが [1] は 16u (= 4分音符 1 個) しか書いてない
    // → 「ヘッダーの期待値 64u と一致しません」というメッセージが出る
    const source = '[1]| C4k |';
    const { issues } = analyzeMatrix(source);
    const headerMismatch = issues.find(
      i => i.kind === 'measureDurationMismatch' && /期待値 64u/.test(i.message),
    );
    expect(headerMismatch).toBeDefined();
  });
});

describe('hideMatrix — iterateMeasures()', () => {
  it('yields measures in source order, with index matching position', () => {
    const source =
      '[1]| C4m | D4m | E4m |\n' +
      '[2]| G4m | A4m | B4m |';
    const { matrix } = analyzeMatrix(source);
    const ms = [...iterateMeasures(matrix)];
    expect(ms).toHaveLength(3);
    expect(ms.map(m => m.index)).toEqual([0, 1, 2]);

    // 2小節目の chord
    const chord = measureToChord(matrix, ms[1]).map(pitchToString);
    expect(chord).toEqual(['D4', 'A4']);
  });
});

describe('hideMatrix — barline tokenization compatibility', () => {
  it('lexer emits barline raw tokens', () => {
    const lex = tokenize('C4k|D4k');
    const barlines = lex.tokens.filter(t => t.kind === 'barline');
    expect(barlines).toHaveLength(1);
  });

  it('parser ignores barlines in stream mode (existing test ⑥ compat)', () => {
    const result = compileHide(
      '[CLEF:TREBLE TIME:4/4 KEY:0 DIV:64]\n; これはコメント\nC4k D4k | E4k F4k\nG4k A4k | B4k C5k',
    );
    expect(result.partsCount).toBe(1);
    // 8 音 + 1 小節分の rest 補完なし → 8 notes spanning 2 measures
    expect(result.measuresCount).toBe(2);
  });

  it('compileHide still works on B.5 grid form', () => {
    const result = compileHide(
      '[1]| C5k | B4k | C5k |\n' +
      '[2]| E4k | E4k | E4k |\n' +
      '[3]| G4k | G4k | G4k |\n' +
      '[4]| C3k | G2k | C3k |',
    );
    expect(result.partsCount).toBe(4);
  });
});

describe('hideMatrix — legacy SATB removal still rejected', () => {
  it('rejects [P1] (legacy)', () => {
    expect(() => compileHide('[P1]C4k')).toThrow();
  });
  it('rejects [S] (legacy)', () => {
    expect(() => compileHide('C4k[S]D4k')).toThrow();
  });
});

describe('hideMatrix — [GRID N] removed since v1.9', () => {
  it('treats [GRID4] as an unknown meta (no special handling)', () => {
    // [GRID N] の特別扱いは v1.9 で削除されたので、未知のメタとしてエラーになる
    expect(() => tokenize('[GRID4][1]C4k')).toThrow();
  });
});
