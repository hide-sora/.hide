/**
 * pdfHideNotehead.test.ts — Phase 2b notehead detection の単体テスト
 *
 * 全 fixture は synthetic (合成画像)。実際の Bravura template を image に貼り付ける
 * ことで NCC が成立する状況を再現し、algorithm の正しさを検証する。
 *
 * 主な対象:
 *  - notehead 検出 (filled / hollow / whole / x)
 *  - clef + key signature による pitch 計算
 *  - accidental template match + carry-over
 *  - stem 検出 + duration 推定
 */

import { describe, expect, it } from 'vitest';

import { detectNoteheadsInCell } from './pdfHideNotehead';
import type { NoteheadDetectionInput } from './pdfHideNotehead';
import type { PdfHideImage } from './pdfHideImage';
import type { CellBox, StaffBand } from './pdfHideLayout';
import { TEMPLATES } from './pdfHideTemplates';
import type { TemplateBitmap, TemplateName } from './pdfHideTemplates';

// ============================================================
// fixture helpers
// ============================================================

function makeImage(width: number, height: number): PdfHideImage {
  const data = new Uint8ClampedArray(width * height * 4);
  // 全部白 + alpha=255
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
  return { data, width, height };
}

function setBlack(image: PdfHideImage, x: number, y: number): void {
  if (x < 0 || x >= image.width || y < 0 || y >= image.height) return;
  const i = (y * image.width + x) * 4;
  image.data[i] = 0;
  image.data[i + 1] = 0;
  image.data[i + 2] = 0;
  image.data[i + 3] = 255;
}

function drawHLine(image: PdfHideImage, y: number, x0: number, x1: number): void {
  for (let x = x0; x <= x1; x++) setBlack(image, x, y);
}

function drawVLine(image: PdfHideImage, x: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) setBlack(image, x, y);
}

/**
 * staff band (5 線) を引く。lineSpacing は固定 (px)。
 * 戻り値の StaffBand は detectNoteheadsInCell に渡せる形。
 */
function drawStaff(
  image: PdfHideImage,
  topY: number,
  lineSpacing: number,
  x0: number,
  x1: number,
): StaffBand {
  const lineYs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const y = topY + i * lineSpacing;
    drawHLine(image, y, x0, x1);
    lineYs.push(y);
  }
  return {
    topY: lineYs[0],
    bottomY: lineYs[4],
    lineYs,
    lineSpacing,
  };
}

/**
 * 既存 template を image の (cx, cy) に中心合わせで貼り付ける。
 * 1=foreground は黒、0=background は触らない (重ね描き可能)。
 */
function drawTemplateAt(
  image: PdfHideImage,
  template: TemplateBitmap,
  cx: number,
  cy: number,
): void {
  const sx = Math.round(cx - template.width / 2);
  const sy = Math.round(cy - template.height / 2);
  for (let ty = 0; ty < template.height; ty++) {
    for (let tx = 0; tx < template.width; tx++) {
      if (template.data[ty * template.width + tx] === 1) {
        setBlack(image, sx + tx, sy + ty);
      }
    }
  }
}

/** 共通 cell box (staff 1 本分の縦範囲を覆う) */
function makeCell(x: number, y: number, w: number, h: number): CellBox {
  return {
    pageIndex: 0,
    systemIndex: 0,
    staffIndex: 0,
    measureIndex: 0,
    x,
    y,
    width: w,
    height: h,
  };
}

function pickTemplate(name: TemplateName, lineSpacing: number): TemplateBitmap {
  const t = TEMPLATES[name][lineSpacing];
  if (!t) {
    throw new Error(
      `test fixture: template ${name} not generated for lineSpacing=${lineSpacing}`,
    );
  }
  return t;
}

/** よく使う共通入力 */
function commonInput(
  pageImage: PdfHideImage,
  cell: CellBox,
  staffBand: StaffBand,
  clef: string,
  keyFifths: number,
): NoteheadDetectionInput {
  return { pageImage, cell, staffBand, clef, keyFifths };
}

// ============================================================
// 1. 空 cell
// ============================================================

describe('detectNoteheadsInCell — empty cell', () => {
  it('staff だけ (notehead なし) → 空配列 + cellEmpty 警告', () => {
    const lineSpacing = 12;
    const img = makeImage(200, 200);
    const staff = drawStaff(img, 80, lineSpacing, 10, 190);
    const cell = makeCell(20, 70, 160, 80);
    const result = detectNoteheadsInCell(commonInput(img, cell, staff, 'TREBLE', 0));
    expect(result.noteheads).toHaveLength(0);
    expect(result.minConfidence).toBe(1.0);
    expect(result.warnings.some((w) => w.kind === 'cellEmpty')).toBe(true);
  });
});

// ============================================================
// 2. 単一 filled notehead (TREBLE clef、staff line 3 = B4)
// ============================================================

describe('detectNoteheadsInCell — single filled notehead pitch', () => {
  it('TREBLE clef、line 3 (lineYs[2]) に filled notehead → letter B, octave 4', () => {
    const lineSpacing = 12;
    const img = makeImage(240, 240);
    const staff = drawStaff(img, 80, lineSpacing, 10, 230);
    // line 3 (= 中線) = lineYs[2] = 80 + 2*12 = 104
    const cx = 120;
    const cy = staff.lineYs[2];
    const tmpl = pickTemplate('noteheadBlack', lineSpacing);
    drawTemplateAt(img, tmpl, cx, cy);

    const cell = makeCell(20, 60, 200, 100);
    const result = detectNoteheadsInCell(commonInput(img, cell, staff, 'TREBLE', 0));

    expect(result.noteheads).toHaveLength(1);
    const nh = result.noteheads[0];
    expect(nh.kind).toBe('filled');
    expect(nh.letter).toBe('B');
    expect(nh.octave).toBe(4);
    expect(nh.alter).toBe(0);
    expect(nh.midi).toBe(71); // B4
    // centroid は ±2px 以内で template 中心に一致
    expect(Math.abs(nh.centroidX - cx)).toBeLessThanOrEqual(2);
    expect(Math.abs(nh.centroidY - cy)).toBeLessThanOrEqual(2);
  });

  it('TREBLE clef、bottom line (lineYs[4]) → letter E, octave 4', () => {
    const lineSpacing = 12;
    const img = makeImage(240, 240);
    const staff = drawStaff(img, 80, lineSpacing, 10, 230);
    const cx = 120;
    const cy = staff.lineYs[4];
    drawTemplateAt(img, pickTemplate('noteheadBlack', lineSpacing), cx, cy);

    const cell = makeCell(20, 60, 200, 100);
    const result = detectNoteheadsInCell(commonInput(img, cell, staff, 'TREBLE', 0));

    expect(result.noteheads).toHaveLength(1);
    expect(result.noteheads[0].letter).toBe('E');
    expect(result.noteheads[0].octave).toBe(4);
    expect(result.noteheads[0].midi).toBe(64); // E4
  });

  it('TREBLE clef、top line (lineYs[0]) → letter F, octave 5', () => {
    const lineSpacing = 12;
    const img = makeImage(240, 240);
    const staff = drawStaff(img, 80, lineSpacing, 10, 230);
    const cx = 120;
    const cy = staff.lineYs[0];
    drawTemplateAt(img, pickTemplate('noteheadBlack', lineSpacing), cx, cy);

    const cell = makeCell(20, 60, 200, 100);
    const result = detectNoteheadsInCell(commonInput(img, cell, staff, 'TREBLE', 0));

    expect(result.noteheads).toHaveLength(1);
    expect(result.noteheads[0].letter).toBe('F');
    expect(result.noteheads[0].octave).toBe(5);
    expect(result.noteheads[0].midi).toBe(77); // F5
  });
});

// ============================================================
// 3. clef 違い (BASS / ALTO)
// ============================================================

describe('detectNoteheadsInCell — clef variation', () => {
  it('BASS clef、top line (lineYs[0]) → letter A, octave 3', () => {
    const lineSpacing = 12;
    const img = makeImage(240, 240);
    const staff = drawStaff(img, 80, lineSpacing, 10, 230);
    const cx = 120;
    const cy = staff.lineYs[0];
    drawTemplateAt(img, pickTemplate('noteheadBlack', lineSpacing), cx, cy);

    const cell = makeCell(20, 60, 200, 100);
    const result = detectNoteheadsInCell(commonInput(img, cell, staff, 'BASS', 0));

    expect(result.noteheads).toHaveLength(1);
    expect(result.noteheads[0].letter).toBe('A');
    expect(result.noteheads[0].octave).toBe(3);
    expect(result.noteheads[0].midi).toBe(57); // A3
  });

  it('ALTO clef、middle line (lineYs[2]) → letter C, octave 4', () => {
    const lineSpacing = 12;
    const img = makeImage(240, 240);
    const staff = drawStaff(img, 80, lineSpacing, 10, 230);
    const cx = 120;
    const cy = staff.lineYs[2];
    drawTemplateAt(img, pickTemplate('noteheadBlack', lineSpacing), cx, cy);

    const cell = makeCell(20, 60, 200, 100);
    const result = detectNoteheadsInCell(commonInput(img, cell, staff, 'ALTO', 0));

    expect(result.noteheads).toHaveLength(1);
    expect(result.noteheads[0].letter).toBe('C');
    expect(result.noteheads[0].octave).toBe(4);
    expect(result.noteheads[0].midi).toBe(60); // C4 (中央 C)
  });

  it('TENOR clef、4 線目 (lineYs[1]) → letter C, octave 4', () => {
    const lineSpacing = 12;
    const img = makeImage(240, 240);
    const staff = drawStaff(img, 80, lineSpacing, 10, 230);
    const cx = 120;
    const cy = staff.lineYs[1];
    drawTemplateAt(img, pickTemplate('noteheadBlack', lineSpacing), cx, cy);

    const cell = makeCell(20, 60, 200, 100);
    const result = detectNoteheadsInCell(commonInput(img, cell, staff, 'TENOR', 0));

    expect(result.noteheads).toHaveLength(1);
    expect(result.noteheads[0].letter).toBe('C');
    expect(result.noteheads[0].octave).toBe(4);
  });
});

// ============================================================
// 4. notehead 形状の違い (filled / hollow / whole / x)
// ============================================================

describe('detectNoteheadsInCell — notehead kind classification', () => {
  it('hollow notehead (half note の頭) → kind = hollow', () => {
    const lineSpacing = 12;
    const img = makeImage(240, 240);
    const staff = drawStaff(img, 80, lineSpacing, 10, 230);
    const cx = 120;
    const cy = staff.lineYs[2];
    drawTemplateAt(img, pickTemplate('noteheadHalf', lineSpacing), cx, cy);

    const cell = makeCell(20, 60, 200, 100);
    const result = detectNoteheadsInCell(commonInput(img, cell, staff, 'TREBLE', 0));

    expect(result.noteheads).toHaveLength(1);
    expect(result.noteheads[0].kind).toBe('hollow');
  });

  it('whole notehead (全音符) → kind = whole', () => {
    const lineSpacing = 12;
    const img = makeImage(240, 240);
    const staff = drawStaff(img, 80, lineSpacing, 10, 230);
    const cx = 120;
    const cy = staff.lineYs[2];
    drawTemplateAt(img, pickTemplate('noteheadWhole', lineSpacing), cx, cy);

    const cell = makeCell(20, 60, 200, 100);
    const result = detectNoteheadsInCell(commonInput(img, cell, staff, 'TREBLE', 0));

    expect(result.noteheads).toHaveLength(1);
    expect(result.noteheads[0].kind).toBe('whole');
  });

  it('× notehead (percussion) → kind = x', () => {
    const lineSpacing = 12;
    const img = makeImage(240, 240);
    const staff = drawStaff(img, 80, lineSpacing, 10, 230);
    const cx = 120;
    const cy = staff.lineYs[2];
    drawTemplateAt(img, pickTemplate('noteheadXBlack', lineSpacing), cx, cy);

    const cell = makeCell(20, 60, 200, 100);
    const result = detectNoteheadsInCell(commonInput(img, cell, staff, 'PERCUSSION', 0));

    expect(result.noteheads).toHaveLength(1);
    expect(result.noteheads[0].kind).toBe('x');
    // percussion clef では letter / midi は出さない
    expect(result.noteheads[0].letter).toBeUndefined();
    expect(result.noteheads[0].midi).toBeUndefined();
  });
});

// ============================================================
// 5. stem 検出 + duration 推定
// ============================================================

describe('detectNoteheadsInCell — stem direction + duration', () => {
  it('filled notehead + 上向き stem → durationUnits = 8 (quarter)', () => {
    const lineSpacing = 12;
    const img = makeImage(240, 240);
    const staff = drawStaff(img, 80, lineSpacing, 10, 230);
    const cx = 120;
    const cy = staff.lineYs[3]; // line 4 = G4 in TREBLE
    const tmpl = pickTemplate('noteheadBlack', lineSpacing);
    drawTemplateAt(img, tmpl, cx, cy);
    // 上向き stem: notehead 右端から上に lineSpacing*4 程度
    const stemX = cx + Math.floor(tmpl.width / 2) - 1;
    drawVLine(img, stemX, cy - lineSpacing * 4, cy);

    const cell = makeCell(20, 60, 200, 100);
    const result = detectNoteheadsInCell(commonInput(img, cell, staff, 'TREBLE', 0));

    expect(result.noteheads).toHaveLength(1);
    const nh = result.noteheads[0];
    expect(nh.kind).toBe('filled');
    expect(nh.stemDirection).toBe('up');
    expect(nh.durationUnits).toBe(8);
  });

  it('filled notehead + 下向き stem → durationUnits = 8 (quarter), direction down', () => {
    const lineSpacing = 12;
    const img = makeImage(240, 240);
    const staff = drawStaff(img, 80, lineSpacing, 10, 230);
    const cx = 120;
    const cy = staff.lineYs[1];
    const tmpl = pickTemplate('noteheadBlack', lineSpacing);
    drawTemplateAt(img, tmpl, cx, cy);
    // 下向き stem: notehead 左端から下
    const stemX = cx - Math.floor(tmpl.width / 2);
    drawVLine(img, stemX, cy, cy + lineSpacing * 4);

    const cell = makeCell(20, 60, 200, 100);
    const result = detectNoteheadsInCell(commonInput(img, cell, staff, 'TREBLE', 0));

    expect(result.noteheads).toHaveLength(1);
    expect(result.noteheads[0].stemDirection).toBe('down');
    expect(result.noteheads[0].durationUnits).toBe(8);
  });

  it('hollow notehead + stem → durationUnits = 16 (half)', () => {
    const lineSpacing = 12;
    const img = makeImage(240, 240);
    const staff = drawStaff(img, 80, lineSpacing, 10, 230);
    const cx = 120;
    const cy = staff.lineYs[2];
    const tmpl = pickTemplate('noteheadHalf', lineSpacing);
    drawTemplateAt(img, tmpl, cx, cy);
    const stemX = cx + Math.floor(tmpl.width / 2) - 1;
    drawVLine(img, stemX, cy - lineSpacing * 4, cy);

    const cell = makeCell(20, 60, 200, 100);
    const result = detectNoteheadsInCell(commonInput(img, cell, staff, 'TREBLE', 0));

    expect(result.noteheads).toHaveLength(1);
    expect(result.noteheads[0].kind).toBe('hollow');
    expect(result.noteheads[0].durationUnits).toBe(16);
  });

  it('whole note (stem なし) → durationUnits = 32', () => {
    const lineSpacing = 12;
    const img = makeImage(240, 240);
    const staff = drawStaff(img, 80, lineSpacing, 10, 230);
    const cx = 120;
    const cy = staff.lineYs[2];
    drawTemplateAt(img, pickTemplate('noteheadWhole', lineSpacing), cx, cy);

    const cell = makeCell(20, 60, 200, 100);
    const result = detectNoteheadsInCell(commonInput(img, cell, staff, 'TREBLE', 0));

    expect(result.noteheads).toHaveLength(1);
    expect(result.noteheads[0].kind).toBe('whole');
    expect(result.noteheads[0].stemDirection).toBe('none');
    expect(result.noteheads[0].durationUnits).toBe(32);
  });
});

// ============================================================
// 6. accidental 検出 + carry-over
// ============================================================

describe('detectNoteheadsInCell — accidental + carry-over', () => {
  it('sharp template が notehead 左にある → alter = 1, source = explicit', () => {
    const lineSpacing = 12;
    const img = makeImage(280, 240);
    const staff = drawStaff(img, 80, lineSpacing, 10, 270);
    const cx = 150;
    const cy = staff.lineYs[3]; // G4
    const ntmpl = pickTemplate('noteheadBlack', lineSpacing);
    drawTemplateAt(img, ntmpl, cx, cy);
    // sharp template を notehead 左 lineSpacing*1 のあたり、垂直方向は同じ
    const stmpl = pickTemplate('accidentalSharp', lineSpacing);
    const ax = cx - Math.floor(ntmpl.width / 2) - lineSpacing - Math.floor(stmpl.width / 2);
    drawTemplateAt(img, stmpl, ax, cy);

    const cell = makeCell(20, 60, 240, 100);
    const result = detectNoteheadsInCell(commonInput(img, cell, staff, 'TREBLE', 0));

    expect(result.noteheads).toHaveLength(1);
    const nh = result.noteheads[0];
    expect(nh.letter).toBe('G');
    expect(nh.octave).toBe(4);
    expect(nh.alter).toBe(1);
    expect(nh.accidentalSource).toBe('explicit');
    expect(nh.midi).toBe(68); // G#4
  });

  it('同 cell 内、最初の note に sharp、後続の同 line/octave note は carry-over', () => {
    const lineSpacing = 12;
    const img = makeImage(360, 240);
    const staff = drawStaff(img, 80, lineSpacing, 10, 350);
    const ntmpl = pickTemplate('noteheadBlack', lineSpacing);
    const stmpl = pickTemplate('accidentalSharp', lineSpacing);
    const cy = staff.lineYs[3]; // G4
    // 1 つ目: sharp + notehead at x=140
    const cx1 = 140;
    drawTemplateAt(img, ntmpl, cx1, cy);
    const ax = cx1 - Math.floor(ntmpl.width / 2) - lineSpacing - Math.floor(stmpl.width / 2);
    drawTemplateAt(img, stmpl, ax, cy);
    // 2 つ目: notehead だけ at x=240 (accidental なし、同じ G4)
    const cx2 = 240;
    drawTemplateAt(img, ntmpl, cx2, cy);

    const cell = makeCell(20, 60, 320, 100);
    const result = detectNoteheadsInCell(commonInput(img, cell, staff, 'TREBLE', 0));

    expect(result.noteheads).toHaveLength(2);
    const [n1, n2] = result.noteheads;
    expect(n1.alter).toBe(1);
    expect(n1.accidentalSource).toBe('explicit');
    expect(n2.alter).toBe(1);
    expect(n2.accidentalSource).toBe('carry');
    expect(n2.midi).toBe(68); // G#4
  });

  it('key signature +1 fifth (G major) → 全 F に default alter = 1', () => {
    const lineSpacing = 12;
    const img = makeImage(240, 240);
    const staff = drawStaff(img, 80, lineSpacing, 10, 230);
    const cx = 120;
    const cy = staff.lineYs[1]; // line 4 = D5 in TREBLE — wait, lineYs[1] in treble = D5
    // Use line 5 (top) → F5 to test the F sharpening
    const cy2 = staff.lineYs[0]; // F5
    drawTemplateAt(img, pickTemplate('noteheadBlack', lineSpacing), cx, cy2);

    const cell = makeCell(20, 60, 200, 100);
    const result = detectNoteheadsInCell(commonInput(img, cell, staff, 'TREBLE', 1));

    expect(result.noteheads).toHaveLength(1);
    const nh = result.noteheads[0];
    expect(nh.letter).toBe('F');
    expect(nh.octave).toBe(5);
    expect(nh.alter).toBe(1);
    expect(nh.accidentalSource).toBe('key');
    expect(nh.midi).toBe(78); // F#5
  });
});

// ============================================================
// 7. 複数 notehead (chord 順序、空間)
// ============================================================

describe('detectNoteheadsInCell — multiple noteheads', () => {
  it('4 つの filled notehead を左→右に配置 → centroidX 順で 4 つ返る', () => {
    const lineSpacing = 12;
    const img = makeImage(360, 240);
    const staff = drawStaff(img, 80, lineSpacing, 10, 350);
    const tmpl = pickTemplate('noteheadBlack', lineSpacing);
    const cy = staff.lineYs[2]; // B4
    const xs = [80, 150, 220, 290];
    for (const x of xs) drawTemplateAt(img, tmpl, x, cy);

    const cell = makeCell(20, 60, 320, 100);
    const result = detectNoteheadsInCell(commonInput(img, cell, staff, 'TREBLE', 0));

    expect(result.noteheads).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(result.noteheads[i].letter).toBe('B');
      expect(result.noteheads[i].octave).toBe(4);
      expect(Math.abs(result.noteheads[i].centroidX - xs[i])).toBeLessThanOrEqual(2);
    }
    // 順序保証
    for (let i = 1; i < 4; i++) {
      expect(result.noteheads[i].centroidX).toBeGreaterThan(result.noteheads[i - 1].centroidX);
    }
  });
});
