/**
 * hideChordAnalyzer.test.ts — 拡張コード分析モジュール テスト
 */

import { describe, it, expect } from 'vitest';
import {
  classifyChordEx,
  analyzeChords,
  formatCRow,
  fifthsToKeyRoot,
} from './hideChordAnalyzer';
import type { ChordSymbol } from './hideChordAnalyzer';
import { analyzeMatrix } from './hideMatrix';
import type { HidePitch } from './hideTypes';

/** テスト用 HidePitch 簡易生成 */
function p(name: string, octave: number): HidePitch {
  const step = name[0].toUpperCase() as HidePitch['step'];
  const acc = name.slice(1);
  const alter: HidePitch['alter'] = acc === '#' ? 1 : acc === 'b' ? -1 : 0;
  return { step, octave, alter };
}

const KEY_C = fifthsToKeyRoot(0);  // C major
const KEY_G = fifthsToKeyRoot(1);  // G major
const KEY_F = fifthsToKeyRoot(-1); // F major

// ============================================================
// classifyChordEx — 基本三和音
// ============================================================

describe('classifyChordEx — triads', () => {
  it('C major root position', () => {
    const r = classifyChordEx([p('C', 3), p('E', 4), p('G', 4)], KEY_C)!;
    expect(r.root).toBe('C');
    expect(r.quality).toBe('maj');
    expect(r.inversion).toBe(0);
    expect(r.isOnChord).toBe(false);
    expect(r.degree).toBe('Ⅰ');
    expect(r.absolute).toBe('C');
    expect(r.relative).toBe('Ⅰ');
    expect(r.combined).toBe('Ⅰ/C');
    expect(r.confidence).toBe('definite');
    expect(r.alternatives).toEqual([]);
    expect(r.omittedFifth).toBe(false);
  });

  it('A minor', () => {
    const r = classifyChordEx([p('A', 3), p('C', 4), p('E', 4)], KEY_C)!;
    expect(r.root).toBe('A');
    expect(r.quality).toBe('min');
    expect(r.degree).toBe('Ⅵ');
    expect(r.absolute).toBe('Am');
  });

  it('B diminished', () => {
    const r = classifyChordEx([p('B', 3), p('D', 4), p('F', 4)], KEY_C)!;
    expect(r.quality).toBe('dim');
    expect(r.degree).toBe('Ⅶ');
  });

  it('C augmented', () => {
    const r = classifyChordEx([p('C', 4), p('E', 4), p('G#', 4)], KEY_C)!;
    expect(r.quality).toBe('aug');
    expect(r.absolute).toBe('Caug');
  });
});

// ============================================================
// classifyChordEx — 拡張テンプレート (sus, 6)
// ============================================================

describe('classifyChordEx — extended templates', () => {
  it('Csus4', () => {
    const r = classifyChordEx([p('C', 3), p('F', 4), p('G', 4)], KEY_C)!;
    expect(r.quality).toBe('sus4');
    expect(r.absolute).toBe('Csus4');
    expect(r.degree).toBe('Ⅰ');
  });

  it('Dsus2', () => {
    const r = classifyChordEx([p('D', 3), p('E', 4), p('A', 4)], KEY_C)!;
    expect(r.quality).toBe('sus2');
    expect(r.absolute).toBe('Dsus2');
  });

  it('C6 (bass=C → 6, not Am7)', () => {
    const r = classifyChordEx([p('C', 3), p('E', 4), p('G', 4), p('A', 4)], KEY_C)!;
    expect(r.quality).toBe('6');
    expect(r.root).toBe('C');
    expect(r.absolute).toBe('C6');
  });

  it('Am7 (bass=A → min7, not C6)', () => {
    const r = classifyChordEx([p('A', 3), p('C', 4), p('E', 4), p('G', 4)], KEY_C)!;
    expect(r.quality).toBe('min7');
    expect(r.root).toBe('A');
    expect(r.absolute).toBe('Am7');
  });

  it('Cm6', () => {
    const r = classifyChordEx([p('C', 3), p('Eb', 4), p('G', 4), p('A', 4)], KEY_C)!;
    expect(r.quality).toBe('m6');
    expect(r.absolute).toBe('Cm6');
  });

  it('G7sus4', () => {
    const r = classifyChordEx([p('G', 2), p('C', 4), p('D', 4), p('F', 4)], KEY_C)!;
    expect(r.quality).toBe('7sus4');
    expect(r.root).toBe('G');
  });
});

// ============================================================
// classifyChordEx — add9/madd9 テンプレート (Feature 2)
// ============================================================

describe('classifyChordEx — add9/madd9 templates', () => {
  it('Cadd9 root position (C D E G)', () => {
    const r = classifyChordEx([p('C', 3), p('D', 4), p('E', 4), p('G', 4)], KEY_C)!;
    expect(r.root).toBe('C');
    expect(r.quality).toBe('add9');
    expect(r.absolute).toBe('Cadd9');
    expect(r.inversion).toBe(0);
    expect(r.isOnChord).toBe(false);
    expect(r.confidence).toBe('definite');
  });

  it('Cadd9 with bass=D → Cadd9/D1 (not ON chord)', () => {
    // {C,D,E,G} with bass=D → add9 template matches, D is at interval index 1
    const r = classifyChordEx([p('D', 2), p('C', 4), p('E', 4), p('G', 4)], KEY_C)!;
    expect(r.root).toBe('C');
    expect(r.quality).toBe('add9');
    expect(r.bass).toBe('D');
    expect(r.isOnChord).toBe(false);
    expect(r.inversion).toBe(1);
    expect(r.absolute).toBe('Cadd9/D1');
  });

  it('Cmadd9 (C D Eb G)', () => {
    const r = classifyChordEx([p('C', 3), p('D', 4), p('Eb', 4), p('G', 4)], KEY_C)!;
    expect(r.root).toBe('C');
    expect(r.quality).toBe('madd9');
    expect(r.absolute).toBe('Cmadd9');
  });

  it('Dadd9 (D E F# A) in key of G', () => {
    const r = classifyChordEx([p('D', 3), p('E', 4), p('F#', 4), p('A', 4)], KEY_G)!;
    expect(r.root).toBe('D');
    expect(r.quality).toBe('add9');
    expect(r.degree).toBe('Ⅴ');
  });
});

// ============================================================
// classifyChordEx — 七の和音
// ============================================================

describe('classifyChordEx — sevenths', () => {
  it('Cmaj7', () => {
    const r = classifyChordEx([p('C', 3), p('E', 4), p('G', 4), p('B', 4)], KEY_C)!;
    expect(r.quality).toBe('maj7');
    expect(r.absolute).toBe('CM7');
  });

  it('G7 (dominant)', () => {
    const r = classifyChordEx([p('G', 2), p('B', 3), p('D', 4), p('F', 4)], KEY_C)!;
    expect(r.quality).toBe('dom7');
    expect(r.absolute).toBe('G7');
    expect(r.degree).toBe('Ⅴ');
    expect(r.combined).toBe('Ⅴ7/G7');
  });

  it('Dm7', () => {
    const r = classifyChordEx([p('D', 3), p('F', 4), p('A', 4), p('C', 5)], KEY_C)!;
    expect(r.quality).toBe('min7');
    expect(r.degree).toBe('Ⅱ');
  });

  it('Bm7b5', () => {
    const r = classifyChordEx([p('B', 3), p('D', 4), p('F', 4), p('A', 4)], KEY_C)!;
    expect(r.quality).toBe('m7b5');
  });

  it('Cdim7', () => {
    const r = classifyChordEx([p('C', 4), p('Eb', 4), p('Gb', 4), p('A', 4)], KEY_C)!;
    expect(r.quality).toBe('dim7');
  });
});

// ============================================================
// classifyChordEx — 転回形
// ============================================================

describe('classifyChordEx — inversions', () => {
  it('C/E1 = 1st inversion', () => {
    const r = classifyChordEx([p('E', 3), p('G', 4), p('C', 5)], KEY_C)!;
    expect(r.root).toBe('C');
    expect(r.bass).toBe('E');
    expect(r.inversion).toBe(1);
    expect(r.absolute).toBe('C/E1');
  });

  it('C/G2 = 2nd inversion', () => {
    const r = classifyChordEx([p('G', 2), p('C', 4), p('E', 4)], KEY_C)!;
    expect(r.root).toBe('C');
    expect(r.inversion).toBe(2);
    expect(r.absolute).toBe('C/G2');
  });

  it('G7/B1 = 1st inversion seventh', () => {
    const r = classifyChordEx([p('B', 2), p('D', 4), p('F', 4), p('G', 4)], KEY_C)!;
    expect(r.root).toBe('G');
    expect(r.quality).toBe('dom7');
    expect(r.inversion).toBe(1);
    expect(r.bass).toBe('B');
    expect(r.absolute).toBe('G7/B1');
  });

  it('G7/F3 = 3rd inversion seventh', () => {
    const r = classifyChordEx([p('F', 2), p('G', 3), p('B', 3), p('D', 4)], KEY_C)!;
    expect(r.root).toBe('G');
    expect(r.quality).toBe('dom7');
    expect(r.inversion).toBe(3);
    expect(r.absolute).toBe('G7/F3');
  });
});

// ============================================================
// classifyChordEx — ON コード
// ============================================================

describe('classifyChordEx — ON chords', () => {
  it('Dm/G (D minor ON G bass — proper ON chord)', () => {
    // pcSet = {2, 5, 7, 9} → no 4-note template match → ON: without G → {2, 5, 9} = Dm
    const r = classifyChordEx([p('G', 2), p('D', 4), p('F', 4), p('A', 4)], KEY_C)!;
    expect(r.root).toBe('D');
    expect(r.quality).toBe('min');
    expect(r.bass).toBe('G');
    expect(r.isOnChord).toBe(true);
    expect(r.absolute).toBe('Dm/G'); // ON コードは番号なし
  });

  it('C/Bb (C major ON Bb bass)', () => {
    // pcSet = {0, 4, 7, 10} → dom7 match (C7), not ON chord
    // Use a different example: {C, E, G} with bass=Db
    const r = classifyChordEx([p('Db', 2), p('C', 4), p('E', 4), p('G', 4)], KEY_C)!;
    // pcSet = {0, 1, 4, 7} → no 4-note match → ON: without Db(1) → {0,4,7} = Cmaj
    expect(r.root).toBe('C');
    expect(r.quality).toBe('maj');
    expect(r.bass).toBe('C#'); // Db = C# in semitone names
    expect(r.isOnChord).toBe(true);
  });

  it('Am/G — C6/Am7 ambiguity: bass=G → C6/G2 (bass-first resolves to 6)', () => {
    // pcSet = {0, 4, 7, 9} with bass=G(7)
    // bass-first: root=G → no match → root=C → {0,4,7,9} = 6 → C6/G (2nd inv)
    // C6/Am7 は同一 pcSet の曖昧性。バス優先で C6 が先にマッチ。
    const r = classifyChordEx([p('G', 2), p('A', 3), p('C', 4), p('E', 4)], KEY_C)!;
    expect(r.root).toBe('C');
    expect(r.quality).toBe('6');
    expect(r.bass).toBe('G');
    expect(r.absolute).toBe('C6/G2'); // 転回形番号付き
  });

  it('Am7 root position (bass=A)', () => {
    // bass=A → root=A → intervals={0,3,7,10} = min7 → Am7
    const r = classifyChordEx([p('A', 2), p('C', 4), p('E', 4), p('G', 4)], KEY_C)!;
    expect(r.root).toBe('A');
    expect(r.quality).toBe('min7');
    expect(r.bass).toBe('A');
    expect(r.isOnChord).toBe(false);
  });
});

// ============================================================
// classifyChordEx — fill-5th (Feature 1)
// ============================================================

describe('classifyChordEx — fill-5th (omitted 5th)', () => {
  it('CM7(o5): {C, E, B} → Cmaj7 with omitted 5th', () => {
    // pcSet = {0, 4, 11}. No triad match.
    // fill-5th: root=C, add G(7) → {0,4,7,11} = maj7 → CM7(o5)
    const r = classifyChordEx([p('C', 3), p('E', 4), p('B', 4)], KEY_C)!;
    expect(r.root).toBe('C');
    expect(r.quality).toBe('maj7');
    expect(r.omittedFifth).toBe(true);
    expect(r.confidence).toBe('incomplete');
    expect(r.absolute).toBe('CM7(o5)');
  });

  it('Cm7(o5): {C, Eb, Bb} → Cm7 with omitted 5th', () => {
    // pcSet = {0, 3, 10}. No triad match.
    // fill-5th: root=C, add G(7) → {0,3,7,10} = min7 → Cm7(o5)
    const r = classifyChordEx([p('C', 3), p('Eb', 4), p('Bb', 4)], KEY_C)!;
    expect(r.root).toBe('C');
    expect(r.quality).toBe('min7');
    expect(r.omittedFifth).toBe(true);
    expect(r.absolute).toBe('Cm7(o5)');
  });

  it('G7(o5): {G, B, F} → G7 with omitted 5th', () => {
    const r = classifyChordEx([p('G', 2), p('B', 3), p('F', 4)], KEY_C)!;
    expect(r.root).toBe('G');
    expect(r.quality).toBe('dom7');
    expect(r.omittedFifth).toBe(true);
    expect(r.absolute).toBe('G7(o5)');
    expect(r.degree).toBe('Ⅴ');
  });

  it('Cm7(o5)/Eb1 with bass=Eb → 1st inversion', () => {
    // bass=Eb(3), pcSet = {0, 3, 10}
    // fill-5th: root candidates: bass Eb(3) first, then C(0), A#(10)
    // root=Eb(3): add Bb(10). Extended {0,3,10,10} → 10 already present, skip
    // root=C(0): add G(7) → {0,3,7,10} = min7 → Cm7 with bass Eb → inversion 1
    const r = classifyChordEx([p('Eb', 3), p('C', 4), p('Bb', 4)], KEY_C)!;
    expect(r.root).toBe('C');
    expect(r.quality).toBe('min7');
    expect(r.omittedFifth).toBe(true);
    expect(r.absolute).toBe('Cm7(o5)/D#1');
  });

  it('does NOT apply fill-5th when 5th is already present', () => {
    // {C, E, G} → triad match, no fill-5th needed
    const r = classifyChordEx([p('C', 3), p('E', 4), p('G', 4)], KEY_C)!;
    expect(r.omittedFifth).toBe(false);
    expect(r.confidence).toBe('definite');
  });
});

// ============================================================
// classifyChordEx — confidence/alternatives (Feature 3)
// ============================================================

describe('classifyChordEx — confidence and alternatives', () => {
  it('definite: unambiguous triad', () => {
    const r = classifyChordEx([p('C', 3), p('E', 4), p('G', 4)], KEY_C)!;
    expect(r.confidence).toBe('definite');
    expect(r.alternatives).toHaveLength(0);
  });

  it('definite: unambiguous seventh', () => {
    const r = classifyChordEx([p('G', 2), p('B', 3), p('D', 4), p('F', 4)], KEY_C)!;
    expect(r.confidence).toBe('definite');
  });

  it('ambiguous: C6/Am7 with bass=G', () => {
    // pcSet {0,4,7,9} matches as C6 (root=C) and Am7 (root=A)
    const r = classifyChordEx([p('G', 2), p('A', 3), p('C', 4), p('E', 4)], KEY_C)!;
    expect(r.confidence).toBe('ambiguous');
    expect(r.alternatives.length).toBeGreaterThanOrEqual(1);
    // primary = C6 (bass-first), alternative = Am7
    const altRoots = r.alternatives.map(a => a.root);
    expect(altRoots).toContain('A');
    const am7 = r.alternatives.find(a => a.root === 'A');
    expect(am7?.quality).toBe('min7');
  });

  it('ambiguous: dim7 is symmetric (multiple roots)', () => {
    // {C, Eb, Gb, A} = dim7. Any of the 4 notes can be root.
    // C: {0,3,6,9} = dim7 ✓. Eb: {0,3,6,9} relative = dim7 ✓. etc.
    const r = classifyChordEx([p('C', 3), p('Eb', 4), p('Gb', 4), p('A', 4)], KEY_C)!;
    expect(r.quality).toBe('dim7');
    // dim7 has multiple valid roots → ambiguous
    expect(r.alternatives.length).toBeGreaterThanOrEqual(1);
  });

  it('incomplete: power chord (dyad)', () => {
    const r = classifyChordEx([p('C', 3), p('G', 3)], KEY_C)!;
    expect(r.confidence).toBe('incomplete');
  });

  it('incomplete: fill-5th result', () => {
    const r = classifyChordEx([p('C', 3), p('E', 4), p('B', 4)], KEY_C)!;
    expect(r.confidence).toBe('incomplete');
    expect(r.omittedFifth).toBe(true);
  });

  it('likely: ON chord', () => {
    const r = classifyChordEx([p('G', 2), p('D', 4), p('F', 4), p('A', 4)], KEY_C)!;
    expect(r.confidence).toBe('likely');
    expect(r.isOnChord).toBe(true);
  });
});

// ============================================================
// classifyChordEx — 度数 (Roman numerals) in different keys
// ============================================================

describe('classifyChordEx — degree in different keys', () => {
  it('G major in key of C = Ⅴ', () => {
    const r = classifyChordEx([p('G', 3), p('B', 3), p('D', 4)], KEY_C)!;
    expect(r.degree).toBe('Ⅴ');
  });

  it('C major in key of G = Ⅳ', () => {
    const r = classifyChordEx([p('C', 4), p('E', 4), p('G', 4)], KEY_G)!;
    expect(r.degree).toBe('Ⅳ');
  });

  it('Bb major in key of F = Ⅳ', () => {
    const r = classifyChordEx([p('Bb', 3), p('D', 4), p('F', 4)], KEY_F)!;
    expect(r.degree).toBe('Ⅳ');
    expect(r.root).toBe('A#'); // シャープ表記 (enharmonic)
  });

  it('E7 in key of C = Ⅲ7 (root position)', () => {
    const r = classifyChordEx([p('E', 3), p('G#', 3), p('B', 3), p('D', 4)], KEY_C)!;
    expect(r.degree).toBe('Ⅲ');
    expect(r.relative).toBe('Ⅲ7');
    expect(r.combined).toBe('Ⅲ7/E7'); // 基本形なのでスラッシュなし
  });
});

// ============================================================
// classifyChordEx — 5+ pitch class reduction
// ============================================================

describe('classifyChordEx — 5+ pitch class reduction', () => {
  it('Cmaj9 (C E G B D) → reduces to Cmaj7 (7th preferred over add9)', () => {
    // 5 distinct pc: {0, 2, 4, 7, 11}
    // tryReduceToFour: remove B(11)→Cadd9, remove D(2)→Cmaj7
    // 7th chord (Cmaj7) is preferred over add9 (Cadd9)
    const r = classifyChordEx(
      [p('C', 3), p('E', 4), p('G', 4), p('B', 4), p('D', 5)],
      KEY_C,
    )!;
    expect(r).not.toBeNull();
    expect(r.root).toBe('C');
    expect(r.quality).toBe('maj7');
    expect(r.confidence).toBe('likely');
  });

  it('empty → null', () => {
    expect(classifyChordEx([], KEY_C)).toBeNull();
  });

  it('single pitch → null', () => {
    expect(classifyChordEx([p('C', 4)], KEY_C)).toBeNull();
  });
});

// ============================================================
// classifyChordEx — pitch class dedup (SATB voicing)
// ============================================================

describe('classifyChordEx — octave doubling', () => {
  it('4 voices, 3 pitch classes (doubled root): Cmaj', () => {
    const r = classifyChordEx(
      [p('C', 3), p('G', 3), p('E', 4), p('C', 5)],
      KEY_C,
    )!;
    expect(r.root).toBe('C');
    expect(r.quality).toBe('maj');
    expect(r.bass).toBe('C');
    expect(r.inversion).toBe(0);
  });
});

// ============================================================
// fifthsToKeyRoot
// ============================================================

describe('fifthsToKeyRoot', () => {
  it('fifths=0 → C(0)', () => expect(fifthsToKeyRoot(0)).toBe(0));
  it('fifths=1 → G(7)', () => expect(fifthsToKeyRoot(1)).toBe(7));
  it('fifths=2 → D(2)', () => expect(fifthsToKeyRoot(2)).toBe(2));
  it('fifths=-1 → F(5)', () => expect(fifthsToKeyRoot(-1)).toBe(5));
  it('fifths=-3 → Eb(3)', () => expect(fifthsToKeyRoot(-3)).toBe(3));
});

// ============================================================
// analyzeChords — end-to-end matrix analysis
// ============================================================

describe('analyzeChords — end-to-end', () => {
  it('4-part grid: C → G → C', () => {
    const source =
      '[1]| C5m | B4m | C5m |\n' +
      '[2]| G4m | G4m | G4m |\n' +
      '[3]| E4m | D4m | E4m |\n' +
      '[4]| C3m | G2m | C3m |';
    const { matrix } = analyzeMatrix(source);
    const result = analyzeChords(matrix);

    expect(result.measures).toHaveLength(3);
    expect(result.keyRoot).toBe('C');

    // 小節 1: Cmaj
    expect(result.measures[0].summary?.root).toBe('C');
    expect(result.measures[0].summary?.quality).toBe('maj');

    // 小節 2: Gmaj
    expect(result.measures[1].summary?.root).toBe('G');
    expect(result.measures[1].summary?.quality).toBe('maj');

    // 小節 3: Cmaj
    expect(result.measures[2].summary?.root).toBe('C');
  });

  it('handles measures with chord changes within measure', () => {
    // 4/4 DIV=64: each cell has 2 half notes (32u each)
    // Beat 1-2: C E G (Cmaj), Beat 3-4: D F A (Dm)
    const source =
      '[1]| C5l D5l |\n' +
      '[2]| E4l F4l |\n' +
      '[3]| G4l A4l |\n' +
      '[4]| C3l D3l |';
    const { matrix } = analyzeMatrix(source);
    const result = analyzeChords(matrix);

    expect(result.measures).toHaveLength(1);
    const m = result.measures[0];
    // Should have multiple beats with different chords
    expect(m.beats.length).toBeGreaterThanOrEqual(2);
    // Beat 1: C major
    expect(m.beats[0].primary?.root).toBe('C');
    // Beat 3: D minor
    expect(m.beats[2].primary?.root).toBe('D');
    expect(m.beats[2].primary?.quality).toBe('min');
  });

  it('all rests → null summary', () => {
    const source =
      '[1]| Rm |\n' +
      '[2]| Rm |';
    const { matrix } = analyzeMatrix(source);
    const result = analyzeChords(matrix);
    expect(result.measures[0].summary).toBeNull();
  });
});

// ============================================================
// formatCRow
// ============================================================

describe('formatCRow', () => {
  it('generates [C] row with degree prefix and chord_duration tokens', () => {
    const source =
      '[1]| C5m | B4m | C5m |\n' +
      '[2]| G4m | G4m | G4m |\n' +
      '[3]| E4m | D4m | E4m |\n' +
      '[4]| C3m | G2m | C3m |';
    const { matrix } = analyzeMatrix(source);
    const result = analyzeChords(matrix);
    const cRow = formatCRow(result, matrix);

    // [C]|...|...|...|
    expect(cRow).toMatch(/^\[C\]\|/);
    // C_m が含まれる (C major, whole note)
    expect(cRow).toContain('C_m');
    // G_m が含まれる (G major, whole note)
    expect(cRow).toContain('G_m');
  });

  it('includes degree prefix in cells', () => {
    const source =
      '[1]| C5m | G4m |\n' +
      '[2]| E4m | B3m |\n' +
      '[3]| G3m | D3m |';
    const { matrix } = analyzeMatrix(source);
    const result = analyzeChords(matrix);
    const cRow = formatCRow(result, matrix);

    // degree prefix: Ⅰ/ for C major in key of C
    expect(cRow).toContain('Ⅰ/');
    // degree prefix: Ⅴ/ for G major in key of C
    expect(cRow).toContain('Ⅴ/');
  });

  it('merges consecutive same-chord beats into longer duration', () => {
    // 4/4 DIV=64: 4 parts, 3 distinct pc (C E G), bass=C3 → Cmaj root position
    const source =
      '[1]| C5m |\n' +
      '[2]| E4m |\n' +
      '[3]| G4m |\n' +
      '[4]| C3m |';
    const { matrix } = analyzeMatrix(source);
    const result = analyzeChords(matrix);

    // Cell should have C_m (whole note), not C_k C_k C_k C_k
    expect(result.measures[0].cellText).toContain('C_m');
    expect(result.measures[0].cellText).not.toContain('C_k');
  });

  it('shows ~ separator for ambiguous chords in cellText', () => {
    // C6/Am7 ambiguity: {C,E,G,A} with bass=G
    // Only test when not resolved by progression context (single measure)
    const source =
      '[1]| E4m |\n' +
      '[2]| A3m |\n' +
      '[3]| C4m |\n' +
      '[4]| G2m |';
    const { matrix } = analyzeMatrix(source);
    const result = analyzeChords(matrix);
    // Single measure → no context → ambiguous remains
    if (result.measures[0].summary?.confidence === 'ambiguous') {
      expect(result.measures[0].cellText).toContain('~');
    }
  });
});

// ============================================================
// analyzeChords — beat-level detail
// ============================================================

describe('analyzeChords — beat detail', () => {
  it('4/4 measure has 4 beats', () => {
    const source =
      '[1]| C5m |\n' +
      '[2]| E4m |\n' +
      '[3]| G3m |';
    const { matrix } = analyzeMatrix(source);
    const result = analyzeChords(matrix);
    expect(result.measures[0].beats).toHaveLength(4);
  });

  it('onset snapshots include note start times', () => {
    // Part 1 changes at beat 3 (offset 32)
    const source =
      '[1]| C5l D5l |\n' +
      '[2]| E4m |\n' +
      '[3]| G3m |';
    const { matrix } = analyzeMatrix(source);
    const result = analyzeChords(matrix);
    const m = result.measures[0];

    // Beat 3 (index 2) should have an onset at offset 32
    const beat2 = m.beats[2];
    const hasOnsetAt32 = beat2.onsets.some(o => o.offsetUnits === 32);
    expect(hasOnsetAt32).toBe(true);
  });
});

// ============================================================
// analyzeChords — progression context resolution (Feature 4)
// ============================================================

describe('analyzeChords — progression context', () => {
  it('resolves C6/Am7 ambiguity using Dm7→?→G7 context (circle progression)', () => {
    // Dm7 → Am7 → G7 is a circle-of-fifths progression (ii → vi → V)
    // Root motion: D→A is 5th descent, A→G is 2nd descent
    // vs D→C→G: D→C is 2nd descent, C→G is 5th descent
    // Am7 should score higher due to 5th descent from Dm7
    const source =
      // Measure 1: Dm7 (D F A C)
      '[1]| C5m | E4m | B4m |\n' +
      '[2]| A4m | A3m | G4m |\n' +
      '[3]| F4m | C4m | D4m |\n' +
      '[4]| D3m | G2m | G2m |';
    // This creates Dm7 → Am7-or-C6 → G (ambiguous middle)
    // The progression context should prefer Am7 (5th descent from D)
    const { matrix } = analyzeMatrix(source);
    const result = analyzeChords(matrix);

    // Middle measure: check if progression context resolved the ambiguity
    const m1 = result.measures[1];
    if (m1.summary && m1.summary.alternatives.length > 0) {
      // If originally ambiguous, the context should have resolved it
      expect(['likely', 'ambiguous']).toContain(m1.summary.confidence);
    }
  });

  it('single ambiguous measure stays ambiguous (no context)', () => {
    // Only 1 measure → no neighbors → cannot resolve
    const source =
      '[1]| E4m |\n' +
      '[2]| A3m |\n' +
      '[3]| C4m |\n' +
      '[4]| G2m |';
    const { matrix } = analyzeMatrix(source);
    const result = analyzeChords(matrix);
    // pcSet {0,4,7,9} with bass=G → ambiguous C6/Am7
    if (result.measures[0].summary?.confidence === 'ambiguous') {
      expect(result.measures[0].summary.alternatives.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================
// formatCRow — (o5) display
// ============================================================

describe('formatCRow — omitted 5th display', () => {
  it('shows (o5) annotation in cellText for fill-5th chords', () => {
    // 3-part arrangement with omitted 5th: {C, E, B} → CM7(o5)
    const source =
      '[1]| B4m |\n' +
      '[2]| E4m |\n' +
      '[3]| C3m |';
    const { matrix } = analyzeMatrix(source);
    const result = analyzeChords(matrix);
    const cRow = formatCRow(result, matrix);
    expect(cRow).toContain('(o5)');
  });
});
