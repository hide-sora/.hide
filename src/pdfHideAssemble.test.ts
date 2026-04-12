/**
 * pdfHideAssemble.test.ts — Phase 3 (assembly + diagnostic emit) のユニットテスト
 *
 * 設計:
 *  - 純合成: PdfHideImage を作らず、`Notehead` / `CellBox` / `PageLayout` を
 *    直接組み立てて assembler に渡す。Phase 1/2 のロジックには触らない。
 *  - 各テストは plan H の verification で挙げた 5 ケースに対応:
 *    1. 2 part × 4 measure clean → analyzeMatrix issues 0
 *    2. 1 cell low confidence → cellLowConfidence diagnostic + 行末コメント
 *    3. 1 cell unknown (detection 抜け) → ;unknown コメント + cellUnknown diagnostic
 *    4. ヘッダー文字列が `[CLEF:TREBLE TIME:3/4 KEY:-1 DIV:32]` になる
 *    5. lowConfidenceRatio = (低信頼セル数) / (総セル数)
 *  - 加えて: piano-treble role を unsupportedStaffRole として diagnostic 化
 *    + cell-empty (notehead 0 個) のケース
 */

import { describe, it, expect } from 'vitest';
import { assemblePdfHide } from './pdfHideAssemble';
import type {
  AssemblePdfHideInput,
  PdfHideAssembleResult,
} from './pdfHideAssemble';
import type { CellBox, PageLayout, StaffBand, SystemLayout } from './pdfHideLayout';
import type { PdfHideScoreContext } from './pdfHideMeta';
import type { Notehead, NoteheadDetectionResult } from './pdfHideNotehead';

// ============================================================
// ヘルパー
// ============================================================

/** 2 voice, 4/4, C major, totalMeasures=4 の標準コンテキスト */
function makeContext(overrides: Partial<PdfHideScoreContext> = {}): PdfHideScoreContext {
  return {
    voicePartsCount: 2,
    hasPiano: false,
    hasPercussion: false,
    stavesPerSystem: 2,
    staffRoles: ['voice', 'voice'],
    clefsPerStaff: ['TREBLE', 'TREBLE'],
    initialTimeSignature: { numerator: 4, denominator: 4 },
    initialKeyFifths: 0,
    lyricsRows: 0,
    totalMeasures: 4,
    ...overrides,
  };
}

/** 1 page × 1 system × N staves × M measures の minimal layout を作る */
function makeLayout(opts: {
  pageIndex?: number;
  staves: number;
  measures: number;
}): PageLayout {
  const pageIndex = opts.pageIndex ?? 0;
  const staffBands: StaffBand[] = [];
  for (let s = 0; s < opts.staves; s++) {
    const top = 100 + s * 80;
    const lineYs = [top, top + 10, top + 20, top + 30, top + 40];
    staffBands.push({
      topY: lineYs[0],
      bottomY: lineYs[4],
      lineYs,
      lineSpacing: 10,
    });
  }
  // 各 staff × 各 measure で CellBox を作る (staff 先, measure 後の順)
  const cells: CellBox[] = [];
  const cellWidth = 100;
  const cellLeftStart = 50;
  for (let s = 0; s < opts.staves; s++) {
    for (let m = 0; m < opts.measures; m++) {
      cells.push({
        pageIndex,
        systemIndex: 0,
        staffIndex: s,
        measureIndex: m,
        x: cellLeftStart + m * cellWidth,
        y: staffBands[s].topY,
        width: cellWidth - 1,
        height: staffBands[s].bottomY - staffBands[s].topY + 1,
      });
    }
  }
  const sys: SystemLayout = {
    systemIndex: 0,
    topY: staffBands[0].topY,
    bottomY: staffBands[staffBands.length - 1].bottomY,
    staves: staffBands,
    barlineXs: Array.from(
      { length: opts.measures + 1 },
      (_, i) => cellLeftStart - 0.5 + i * cellWidth,
    ),
    cells,
  };
  return {
    pageIndex,
    width: 1000,
    height: 800,
    systems: [sys],
    warnings: [],
  };
}

/** 単音 quarter note の Notehead を作る (default 高 confidence) */
function makeQuarterNotehead(opts: {
  centroidX: number;
  centroidY: number;
  letter: Notehead['letter'];
  octave: number;
  alter?: number;
  confidence?: number;
  durationUnits?: number;
}): Notehead {
  const width = 12;
  const height = 10;
  return {
    centroidX: opts.centroidX,
    centroidY: opts.centroidY,
    width,
    height,
    bboxX: opts.centroidX - width / 2,
    bboxY: opts.centroidY - height / 2,
    fillRatio: 0.85,
    kind: 'filled',
    confidence: opts.confidence ?? 0.95,
    letter: opts.letter,
    octave: opts.octave,
    alter: opts.alter ?? 0,
    midi: 60,
    accidentalSource: opts.alter && opts.alter !== 0 ? 'explicit' : 'key',
    stemDirection: 'up',
    stemScore: 0.8,
    durationUnits: opts.durationUnits ?? 8,
    dotted: false,
  };
}

/** 4 quarter note の clean cell detection result を作る */
function makeCleanQuarterCell(
  cellLeftX: number,
  yCenter: number,
  letter: Notehead['letter'],
  octave: number,
  confidence = 0.95,
): NoteheadDetectionResult {
  const noteheads: Notehead[] = [];
  for (let i = 0; i < 4; i++) {
    noteheads.push(
      makeQuarterNotehead({
        centroidX: cellLeftX + 15 + i * 20,
        centroidY: yCenter,
        letter,
        octave,
        confidence,
      }),
    );
  }
  return { noteheads, minConfidence: confidence, warnings: [] };
}

/** 全 cell に 4 quarter note を埋めた clean detection map を返す */
function makeCleanDetectionMap(
  layout: PageLayout,
  letterPerStaff: Notehead['letter'][],
  octavePerStaff: number[],
): Map<CellBox, NoteheadDetectionResult> {
  const map = new Map<CellBox, NoteheadDetectionResult>();
  for (const sys of layout.systems) {
    for (const cell of sys.cells) {
      const letter = letterPerStaff[cell.staffIndex];
      const octave = octavePerStaff[cell.staffIndex];
      const yCenter = cell.y + cell.height / 2;
      map.set(cell, makeCleanQuarterCell(cell.x, yCenter, letter, octave));
    }
  }
  return map;
}

// ============================================================
// テスト
// ============================================================

describe('assemblePdfHide', () => {
  describe('header', () => {
    it('builds [CLEF:TREBLE TIME:4/4 KEY:0 DIV:32] for default 2-voice C major 4/4', () => {
      const context = makeContext();
      const layout = makeLayout({ staves: 2, measures: 4 });
      const map = makeCleanDetectionMap(layout, ['C', 'G'], [4, 3]);
      const result = assemblePdfHide({
        context,
        pageLayouts: [layout],
        noteheadsByCell: map,
      });
      expect(result.header).toBe('[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]');
      expect(result.hideSource.startsWith(result.header)).toBe(true);
    });

    it('builds [CLEF:TREBLE TIME:3/4 KEY:-1 DIV:32] (plan test #4)', () => {
      const context = makeContext({
        initialTimeSignature: { numerator: 3, denominator: 4 },
        initialKeyFifths: -1,
        totalMeasures: 4,
      });
      const layout = makeLayout({ staves: 2, measures: 4 });
      // 3/4 → 24 unit/measure → 3 quarters (each 8u)
      const map = new Map<CellBox, NoteheadDetectionResult>();
      for (const sys of layout.systems) {
        for (const cell of sys.cells) {
          const yCenter = cell.y + cell.height / 2;
          const noteheads: Notehead[] = [];
          for (let i = 0; i < 3; i++) {
            noteheads.push(
              makeQuarterNotehead({
                centroidX: cell.x + 15 + i * 20,
                centroidY: yCenter,
                letter: 'C',
                octave: 4,
              }),
            );
          }
          map.set(cell, { noteheads, minConfidence: 0.95, warnings: [] });
        }
      }
      const result = assemblePdfHide({
        context,
        pageLayouts: [layout],
        noteheadsByCell: map,
      });
      expect(result.header).toBe('[CLEF:TREBLE TIME:3/4 KEY:-1 DIV:32]');
    });
  });

  describe('clean assembly', () => {
    it('2 part × 4 measure clean → analyzeMatrix issues empty (plan test #1)', () => {
      const context = makeContext();
      const layout = makeLayout({ staves: 2, measures: 4 });
      const map = makeCleanDetectionMap(layout, ['C', 'G'], [4, 3]);
      const result = assemblePdfHide({
        context,
        pageLayouts: [layout],
        noteheadsByCell: map,
      });
      expect(result.partsCount).toBe(2);
      expect(result.measuresCount).toBe(4);
      expect(result.matrixIssues).toEqual([]);
      expect(result.diagnostics).toEqual([]);
      expect(result.lowConfidenceCells).toEqual([]);
      expect(result.lowConfidenceRatio).toBe(0);
      // 全 cell が high
      expect(result.cellConfidence.every((c) => c.confidence === 'high')).toBe(true);
      // hideSource に [1] と [2] が出てくる
      expect(result.hideSource).toContain('[1]');
      expect(result.hideSource).toContain('[2]');
      // 4 quarters per cell × 4 cells × 2 parts = 32 token instances total
      // (具体的に C4k C4k C4k C4k と G3k G3k G3k G3k がそれぞれ 4 行ずつ)
      const c4kCount = (result.hideSource.match(/C4k/g) ?? []).length;
      const g3kCount = (result.hideSource.match(/G3k/g) ?? []).length;
      expect(c4kCount).toBe(16); // 4 cells × 4 notes
      expect(g3kCount).toBe(16);
    });

    it('handles 1 part × 4 measure clean (single voice)', () => {
      const context = makeContext({
        voicePartsCount: 1,
        stavesPerSystem: 1,
        staffRoles: ['voice'],
        clefsPerStaff: ['TREBLE'],
      });
      const layout = makeLayout({ staves: 1, measures: 4 });
      const map = makeCleanDetectionMap(layout, ['D'], [5]);
      const result = assemblePdfHide({
        context,
        pageLayouts: [layout],
        noteheadsByCell: map,
      });
      expect(result.partsCount).toBe(1);
      expect(result.measuresCount).toBe(4);
      expect(result.matrixIssues).toEqual([]);
      expect(result.diagnostics).toEqual([]);
    });
  });

  describe('confidence binning', () => {
    it('mid confidence → cellLowConfidence diagnostic + row-end comment (plan test #2)', () => {
      const context = makeContext();
      const layout = makeLayout({ staves: 2, measures: 4 });
      const map = makeCleanDetectionMap(layout, ['C', 'G'], [4, 3]);
      // Pick the 2nd cell of part 1 (staffIndex 0, measureIndex 1) and degrade its confidence
      const targetCell = layout.systems[0].cells.find(
        (c) => c.staffIndex === 0 && c.measureIndex === 1,
      )!;
      const targetDetection = map.get(targetCell)!;
      const degraded: NoteheadDetectionResult = {
        noteheads: targetDetection.noteheads.map((n) => ({ ...n, confidence: 0.7 })),
        minConfidence: 0.7,
        warnings: [],
      };
      map.set(targetCell, degraded);

      const result = assemblePdfHide({
        context,
        pageLayouts: [layout],
        noteheadsByCell: map,
      });
      // matrixIssues は依然として空 (token 列は valid)
      expect(result.matrixIssues).toEqual([]);
      // 該当 cell に対する cellLowConfidence diagnostic が 1 件出る
      const lowDiags = result.diagnostics.filter(
        (d) => d.kind === 'cellLowConfidence',
      );
      expect(lowDiags.length).toBe(1);
      expect(lowDiags[0]).toMatchObject({
        kind: 'cellLowConfidence',
        partLabel: '1',
        pageIndex: 0,
        systemIndex: 0,
        staffIndex: 0,
        measureIndex: 1,
        globalMeasureIndex: 1,
      });
      // 行末コメントがソースに入る
      expect(result.hideSource).toContain(';mid-confidence:p0s0i0m1');
      // lowConfidenceCells に 1 件
      expect(result.lowConfidenceCells.length).toBe(1);
      expect(result.lowConfidenceCells[0].confidence).toBe('mid');
      expect(result.lowConfidenceCells[0].measureIndex).toBe(1);
    });

    it('low confidence (< 0.55) → confidence "low" + cellLowConfidence diagnostic', () => {
      const context = makeContext();
      const layout = makeLayout({ staves: 2, measures: 4 });
      const map = makeCleanDetectionMap(layout, ['C', 'G'], [4, 3]);
      const targetCell = layout.systems[0].cells.find(
        (c) => c.staffIndex === 1 && c.measureIndex === 2,
      )!;
      const targetDetection = map.get(targetCell)!;
      map.set(targetCell, {
        noteheads: targetDetection.noteheads.map((n) => ({ ...n, confidence: 0.3 })),
        minConfidence: 0.3,
        warnings: [],
      });
      const result = assemblePdfHide({
        context,
        pageLayouts: [layout],
        noteheadsByCell: map,
      });
      const lowDiags = result.diagnostics.filter(
        (d) => d.kind === 'cellLowConfidence',
      );
      expect(lowDiags.length).toBe(1);
      // 該当 cell の confidence は "low"
      const cc = result.cellConfidence.find(
        (c) => c.staffIndex === 1 && c.measureIndex === 2,
      );
      expect(cc?.confidence).toBe('low');
      // cellId format: p<page>s<system>i<staff>m<measure> (system 0, staff 1, measure 2)
      expect(result.hideSource).toContain(';low-confidence:p0s0i1m2');
    });

    it('high confidence (>= 0.85) → no diagnostic, no comment', () => {
      const context = makeContext({
        voicePartsCount: 1,
        stavesPerSystem: 1,
        staffRoles: ['voice'],
        clefsPerStaff: ['TREBLE'],
        totalMeasures: 2,
      });
      const layout = makeLayout({ staves: 1, measures: 2 });
      const map = makeCleanDetectionMap(layout, ['C'], [4]);
      const result = assemblePdfHide({
        context,
        pageLayouts: [layout],
        noteheadsByCell: map,
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.hideSource).not.toContain(';mid-confidence');
      expect(result.hideSource).not.toContain(';low-confidence');
      expect(result.hideSource).not.toContain(';unknown');
    });
  });

  describe('unknown / empty cells', () => {
    it('detection が無い cell → cellUnknown diagnostic + ;unknown comment + rest filler (plan test #3)', () => {
      const context = makeContext({
        voicePartsCount: 1,
        stavesPerSystem: 1,
        staffRoles: ['voice'],
        clefsPerStaff: ['TREBLE'],
      });
      const layout = makeLayout({ staves: 1, measures: 4 });
      const map = makeCleanDetectionMap(layout, ['C'], [4]);
      // Remove cell at measure 2
      const targetCell = layout.systems[0].cells.find(
        (c) => c.staffIndex === 0 && c.measureIndex === 2,
      )!;
      map.delete(targetCell);

      const result = assemblePdfHide({
        context,
        pageLayouts: [layout],
        noteheadsByCell: map,
      });
      // cellUnknown 1 件
      const unknownDiags = result.diagnostics.filter(
        (d) => d.kind === 'cellUnknown',
      );
      expect(unknownDiags.length).toBe(1);
      expect(unknownDiags[0]).toMatchObject({
        kind: 'cellUnknown',
        partLabel: '1',
        measureIndex: 2,
        globalMeasureIndex: 2,
      });
      // ソースに `;unknown:p0s0i0m2` が出る
      expect(result.hideSource).toContain(';unknown:p0s0i0m2');
      // 該当 cell は rest で埋められる (4/4 → Rm)
      // 行レベルで `| Rm ;unknown:p0s0i0m2` の形を確認
      const lines = result.hideSource.split('\n');
      const unknownLine = lines.find((l) => l.includes(';unknown:p0s0i0m2'));
      expect(unknownLine).toBeDefined();
      expect(unknownLine).toContain('| Rm');
      // matrixIssues は空 (rest fill が完璧)
      expect(result.matrixIssues).toEqual([]);
      // lowConfidenceCells に該当セルが含まれる
      expect(result.lowConfidenceCells.some((c) => c.measureIndex === 2)).toBe(true);
    });

    it('detection が空 (notehead 0) → cellEmpty diagnostic + ;cell-empty comment', () => {
      const context = makeContext({
        voicePartsCount: 1,
        stavesPerSystem: 1,
        staffRoles: ['voice'],
        clefsPerStaff: ['TREBLE'],
      });
      const layout = makeLayout({ staves: 1, measures: 2 });
      const map = makeCleanDetectionMap(layout, ['C'], [4]);
      const targetCell = layout.systems[0].cells.find(
        (c) => c.measureIndex === 0,
      )!;
      map.set(targetCell, { noteheads: [], minConfidence: 1.0, warnings: [] });
      const result = assemblePdfHide({
        context,
        pageLayouts: [layout],
        noteheadsByCell: map,
      });
      const emptyDiags = result.diagnostics.filter((d) => d.kind === 'cellEmpty');
      expect(emptyDiags.length).toBe(1);
      expect(result.hideSource).toContain(';cell-empty:p0s0i0m0');
      expect(result.matrixIssues).toEqual([]);
    });
  });

  describe('lowConfidenceRatio', () => {
    it('returns 0 for all-high cells (plan test #5 baseline)', () => {
      const context = makeContext();
      const layout = makeLayout({ staves: 2, measures: 4 });
      const map = makeCleanDetectionMap(layout, ['C', 'G'], [4, 3]);
      const result = assemblePdfHide({
        context,
        pageLayouts: [layout],
        noteheadsByCell: map,
      });
      expect(result.lowConfidenceRatio).toBe(0);
    });

    it('returns 1/8 for 1 mid-confidence out of 8 (plan test #5)', () => {
      const context = makeContext();
      const layout = makeLayout({ staves: 2, measures: 4 });
      const map = makeCleanDetectionMap(layout, ['C', 'G'], [4, 3]);
      const targetCell = layout.systems[0].cells[3]; // arbitrary cell
      const original = map.get(targetCell)!;
      map.set(targetCell, {
        noteheads: original.noteheads.map((n) => ({ ...n, confidence: 0.7 })),
        minConfidence: 0.7,
        warnings: [],
      });
      const result = assemblePdfHide({
        context,
        pageLayouts: [layout],
        noteheadsByCell: map,
      });
      expect(result.cellConfidence.length).toBe(8);
      expect(result.lowConfidenceRatio).toBeCloseTo(1 / 8, 5);
    });

    it('returns 1.0 when all cells are unknown', () => {
      const context = makeContext({
        voicePartsCount: 1,
        stavesPerSystem: 1,
        staffRoles: ['voice'],
        clefsPerStaff: ['TREBLE'],
        totalMeasures: 2,
      });
      const layout = makeLayout({ staves: 1, measures: 2 });
      const result = assemblePdfHide({
        context,
        pageLayouts: [layout],
        noteheadsByCell: new Map(),
      });
      expect(result.cellConfidence.length).toBe(2);
      expect(result.lowConfidenceRatio).toBe(1);
      expect(result.lowConfidenceCells.length).toBe(2);
    });
  });

  describe('staff roles', () => {
    it('emits unsupportedStaffRole diagnostic for piano-treble / piano-bass and skips them', () => {
      const context = makeContext({
        voicePartsCount: 2,
        hasPiano: true,
        stavesPerSystem: 4,
        staffRoles: ['voice', 'voice', 'piano-treble', 'piano-bass'],
        clefsPerStaff: ['TREBLE', 'TREBLE', 'TREBLE', 'BASS'],
      });
      const layout = makeLayout({ staves: 4, measures: 4 });
      // Only fill voice staves; piano staves get nothing
      const map = new Map<CellBox, NoteheadDetectionResult>();
      for (const cell of layout.systems[0].cells) {
        if (cell.staffIndex < 2) {
          const yCenter = cell.y + cell.height / 2;
          map.set(
            cell,
            makeCleanQuarterCell(cell.x, yCenter, 'C', 4 + cell.staffIndex),
          );
        }
      }
      const result = assemblePdfHide({
        context,
        pageLayouts: [layout],
        noteheadsByCell: map,
      });
      const unsupported = result.diagnostics.filter(
        (d) => d.kind === 'unsupportedStaffRole',
      );
      expect(unsupported.length).toBe(2);
      expect(result.partsCount).toBe(2); // piano は除外
      // hideSource に [1], [2] のみ (piano に対応する label は無い)
      expect(result.hideSource).toContain('[1]');
      expect(result.hideSource).toContain('[2]');
      expect(result.hideSource).not.toContain('[3]');
    });
  });

  describe('multi-page layout', () => {
    it('flattens cells across pages in reading order', () => {
      const context = makeContext({
        voicePartsCount: 1,
        stavesPerSystem: 1,
        staffRoles: ['voice'],
        clefsPerStaff: ['TREBLE'],
        totalMeasures: 6,
      });
      const page0 = makeLayout({ pageIndex: 0, staves: 1, measures: 4 });
      const page1 = makeLayout({ pageIndex: 1, staves: 1, measures: 2 });
      const map = new Map<CellBox, NoteheadDetectionResult>();
      for (const layout of [page0, page1]) {
        for (const cell of layout.systems[0].cells) {
          const yCenter = cell.y + cell.height / 2;
          map.set(cell, makeCleanQuarterCell(cell.x, yCenter, 'C', 4));
        }
      }
      const result = assemblePdfHide({
        context,
        pageLayouts: [page0, page1],
        noteheadsByCell: map,
      });
      expect(result.measuresCount).toBe(6); // 4 + 2
      expect(result.matrixIssues).toEqual([]);
      expect(result.diagnostics).toEqual([]);
    });
  });

  describe('part measure count mismatch', () => {
    it('emits partMeasureCountMismatch when one staff has fewer cells than another', () => {
      const context = makeContext();
      const layout = makeLayout({ staves: 2, measures: 4 });
      // Remove the last cell of staff 1
      layout.systems[0].cells = layout.systems[0].cells.filter(
        (c) => !(c.staffIndex === 1 && c.measureIndex === 3),
      );
      const map = makeCleanDetectionMap(layout, ['C', 'G'], [4, 3]);
      const result = assemblePdfHide({
        context,
        pageLayouts: [layout],
        noteheadsByCell: map,
      });
      const mismatches = result.diagnostics.filter(
        (d) => d.kind === 'partMeasureCountMismatch',
      );
      expect(mismatches.length).toBe(1);
      expect(mismatches[0]).toMatchObject({
        kind: 'partMeasureCountMismatch',
        partLabel: '2',
        got: 3,
        expected: 4,
      });
      // ソース末尾に rest fill placeholder が入っている
      expect(result.hideSource).toContain(';unknown:missing-part1-m3');
    });
  });

  describe('totalMeasureCountMismatch', () => {
    it('emits when context.totalMeasures != detected measures', () => {
      const context = makeContext({ totalMeasures: 8 }); // expecting 8 but layout only has 4
      const layout = makeLayout({ staves: 2, measures: 4 });
      const map = makeCleanDetectionMap(layout, ['C', 'G'], [4, 3]);
      const result = assemblePdfHide({
        context,
        pageLayouts: [layout],
        noteheadsByCell: map,
      });
      const mismatch = result.diagnostics.find(
        (d) => d.kind === 'totalMeasureCountMismatch',
      );
      expect(mismatch).toBeDefined();
      expect(mismatch).toMatchObject({
        kind: 'totalMeasureCountMismatch',
        gotMaxAcrossParts: 4,
        contextTotal: 8,
      });
    });
  });

  describe('layoutWarning pull-up', () => {
    it('forwards PageLayout.warnings as layoutWarning diagnostics', () => {
      const context = makeContext({
        voicePartsCount: 1,
        stavesPerSystem: 1,
        staffRoles: ['voice'],
        clefsPerStaff: ['TREBLE'],
      });
      const layout = makeLayout({ staves: 1, measures: 2 });
      layout.warnings.push({
        pageIndex: 0,
        kind: 'irregularLineSpacing',
        detail: 'test warning',
      });
      const map = makeCleanDetectionMap(layout, ['C'], [4]);
      const result = assemblePdfHide({
        context,
        pageLayouts: [layout],
        noteheadsByCell: map,
      });
      const lwDiags = result.diagnostics.filter((d) => d.kind === 'layoutWarning');
      expect(lwDiags.length).toBe(1);
      expect(lwDiags[0]).toMatchObject({
        kind: 'layoutWarning',
        pageIndex: 0,
        layoutKind: 'irregularLineSpacing',
        detail: 'test warning',
      });
    });
  });

  describe('pitch encoding (accidentals)', () => {
    it('encodes alter +1 as #, -1 as b, 0 as bare', () => {
      const context = makeContext({
        voicePartsCount: 1,
        stavesPerSystem: 1,
        staffRoles: ['voice'],
        clefsPerStaff: ['TREBLE'],
      });
      const layout = makeLayout({ staves: 1, measures: 1 });
      const cell = layout.systems[0].cells[0];
      const yCenter = cell.y + cell.height / 2;
      const detection: NoteheadDetectionResult = {
        noteheads: [
          makeQuarterNotehead({
            centroidX: cell.x + 15,
            centroidY: yCenter,
            letter: 'F',
            octave: 4,
            alter: 1,
          }),
          makeQuarterNotehead({
            centroidX: cell.x + 35,
            centroidY: yCenter,
            letter: 'B',
            octave: 4,
            alter: -1,
          }),
          makeQuarterNotehead({
            centroidX: cell.x + 55,
            centroidY: yCenter,
            letter: 'C',
            octave: 5,
            alter: 0,
          }),
          makeQuarterNotehead({
            centroidX: cell.x + 75,
            centroidY: yCenter,
            letter: 'D',
            octave: 5,
            alter: 0,
          }),
        ],
        minConfidence: 0.95,
        warnings: [],
      };
      const map = new Map<CellBox, NoteheadDetectionResult>([[cell, detection]]);
      const result = assemblePdfHide({
        context,
        pageLayouts: [layout],
        noteheadsByCell: map,
      });
      expect(result.hideSource).toContain('F#4');
      expect(result.hideSource).toContain('Bb4');
      expect(result.hideSource).toContain('C5');
      expect(result.hideSource).toContain('D5');
      expect(result.matrixIssues).toEqual([]);
    });
  });

  describe('lowConfidenceCells filter', () => {
    it('contains only non-high cells', () => {
      const context = makeContext();
      const layout = makeLayout({ staves: 2, measures: 4 });
      const map = makeCleanDetectionMap(layout, ['C', 'G'], [4, 3]);
      // Degrade 2 cells, keep 6 high
      const c1 = layout.systems[0].cells[1];
      const c2 = layout.systems[0].cells[5];
      for (const c of [c1, c2]) {
        const orig = map.get(c)!;
        map.set(c, {
          noteheads: orig.noteheads.map((n) => ({ ...n, confidence: 0.6 })),
          minConfidence: 0.6,
          warnings: [],
        });
      }
      const result = assemblePdfHide({
        context,
        pageLayouts: [layout],
        noteheadsByCell: map,
      });
      expect(result.lowConfidenceCells.length).toBe(2);
      expect(result.lowConfidenceRatio).toBeCloseTo(2 / 8, 5);
      expect(result.cellConfidence.filter((c) => c.confidence !== 'high').length).toBe(2);
    });
  });
});
