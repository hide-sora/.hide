/**
 * hideChord.test.ts — chord classifier 単体テスト
 *
 * classifyChord (low-level: HidePitch[] → ChordLabel) と
 * classifyMatrixMeasures (high-level: HideMatrix → ChordLabel[]) を検証する。
 */

import { describe, it, expect } from 'vitest';
import { classifyChord, classifyMatrixMeasures } from './hideChord';
import { analyzeMatrix } from './hideMatrix';
import type { HidePitch } from './hideTypes';

/** テスト用の HidePitch を簡潔に作るヘルパー */
function p(name: string, octave: number): HidePitch {
  // "C", "C#", "Db", "F#", ...
  const step = name[0].toUpperCase() as HidePitch['step'];
  const acc = name.slice(1);
  const alter: -1 | 0 | 1 = acc === '#' ? 1 : acc === 'b' ? -1 : 0;
  return { step, octave, alter };
}

describe('classifyChord — triads', () => {
  it('C major (root position): C E G → Cmaj', () => {
    const r = classifyChord([p('C', 4), p('E', 4), p('G', 4)]);
    expect(r?.symbol).toBe('Cmaj');
    expect(r?.root).toBe('C');
    expect(r?.quality).toBe('maj');
    expect(r?.inverted).toBe(false);
  });

  it('A minor: A C E → Amin', () => {
    const r = classifyChord([p('A', 3), p('C', 4), p('E', 4)]);
    expect(r?.symbol).toBe('Amin');
  });

  it('B diminished: B D F → Bdim', () => {
    const r = classifyChord([p('B', 3), p('D', 4), p('F', 4)]);
    expect(r?.symbol).toBe('Bdim');
  });

  it('C augmented: C E G# → Caug (bass-as-root for symmetric chord)', () => {
    const r = classifyChord([p('C', 4), p('E', 4), p('G#', 4)]);
    expect(r?.symbol).toBe('Caug');
  });

  it('E aug (same pcSet, different bass): E G# C → Eaug', () => {
    const r = classifyChord([p('E', 4), p('G#', 4), p('C', 5)]);
    expect(r?.symbol).toBe('Eaug');
  });
});

describe('classifyChord — inversions', () => {
  it('C/E (first inversion): E in bass + C E G → Cmaj/E', () => {
    const r = classifyChord([p('E', 3), p('G', 3), p('C', 4)]);
    expect(r?.symbol).toBe('Cmaj/E');
    expect(r?.inverted).toBe(true);
    expect(r?.root).toBe('C');
    expect(r?.bass).toBe('E');
  });

  it('C/G (second inversion): G in bass → Cmaj/G', () => {
    const r = classifyChord([p('G', 2), p('C', 4), p('E', 4)]);
    expect(r?.symbol).toBe('Cmaj/G');
    expect(r?.bass).toBe('G');
  });

  it('Am/C: C in bass + A C E → Amin/C', () => {
    const r = classifyChord([p('C', 3), p('E', 4), p('A', 4)]);
    expect(r?.symbol).toBe('Amin/C');
  });
});

describe('classifyChord — sevenths', () => {
  it('Cmaj7: C E G B → Cmaj7', () => {
    const r = classifyChord([p('C', 4), p('E', 4), p('G', 4), p('B', 4)]);
    expect(r?.symbol).toBe('Cmaj7');
  });

  it('C7 (dominant): C E G Bb → Cdom7', () => {
    const r = classifyChord([p('C', 4), p('E', 4), p('G', 4), p('Bb', 4)]);
    expect(r?.symbol).toBe('Cdom7');
  });

  it('Dm7: D F A C → Dmin7', () => {
    const r = classifyChord([p('D', 4), p('F', 4), p('A', 4), p('C', 5)]);
    expect(r?.symbol).toBe('Dmin7');
  });

  it('Bm7b5: B D F A → Bm7b5', () => {
    const r = classifyChord([p('B', 3), p('D', 4), p('F', 4), p('A', 4)]);
    expect(r?.symbol).toBe('Bm7b5');
  });

  it('Cdim7 (fully symmetric): C Eb Gb A → Cdim7 (bass-as-root)', () => {
    const r = classifyChord([p('C', 4), p('Eb', 4), p('Gb', 4), p('A', 4)]);
    expect(r?.symbol).toBe('Cdim7');
  });

  it('CminMaj7: C Eb G B → CminMaj7', () => {
    const r = classifyChord([p('C', 4), p('Eb', 4), p('G', 4), p('B', 4)]);
    expect(r?.symbol).toBe('CminMaj7');
  });
});

describe('classifyChord — pitch class deduplication', () => {
  it('SATB voicing of C major (4 voices, 3 pitch classes): Cmaj', () => {
    // Bass C3, Tenor G3, Alto E4, Soprano C5 — 4 ピッチだが pcSet = {C, E, G}
    const r = classifyChord([p('C', 5), p('E', 4), p('G', 3), p('C', 3)]);
    expect(r?.symbol).toBe('Cmaj');
    expect(r?.bass).toBe('C');
  });

  it('octave-doubled root with 3rd in bass: Cmaj/E', () => {
    const r = classifyChord([p('E', 3), p('C', 4), p('G', 4), p('C', 5)]);
    expect(r?.symbol).toBe('Cmaj/E');
  });
});

describe('classifyChord — non-classifiable inputs', () => {
  it('empty input → null', () => {
    expect(classifyChord([])).toBeNull();
  });

  it('single pitch → null', () => {
    expect(classifyChord([p('C', 4)])).toBeNull();
  });

  it('dyad (2 pitch classes) → null', () => {
    expect(classifyChord([p('C', 4), p('G', 4)])).toBeNull();
  });

  it('chromatic cluster (3 adjacent semitones) → null', () => {
    expect(classifyChord([p('C', 4), p('C#', 4), p('D', 4)])).toBeNull();
  });

  it('5 pitch classes → null (out of v1 scope)', () => {
    expect(classifyChord([
      p('C', 4), p('D', 4), p('E', 4), p('G', 4), p('B', 4),
    ])).toBeNull();
  });
});

describe('classifyMatrixMeasures — end-to-end on matrix mode source', () => {
  it('classifies B.5 4-part grid form', () => {
    // 1: C5  B4  C5
    // 2: G4  G4  G4
    // 3: E4  D4  E4
    // 4: C3  G2  C3
    // → {C E G C} = Cmaj, {B G D G} = Gmaj, {C E G C} = Cmaj
    const source =
      '[1]| C5k | B4k | C5k |\n' +
      '[2]| G4k | G4k | G4k |\n' +
      '[3]| E4k | D4k | E4k |\n' +
      '[4]| C3k | G2k | C3k |';
    const { matrix } = analyzeMatrix(source);
    const labels = classifyMatrixMeasures(matrix);
    expect(labels).toHaveLength(3);
    expect(labels[0]?.symbol).toBe('Cmaj');
    expect(labels[1]?.symbol).toBe('Gmaj');
    expect(labels[2]?.symbol).toBe('Cmaj');
  });

  it('null entries for measures that do not form a recognized chord', () => {
    // 全パート同じ音 → pcSet = {C} → null
    const source =
      '[1]| C4k | C4k |\n' +
      '[2]| C4k | C4k |';
    const { matrix } = analyzeMatrix(source);
    const labels = classifyMatrixMeasures(matrix);
    expect(labels).toEqual([null, null]);
  });
});
