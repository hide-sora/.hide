/**
 * pdfHideLayout.test.ts — pdfHideLayout.ts の動作テスト
 *
 * 全 fixture はコード内合成 (synthetic RGBA)、PNG ファイル不要。
 * 「黒い水平線 = staff line」「黒い垂直線 = barline / stem」の単純パターンで
 * staff / system / barline / cell 検出を検証する。
 */

import { describe, it, expect } from 'vitest';
import { extractPageLayout } from './pdfHideLayout';
import type { PdfHideImage } from './pdfHideImage';

// ============================================================
// テストヘルパー
// ============================================================

/** 全面白 (RGBA 255,255,255,255) の画像。 */
function makeWhiteImage(width: number, height: number): PdfHideImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
  return { data, width, height };
}

/** 1 pixel を黒に (in-place). */
function setBlack(img: PdfHideImage, x: number, y: number): void {
  if (x < 0 || x >= img.width || y < 0 || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = 0;
  img.data[i + 1] = 0;
  img.data[i + 2] = 0;
  img.data[i + 3] = 255;
}

/** `y` 行、`x0..x1` 列 (inclusive) を黒に (水平線). */
function drawHLine(img: PdfHideImage, y: number, x0: number, x1: number): void {
  for (let x = x0; x <= x1; x++) setBlack(img, x, y);
}

/** `x` 列、`y0..y1` 行 (inclusive) を黒に (垂直線). */
function drawVLine(img: PdfHideImage, x: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) setBlack(img, x, y);
}

/**
 * 1 staff band (5 線) を指定した y に描く.
 * `lineYs` の各 y で `[x0, x1]` 範囲に水平線を引く (staff line 1 px 厚).
 */
function drawStaff(
  img: PdfHideImage,
  lineYs: number[],
  x0: number,
  x1: number,
): void {
  for (const y of lineYs) drawHLine(img, y, x0, x1);
}

// ============================================================
// 基本: single staff, 3 barlines → 1 system, 1 staff, 2 cells
// ============================================================

describe('pdfHideLayout — single staff system', () => {
  it('1 staff + 3 barlines → 1 system, 1 staff, 2 cells', () => {
    // 100x40, staff lines at y=10,15,20,25,30 (spacing 5, full width)
    const img = makeWhiteImage(100, 40);
    const lineYs = [10, 15, 20, 25, 30];
    drawStaff(img, lineYs, 0, 99);
    // barlines at x=5, 50, 95, spanning the staff height
    drawVLine(img, 5, 10, 30);
    drawVLine(img, 50, 10, 30);
    drawVLine(img, 95, 10, 30);

    const [page] = extractPageLayout({
      pageImages: [img],
      context: { stavesPerSystem: 1 },
    });
    expect(page.warnings).toEqual([]);
    expect(page.systems).toHaveLength(1);

    const sys = page.systems[0];
    expect(sys.staves).toHaveLength(1);
    expect(sys.staves[0].lineYs).toEqual([10, 15, 20, 25, 30]);
    expect(sys.staves[0].lineSpacing).toBe(5);
    expect(sys.staves[0].topY).toBe(10);
    expect(sys.staves[0].bottomY).toBe(30);

    expect(sys.barlineXs).toHaveLength(3);
    expect(sys.barlineXs[0]).toBeCloseTo(5);
    expect(sys.barlineXs[1]).toBeCloseTo(50);
    expect(sys.barlineXs[2]).toBeCloseTo(95);

    // 2 cells (4 barlines - 1 = 3? No: 3 barlines - 1 = 2 measures)
    expect(sys.cells).toHaveLength(2);
    expect(sys.cells[0].measureIndex).toBe(0);
    expect(sys.cells[1].measureIndex).toBe(1);
    expect(sys.cells[0].staffIndex).toBe(0);
    expect(sys.cells[0].systemIndex).toBe(0);
    expect(sys.cells[0].pageIndex).toBe(0);
    // cell 0 は barline 0 と 1 の間 = (5,50), width ~ 44
    expect(sys.cells[0].x).toBeCloseTo(5.5);
    expect(sys.cells[0].width).toBeCloseTo(44);
    expect(sys.cells[0].y).toBe(10);
    expect(sys.cells[0].height).toBe(21);
  });
});

// ============================================================
// two-staff system
// ============================================================

describe('pdfHideLayout — two-staff system', () => {
  it('2 staves + 5 barlines → 1 system with 2 staves, 8 cells', () => {
    // 100x70, staff 1 y=10..30, staff 2 y=40..60
    const img = makeWhiteImage(100, 70);
    drawStaff(img, [10, 15, 20, 25, 30], 0, 99);
    drawStaff(img, [40, 45, 50, 55, 60], 0, 99);
    // barlines from y=10 to y=60 (spanning both staves including the gap)
    for (const x of [5, 30, 55, 80, 95]) drawVLine(img, x, 10, 60);

    const [page] = extractPageLayout({
      pageImages: [img],
      context: { stavesPerSystem: 2 },
    });
    expect(page.warnings).toEqual([]);
    expect(page.systems).toHaveLength(1);

    const sys = page.systems[0];
    expect(sys.staves).toHaveLength(2);
    expect(sys.staves[0].topY).toBe(10);
    expect(sys.staves[0].bottomY).toBe(30);
    expect(sys.staves[1].topY).toBe(40);
    expect(sys.staves[1].bottomY).toBe(60);

    expect(sys.barlineXs).toHaveLength(5);
    // 2 staves × 4 measures = 8 cells
    expect(sys.cells).toHaveLength(8);
    // staff 0 first
    expect(sys.cells[0].staffIndex).toBe(0);
    expect(sys.cells[3].staffIndex).toBe(0);
    expect(sys.cells[4].staffIndex).toBe(1);
    expect(sys.cells[7].staffIndex).toBe(1);
    // measures 0-3 in each staff
    expect(sys.cells.map((c) => c.measureIndex)).toEqual([
      0, 1, 2, 3, 0, 1, 2, 3,
    ]);
  });
});

// ============================================================
// stem 除外
// ============================================================

describe('pdfHideLayout — stem rejection', () => {
  it('single-staff: 90% coverage threshold rejects half-staff-height stem', () => {
    // staff y=10..30, 2 outer barlines, 1 stem at x=50 from y=15..25 (11 px < 21*0.9)
    const img = makeWhiteImage(100, 40);
    drawStaff(img, [10, 15, 20, 25, 30], 0, 99);
    drawVLine(img, 5, 10, 30);
    drawVLine(img, 95, 10, 30);
    drawVLine(img, 50, 15, 25); // stem

    const [page] = extractPageLayout({
      pageImages: [img],
      context: { stavesPerSystem: 1 },
    });
    expect(page.warnings).toEqual([]);
    const sys = page.systems[0];
    expect(sys.barlineXs).toHaveLength(2);
    expect(sys.cells).toHaveLength(1);
  });

  it('multi-staff: intersect rejects stem that only appears in one staff', () => {
    // staff 1 y=10..30, staff 2 y=40..60, barlines at x=5,95 spanning both,
    // stem at x=50 from y=5..35 だけ staff 1 を丸ごと貫く (staff 1 的には barline 候補、
    // でも staff 2 には影無し → intersect で除外)
    const img = makeWhiteImage(100, 70);
    drawStaff(img, [10, 15, 20, 25, 30], 0, 99);
    drawStaff(img, [40, 45, 50, 55, 60], 0, 99);
    drawVLine(img, 5, 10, 60);
    drawVLine(img, 95, 10, 60);
    drawVLine(img, 50, 5, 35); // staff 1 を丸ごと貫くが staff 2 には届かない

    const [page] = extractPageLayout({
      pageImages: [img],
      context: { stavesPerSystem: 2 },
    });
    // staff line 本数は 10 本でちょうど 2 staff → warning は無し
    expect(page.warnings).toEqual([]);
    const sys = page.systems[0];
    expect(sys.barlineXs).toHaveLength(2);
    expect(sys.cells).toHaveLength(2); // 2 staves × 1 measure
  });
});

// ============================================================
// 複数 system per page
// ============================================================

describe('pdfHideLayout — multiple systems per page', () => {
  it('2 independent systems with 1 staff each', () => {
    const img = makeWhiteImage(100, 100);
    drawStaff(img, [10, 15, 20, 25, 30], 0, 99);
    drawStaff(img, [60, 65, 70, 75, 80], 0, 99);
    // system 1 barlines
    drawVLine(img, 5, 10, 30);
    drawVLine(img, 95, 10, 30);
    // system 2 barlines
    drawVLine(img, 5, 60, 80);
    drawVLine(img, 95, 60, 80);

    const [page] = extractPageLayout({
      pageImages: [img],
      context: { stavesPerSystem: 1 },
    });
    expect(page.warnings).toEqual([]);
    expect(page.systems).toHaveLength(2);
    expect(page.systems[0].systemIndex).toBe(0);
    expect(page.systems[1].systemIndex).toBe(1);
    expect(page.systems[0].staves[0].topY).toBe(10);
    expect(page.systems[1].staves[0].topY).toBe(60);
    // 両 system とも 2 barline → 1 cell
    expect(page.systems[0].cells).toHaveLength(1);
    expect(page.systems[1].cells).toHaveLength(1);
  });
});

// ============================================================
// 警告 (warning) 系
// ============================================================

describe('pdfHideLayout — warnings', () => {
  it('blank image emits noStaffLinesDetected', () => {
    const img = makeWhiteImage(50, 50);
    const [page] = extractPageLayout({
      pageImages: [img],
      context: { stavesPerSystem: 1 },
    });
    expect(page.systems).toEqual([]);
    expect(page.warnings).toHaveLength(1);
    expect(page.warnings[0].kind).toBe('noStaffLinesDetected');
    expect(page.warnings[0].pageIndex).toBe(0);
  });

  it('zero-size image emits noStaffLinesDetected', () => {
    const img: PdfHideImage = {
      data: new Uint8ClampedArray(0),
      width: 0,
      height: 0,
    };
    const [page] = extractPageLayout({
      pageImages: [img],
      context: { stavesPerSystem: 1 },
    });
    expect(page.systems).toEqual([]);
    expect(page.warnings).toHaveLength(1);
    expect(page.warnings[0].kind).toBe('noStaffLinesDetected');
  });

  it('staff line count not multiple of 5 emits staffLineCountMismatch', () => {
    // 5 + 1 = 6 lines → 1 band + 1 余 → warning
    const img = makeWhiteImage(100, 80);
    drawStaff(img, [10, 15, 20, 25, 30], 0, 99);
    drawHLine(img, 60, 0, 99); // 6 本目の孤立 line
    // barline 1 本だけ (staff の range に) 置くが warning trigger に関係ない
    drawVLine(img, 50, 10, 30);

    const [page] = extractPageLayout({
      pageImages: [img],
      context: { stavesPerSystem: 1 },
    });
    const kinds = page.warnings.map((w) => w.kind);
    expect(kinds).toContain('staffLineCountMismatch');
    // band は 1 個だけ作られる
    expect(page.systems).toHaveLength(1);
    expect(page.systems[0].staves).toHaveLength(1);
  });

  it('staves not divisible by stavesPerSystem emits shortSystem', () => {
    // 3 staff bands, stavesPerSystem=2 → 1 full system + 1 short system
    const img = makeWhiteImage(100, 130);
    drawStaff(img, [10, 15, 20, 25, 30], 0, 99);
    drawStaff(img, [40, 45, 50, 55, 60], 0, 99);
    drawStaff(img, [80, 85, 90, 95, 100], 0, 99);
    // 端 barline だけ
    drawVLine(img, 5, 10, 60);
    drawVLine(img, 95, 10, 60);
    drawVLine(img, 5, 80, 100);
    drawVLine(img, 95, 80, 100);

    const [page] = extractPageLayout({
      pageImages: [img],
      context: { stavesPerSystem: 2 },
    });
    const kinds = page.warnings.map((w) => w.kind);
    expect(kinds).toContain('shortSystem');
    expect(page.systems).toHaveLength(2);
    expect(page.systems[0].staves).toHaveLength(2);
    expect(page.systems[1].staves).toHaveLength(1);
  });

  it('staff without barlines emits noBarlinesDetected', () => {
    const img = makeWhiteImage(100, 40);
    drawStaff(img, [10, 15, 20, 25, 30], 0, 99);
    // barline 無し

    const [page] = extractPageLayout({
      pageImages: [img],
      context: { stavesPerSystem: 1 },
    });
    const kinds = page.warnings.map((w) => w.kind);
    expect(kinds).toContain('noBarlinesDetected');
    expect(page.systems[0].cells).toHaveLength(0);
  });

  it('staff with single barline emits tooFewBarlines', () => {
    const img = makeWhiteImage(100, 40);
    drawStaff(img, [10, 15, 20, 25, 30], 0, 99);
    drawVLine(img, 50, 10, 30);

    const [page] = extractPageLayout({
      pageImages: [img],
      context: { stavesPerSystem: 1 },
    });
    const kinds = page.warnings.map((w) => w.kind);
    expect(kinds).toContain('tooFewBarlines');
    expect(page.systems[0].cells).toHaveLength(0);
  });
});

// ============================================================
// 複数ページ入力
// ============================================================

describe('pdfHideLayout — multi-page input', () => {
  it('processes each page independently with correct pageIndex', () => {
    const img1 = makeWhiteImage(100, 40);
    drawStaff(img1, [10, 15, 20, 25, 30], 0, 99);
    drawVLine(img1, 5, 10, 30);
    drawVLine(img1, 95, 10, 30);

    const img2 = makeWhiteImage(100, 40);
    drawStaff(img2, [10, 15, 20, 25, 30], 0, 99);
    drawVLine(img2, 5, 10, 30);
    drawVLine(img2, 50, 10, 30);
    drawVLine(img2, 95, 10, 30);

    const pages = extractPageLayout({
      pageImages: [img1, img2],
      context: { stavesPerSystem: 1 },
    });
    expect(pages).toHaveLength(2);
    expect(pages[0].pageIndex).toBe(0);
    expect(pages[1].pageIndex).toBe(1);
    expect(pages[0].systems[0].cells).toHaveLength(1);
    expect(pages[1].systems[0].cells).toHaveLength(2);
    // cell の pageIndex は各 page 内で正しく立つ
    expect(pages[0].systems[0].cells[0].pageIndex).toBe(0);
    expect(pages[1].systems[0].cells[0].pageIndex).toBe(1);
  });
});

// ============================================================
// cell 座標の正しさ
// ============================================================

describe('pdfHideLayout — cell box coordinates', () => {
  it('cell x/width excludes the enclosing barlines', () => {
    const img = makeWhiteImage(100, 40);
    drawStaff(img, [10, 15, 20, 25, 30], 0, 99);
    drawVLine(img, 10, 10, 30);
    drawVLine(img, 90, 10, 30);

    const [page] = extractPageLayout({
      pageImages: [img],
      context: { stavesPerSystem: 1 },
    });
    const cell = page.systems[0].cells[0];
    // barline x = 10 と 90、cell x = 10.5、width = 90-10-1 = 79
    expect(cell.x).toBeCloseTo(10.5);
    expect(cell.width).toBeCloseTo(79);
    expect(cell.y).toBe(10);
    expect(cell.height).toBe(21);
  });
});
