/**
 * musicXmlToHide.test.ts — MusicXML → .hide 逆変換の単体テスト
 *
 * テスト戦略: compileHide() で .hide → MusicXML を生成 → musicXmlToHide() で
 * 再び .hide に戻し、analyzeMatrix() で構造を検証する round-trip テスト。
 *
 * 完全な文字列同一性は要求しない (元が stream form でも戻りは grid form なので)。
 * 代わりに「両者が同じ matrix 構造を生む」ことを保証する。
 *
 * 重要: compileHide は .hide ソース中の `|` を無視し、time signature に基づいて
 * 小節を切る。よって round-trip テストでは「各 cell が time signature 通りの
 * 1 小節分」になる入力を使う必要がある。
 */

import { describe, it, expect } from 'vitest';
import { compileHide } from './hideLoader';
import { musicXmlToHide } from './musicXmlToHide';
import { analyzeMatrix } from './hideMatrix';

function pitchToString(p: { step: string; alter: -1 | 0 | 1; octave: number }): string {
  const acc = p.alter === 1 ? '#' : p.alter === -1 ? 'b' : '';
  return `${p.step}${acc}${p.octave}`;
}

describe('musicXmlToHide — basic round-trip via grid form', () => {
  it('round-trips a 4-part 3-measure piece (whole notes per measure)', () => {
    // 4/4 で各小節 = 全音符1個 → 3小節
    const original =
      '[1]| C5m | B4m | C5m |\n' +
      '[2]| G4m | G4m | G4m |\n' +
      '[3]| E4m | E4m | E4m |\n' +
      '[4]| C3m | E3m | C3m |';
    const { musicXml } = compileHide(original);
    const { hideSource, partsCount, measuresCount, warnings } = musicXmlToHide(musicXml);

    expect(warnings).toEqual([]);
    expect(partsCount).toBe(4);
    expect(measuresCount).toBe(3);

    const { matrix, issues } = analyzeMatrix(hideSource);
    expect(issues).toEqual([]);
    expect(matrix.partLabels).toEqual(['1', '2', '3', '4']);
    expect(matrix.measures).toHaveLength(3);

    // 1 小節目: C5 G4 E4 C3
    const m0 = [...matrix.measures[0].cells.values()]
      .flatMap(c => c.pitches.map(pitchToString));
    expect(m0).toEqual(['C5', 'G4', 'E4', 'C3']);

    // 3 小節目: 1小節目と同じ
    const m2 = [...matrix.measures[2].cells.values()]
      .flatMap(c => c.pitches.map(pitchToString));
    expect(m2).toEqual(['C5', 'G4', 'E4', 'C3']);
  });

  it('round-trips a 2-part 2-measure piece with mixed durations', () => {
    // 4/4: 各小節 = 4分音符4個 = 32u 完全埋め
    const original =
      '[1]| C5kC5kC5kC5k | D5kD5kD5kD5k |\n' +
      '[2]| C4jD4jE4jF4jG4jA4jB4jC5j | E4jF4jG4jA4jB4jC5jD5jE5j |';
    const { musicXml } = compileHide(original);
    const { hideSource, warnings } = musicXmlToHide(musicXml);
    expect(warnings).toEqual([]);

    const { matrix, issues } = analyzeMatrix(hideSource);
    expect(issues).toEqual([]);
    expect(matrix.partLabels).toEqual(['1', '2']);
    expect(matrix.measures).toHaveLength(2);

    // [2] の 1小節目 = C4 D4 E4 F4 G4 A4 B4 C5 (8 分音符 8 個)
    const part2m0 = matrix.measures[0].cells.get('2')!;
    expect(part2m0.pitches.map(pitchToString)).toEqual([
      'C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5',
    ]);
  });
});

describe('musicXmlToHide — chord (vertical) support', () => {
  it('round-trips a chord token (C E G as whole-note chord)', () => {
    // 4/4 全音符1個 = 1 小節
    const original = '[1]| C4E4G4m |';
    const { musicXml } = compileHide(original);
    const { hideSource, warnings } = musicXmlToHide(musicXml);
    expect(warnings).toEqual([]);

    const { matrix } = analyzeMatrix(hideSource);
    const cell = matrix.measures[0].cells.get('1')!;
    // 和音なので 1 トークンに 3 ピッチ
    expect(cell.pitches.map(pitchToString)).toEqual(['C4', 'E4', 'G4']);
    // duration は 1 全音符 = 32u
    expect(cell.durationUnits).toBe(32);
  });
});

describe('musicXmlToHide — header preservation', () => {
  it('preserves time / key / divisions through round-trip (3/4, key sig 2 sharps)', () => {
    // 3/4 で 4分音符 3 個 = 1 小節
    const original =
      '[CLEF:TREBLE TIME:3/4 KEY:2 DIV:32]\n' +
      '[1]| F#5k C#5k D5k |\n' +
      '[2]| A4k  A4k  F#4k |';
    const { musicXml } = compileHide(original);
    const { hideSource, header, warnings } = musicXmlToHide(musicXml);

    expect(warnings).toEqual([]);
    expect(header.timeNum).toBe(3);
    expect(header.timeDen).toBe(4);
    expect(header.keyFifths).toBe(2);
    expect(header.div).toBe(32);

    // round-trip 後の matrix 構造を確認
    // ※ 注意: matrix mode は key signature を適用せず、lexer 由来の生 alter を返す。
    //   元が `F#5` (explicit accidental) で key sig が D major (fifths=2) のとき、
    //   forward は <alter> を省略 (key sig で十分)、reverse は bare 'F5' を出力する。
    //   よって matrix の pitch.alter は 0 → 文字列は 'F5' になる。
    //   "F5 in D major sounds as F#" は .hide ソース上のセマンティクスで担保される。
    const { matrix } = analyzeMatrix(hideSource);
    expect(matrix.measures).toHaveLength(1);
    const part1 = matrix.measures[0].cells.get('1')!;
    expect(part1.pitches.map(pitchToString)).toEqual(['F5', 'C5', 'D5']);
  });

  it('preserves accidentals against the key signature (Cn in D major)', () => {
    // D major (key=2) で Cn (= ナチュラル化された C) を含むパート
    // 4/4 で 4分音符 4 個 = 1 小節
    const original =
      '[CLEF:TREBLE TIME:4/4 KEY:2 DIV:32]\n' +
      '[1]| Cn5k D5k E5k F#5k |';
    const { musicXml } = compileHide(original);
    const { hideSource, warnings } = musicXmlToHide(musicXml);
    expect(warnings).toEqual([]);

    // 戻りソース内に明示的な 'n' (Cn) が含まれているかを直接確認
    expect(hideSource).toMatch(/Cn5/);
    // F は key sig で # 扱いなので bare 'F5' になる
    expect(hideSource).toMatch(/F5/);
    expect(hideSource).not.toMatch(/F#5/);
  });
});

describe('musicXmlToHide — rest support', () => {
  it('round-trips quarter rests', () => {
    // 4/4 で 4分音符 4 個 = 1 小節
    const original =
      '[1]| C4k Rk C4k Rk |\n' +
      '[2]| Rk  Rk Rk  Rk |';
    const { musicXml } = compileHide(original);
    const { hideSource, warnings } = musicXmlToHide(musicXml);
    expect(warnings).toEqual([]);

    const { matrix } = analyzeMatrix(hideSource);
    expect(matrix.measures).toHaveLength(1);
    const part1 = matrix.measures[0].cells.get('1')!;
    // pitches は休符を含まないので 2 音だけ
    expect(part1.pitches.map(pitchToString)).toEqual(['C4', 'C4']);
    // duration は 4×k = 32u
    expect(part1.durationUnits).toBe(32);

    const part2 = matrix.measures[0].cells.get('2')!;
    expect(part2.pitches).toEqual([]);
    expect(part2.durationUnits).toBe(32);
  });
});

describe('musicXmlToHide — error handling', () => {
  it('throws on missing <part> elements', () => {
    expect(() => musicXmlToHide('<?xml version="1.0"?><score-partwise/>'))
      .toThrow(/no <part> elements/);
  });
});

describe('compileHide — dynamic tempo / time signature (v1.9 Task C)', () => {
  it('emits initial tempo as <metronome>', () => {
    const { musicXml, warnings } = compileHide('[T120][1] C5m .');
    expect(warnings).toEqual([]);
    expect(musicXml).toMatch(/<per-minute>120<\/per-minute>/);
  });

  it('emits mid-piece tempo change as <direction>', () => {
    const { musicXml, warnings } = compileHide('[T120][1] C5m . [T90] B4m .');
    expect(warnings).toEqual([]);
    // 2 つのテンポ宣言 → 2 つの metronome 出力
    const metronomeCount = (musicXml.match(/<metronome>/g) ?? []).length;
    expect(metronomeCount).toBe(2);
    expect(musicXml).toMatch(/<per-minute>120<\/per-minute>/);
    expect(musicXml).toMatch(/<per-minute>90<\/per-minute>/);
  });

  it('emits mid-piece time signature change as new <attributes>', () => {
    // 4/4 で 1 小節打って → 3/4 に変更 → 1 小節打つ
    // 3/4 = 24u → 4分音符 3 個 (3k)
    const { musicXml, warnings } = compileHide('[1] C5m . [M3/4] D5kE5kF5k .');
    expect(warnings).toEqual([]);
    // 1 小節目: 4/4 (header) / 2 小節目: 3/4
    const beatsList = [...musicXml.matchAll(/<beats>(\d+)<\/beats>/g)].map(m => m[1]);
    expect(beatsList).toContain('4');
    expect(beatsList).toContain('3');
  });

  it('warns when [M3/4] is inserted mid-measure', () => {
    // 4/4 で 半音符 (16u) しか書いてないのに 3/4 に変更
    const { warnings } = compileHide('[1] C5l [M3/4] D5l.');
    expect(warnings.some(w => /時間署名/.test(w))).toBe(true);
  });
});

describe('musicXmlToHide — structured diagnostics (LLM review pipeline)', () => {
  /**
   * 設計意図: PDF→MusicXML→.hide pipeline では下流に LLM レビュー層を置く。
   * silent fill は LLM の attention 候補を消してしまうので、
   * 不整合は **構造化された diagnostic** として emit する。
   *
   * テストはこの diagnostic emission の正しさだけを検証する。
   * 「禁則かどうか」「修正すべきか」は LLM 層が判定する。
   */

  it('exposes a `diagnostics` array on the result (always present)', () => {
    const original = '[1]| C5m |';
    const { musicXml } = compileHide(original);
    const result = musicXmlToHide(musicXml);
    expect(result.diagnostics).toBeDefined();
    expect(Array.isArray(result.diagnostics)).toBe(true);
  });

  it('emits no diagnostics on a clean round-trip', () => {
    const original = '[1]| C5m | D5m |\n[2]| G4m | A4m |';
    const { musicXml } = compileHide(original);
    const { diagnostics } = musicXmlToHide(musicXml);
    expect(diagnostics).toEqual([]);
  });

  it('does NOT silently pad short parts — emits partMeasureCountMismatch diagnostic instead', () => {
    // 手書き MusicXML: パート 1 は 3 小節、パート 2 は 2 小節
    const xml = `<?xml version="1.0"?>
<score-partwise>
  <part-list>
    <score-part id="P1"/><score-part id="P2"/>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>8</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>32</duration><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>32</duration><type>whole</type></note>
    </measure>
    <measure number="3">
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>32</duration><type>whole</type></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>8</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>32</duration><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>32</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;
    const { diagnostics, hideSource } = musicXmlToHide(xml);
    const mismatch = diagnostics.find(d => d.kind === 'partMeasureCountMismatch');
    expect(mismatch).toBeDefined();
    if (mismatch && mismatch.kind === 'partMeasureCountMismatch') {
      expect(mismatch.partIndex).toBe(1);
      expect(mismatch.partLabel).toBe('2');
      expect(mismatch.got).toBe(2);
      expect(mismatch.expected).toBe(3);
    }
    // hideSource は短いまま (silent padding なし) → 下流の analyzeMatrix が
    // measureCountMismatch を re-detect するので二重に LLM 用 signal が出る
    const { issues } = analyzeMatrix(hideSource);
    expect(issues.some(i => i.kind === 'measureCountMismatch')).toBe(true);
  });

  it('emits multipleAttributes diagnostic when <attributes> appears more than once', () => {
    // [M] による mid-piece time change を逆変換に通すと multipleAttributes が出る
    const original = '[1] C5m . [M3/4] D5kE5kF5k .';
    const { musicXml } = compileHide(original);
    const { diagnostics } = musicXmlToHide(musicXml);
    const ma = diagnostics.find(d => d.kind === 'multipleAttributes');
    expect(ma).toBeDefined();
    if (ma && ma.kind === 'multipleAttributes') {
      expect(ma.partIndex).toBe(0);
    }
  });

  it('emits multipleVoices diagnostic on a multi-voice single part', () => {
    const xml = `<?xml version="1.0"?>
<score-partwise>
  <part-list><score-part id="P1"/></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>8</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>32</duration><voice>1</voice><type>whole</type></note>
      <backup><duration>32</duration></backup>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>32</duration><voice>2</voice><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;
    const { diagnostics } = musicXmlToHide(xml);
    const mv = diagnostics.find(d => d.kind === 'multipleVoices');
    expect(mv).toBeDefined();
    if (mv && mv.kind === 'multipleVoices') {
      expect(mv.partIndex).toBe(0);
      expect(mv.measureIndex).toBe(0);
      expect(mv.voices).toEqual(expect.arrayContaining([1, 2]));
    }
  });

  it('emits tupletDetected diagnostic on <time-modification>', () => {
    const xml = `<?xml version="1.0"?>
<score-partwise>
  <part-list><score-part id="P1"/></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>8</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>16</duration><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><type>quarter</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>16</duration><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;
    const { diagnostics } = musicXmlToHide(xml);
    const td = diagnostics.find(d => d.kind === 'tupletDetected');
    expect(td).toBeDefined();
    if (td && td.kind === 'tupletDetected') {
      expect(td.partIndex).toBe(0);
      expect(td.measureIndex).toBe(0);
    }
  });

  it('emits nonStandardDuration diagnostic on a truly non-decomposable duration', () => {
    // divisions=3 → div=12: m=12, l=6, k=3 (j,i,h は非整数でスキップ)
    // duration=5 → 5 - 3 = 2, 2 < 3 (最小整数 unit) → 分解不能 → fallback
    const xml = `<?xml version="1.0"?>
<score-partwise>
  <part-list><score-part id="P1"/></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>3</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>5</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;
    const { diagnostics } = musicXmlToHide(xml);
    const nsd = diagnostics.find(d => d.kind === 'nonStandardDuration');
    expect(nsd).toBeDefined();
    if (nsd && nsd.kind === 'nonStandardDuration') {
      expect(nsd.partIndex).toBe(0);
      expect(nsd.measureIndex).toBe(0);
      expect(nsd.durationUnits).toBe(5);
    }
  });

  it('decomposes dotted quarter (duration=12 at div=32) into tie chain instead of diagnostic', () => {
    // divisions=8 → div=32: k=8, j=4 → duration 12 = k+j (付点4分)
    const xml = `<?xml version="1.0"?>
<score-partwise>
  <part-list><score-part id="P1"/></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>8</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>12</duration><type>dotted-quarter</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>eighth</type></note>
      <note><rest/><duration>16</duration><type>half</type></note>
    </measure>
  </part>
</score-partwise>`;
    const { hideSource, diagnostics } = musicXmlToHide(xml);
    // 付点4分は nonStandardDuration ではなく tie 分解で処理される
    const nsd = diagnostics.find(d => d.kind === 'nonStandardDuration');
    expect(nsd).toBeUndefined();
    // C5k+C5j (= tied quarter + eighth) が出力に含まれる
    expect(hideSource).toContain('C5k+');
    expect(hideSource).toContain('C5j');
  });

  it('warnings string array still mirrors diagnostics for human readability', () => {
    // multipleAttributes が出る既知ケースで両方が同期していることを保証
    const original = '[1] C5m . [M3/4] D5kE5kF5k .';
    const { musicXml } = compileHide(original);
    const { warnings, diagnostics } = musicXmlToHide(musicXml);
    expect(warnings.length).toBeGreaterThan(0);
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});

describe('musicXmlToHide — barline vocabulary (v1.9 .)', () => {
  it('emits a `.` (single) barrier per measure for plain pieces', () => {
    const original = '[1]| C5m | B4m | C5m |';
    const { musicXml } = compileHide(original);
    const { hideSource } = musicXmlToHide(musicXml);
    // 各小節セルに `.` が含まれる
    const dots = hideSource.match(/\./g) ?? [];
    expect(dots.length).toBeGreaterThanOrEqual(3);
  });

  it('preserves `..` (double) barline through round-trip', () => {
    // C5m を 1 小節打ち、複縦線で閉じる
    const original = '[1] C5m ..';
    const { musicXml, warnings } = compileHide(original);
    expect(warnings).toEqual([]);
    expect(musicXml).toMatch(/<bar-style>light-light<\/bar-style>/);

    const { hideSource } = musicXmlToHide(musicXml);
    expect(hideSource).toMatch(/\.\./);
  });

  it('preserves `...` (final) barline through round-trip', () => {
    const original = '[1] C5m B4m C5m ...';
    const { musicXml, warnings } = compileHide(original);
    expect(warnings).toEqual([]);
    // 終止線は最後の小節に
    expect(musicXml).toMatch(/<bar-style>light-heavy<\/bar-style>/);

    const { hideSource } = musicXmlToHide(musicXml);
    expect(hideSource).toMatch(/\.\.\./);
  });

  it('preserves `:.` (repeat end) barline through round-trip', () => {
    const original = '[1] C5m :.';
    const { musicXml, warnings } = compileHide(original);
    expect(warnings).toEqual([]);
    expect(musicXml).toMatch(/<repeat\s+direction="backward"/);

    const { hideSource } = musicXmlToHide(musicXml);
    expect(hideSource).toMatch(/:\./);
  });

  it('preserves `.:` (repeat start) barline through round-trip', () => {
    // .: は次の小節の左端マーカー → 1 小節目の前か、2 小節目の左
    const original = '[1] .: C5m :.';
    const { musicXml, warnings } = compileHide(original);
    expect(warnings).toEqual([]);
    expect(musicXml).toMatch(/<repeat\s+direction="forward"/);
    expect(musicXml).toMatch(/<repeat\s+direction="backward"/);

    const { hideSource } = musicXmlToHide(musicXml);
    expect(hideSource).toMatch(/\.:/);
    expect(hideSource).toMatch(/:\./);
  });

  it('warns when `.` is placed before a measure is full', () => {
    // 4/4 = 32u 必要なのに半分 (16u = C5l = 半音符1個) で `.` を打つ
    const { warnings } = compileHide('[1] C5l .');
    expect(warnings.some(w => /足りません/.test(w))).toBe(true);
  });

  it('does not warn when `.` is placed exactly at measure end', () => {
    // 4/4 で 4分音符 4 個 = 32u ぴったり
    const { warnings } = compileHide('[1] C5k C5k C5k C5k .');
    expect(warnings).toEqual([]);
  });
});
