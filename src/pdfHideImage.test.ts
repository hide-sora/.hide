/**
 * pdfHideImage.test.ts — pdfHideImage.ts の数値動作テスト
 *
 * 全 test fixture はコード内合成 (PNG ファイル不要)。
 * synthetic RGBA 画像を `Uint8ClampedArray` で直接組み立てる。
 */

import { describe, it, expect } from 'vitest';
import {
  toGrayscale,
  binarize,
  horizontalProjection,
  verticalProjectionBand,
  cropImage,
  connectedComponents,
} from './pdfHideImage';
import type { PdfHideImage } from './pdfHideImage';

// ============================================================
// テストヘルパー: synthetic image builders
// ============================================================

/** 全面白 (RGBA = 255,255,255,255) の画像を作る。 */
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

/** 1 pixel を黒にする (in-place、alpha は 255)。 */
function setBlack(img: PdfHideImage, x: number, y: number): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = 0;
  img.data[i + 1] = 0;
  img.data[i + 2] = 0;
  img.data[i + 3] = 255;
}

/** 矩形 (w × h、左上 = (x,y)) を黒で塗りつぶす (in-place)。 */
function fillBlackRect(
  img: PdfHideImage,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      setBlack(img, xx, yy);
    }
  }
}

/** bin 配列中の 1 の数を数える (projection/CC の sanity check 用)。 */
function countOnes(bin: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < bin.length; i++) if (bin[i] === 1) n++;
  return n;
}

// ============================================================
// toGrayscale
// ============================================================

describe('pdfHideImage — toGrayscale', () => {
  it('pure white → 255, pure black → 0', () => {
    const img = makeWhiteImage(2, 2);
    setBlack(img, 0, 0);
    setBlack(img, 1, 1);
    const gray = toGrayscale(img);
    expect(gray).toHaveLength(4);
    expect(gray[0]).toBe(0); // (0,0) black
    expect(gray[1]).toBe(255); // (1,0) white
    expect(gray[2]).toBe(255); // (0,1) white
    expect(gray[3]).toBe(0); // (1,1) black
  });

  it('BT.601 weighting: green is brighter than red which is brighter than blue', () => {
    // 3x1 画像: 赤・緑・青
    const img = makeWhiteImage(3, 1);
    // 赤 (255, 0, 0)
    img.data[0] = 255;
    img.data[1] = 0;
    img.data[2] = 0;
    // 緑 (0, 255, 0)
    img.data[4] = 0;
    img.data[5] = 255;
    img.data[6] = 0;
    // 青 (0, 0, 255)
    img.data[8] = 0;
    img.data[9] = 0;
    img.data[10] = 255;

    const gray = toGrayscale(img);
    // 0.587 * 255 ≈ 150 (緑) > 0.299 * 255 ≈ 76 (赤) > 0.114 * 255 ≈ 29 (青)
    expect(gray[1]).toBeGreaterThan(gray[0]);
    expect(gray[0]).toBeGreaterThan(gray[2]);
  });

  it('alpha 0 pixel is treated as white (255)', () => {
    const img = makeWhiteImage(1, 1);
    img.data[0] = 0; // 本来は黒
    img.data[1] = 0;
    img.data[2] = 0;
    img.data[3] = 0; // alpha 0
    const gray = toGrayscale(img);
    expect(gray[0]).toBe(255);
  });
});

// ============================================================
// binarize
// ============================================================

describe('pdfHideImage — binarize (Otsu)', () => {
  it('pure black pixels become 1, pure white pixels become 0', () => {
    const gray = new Uint8Array([0, 255, 0, 255, 0, 255]);
    const bin = binarize(gray, 6, 1);
    expect(Array.from(bin)).toEqual([1, 0, 1, 0, 1, 0]);
  });

  it('bimodal image with midgray separates cleanly', () => {
    // 20 pixel: 10 個 30 (暗)、10 個 220 (明)
    const gray = new Uint8Array(20);
    for (let i = 0; i < 10; i++) gray[i] = 30;
    for (let i = 10; i < 20; i++) gray[i] = 220;
    const bin = binarize(gray, 20, 1);
    expect(countOnes(bin)).toBe(10);
    for (let i = 0; i < 10; i++) expect(bin[i]).toBe(1);
    for (let i = 10; i < 20; i++) expect(bin[i]).toBe(0);
  });

  it('empty image returns empty array', () => {
    const bin = binarize(new Uint8Array(0), 0, 0);
    expect(bin).toHaveLength(0);
  });
});

// ============================================================
// horizontalProjection
// ============================================================

describe('pdfHideImage — horizontalProjection', () => {
  it('counts foreground pixels per row', () => {
    // 4x3 の bin:
    //   row 0: 0 0 0 0 → 0
    //   row 1: 1 1 1 0 → 3
    //   row 2: 0 1 0 1 → 2
    const bin = new Uint8Array([
      0, 0, 0, 0,
      1, 1, 1, 0,
      0, 1, 0, 1,
    ]);
    const proj = horizontalProjection(bin, 4, 3);
    expect(Array.from(proj)).toEqual([0, 3, 2]);
  });

  it('empty image returns empty projection', () => {
    const proj = horizontalProjection(new Uint8Array(0), 0, 0);
    expect(proj).toHaveLength(0);
  });
});

// ============================================================
// verticalProjectionBand
// ============================================================

describe('pdfHideImage — verticalProjectionBand', () => {
  it('counts foreground pixels per column within [y0, y1)', () => {
    // 4x4 の bin:
    //   row 0: 0 0 0 0
    //   row 1: 1 0 1 0
    //   row 2: 1 1 1 0
    //   row 3: 0 0 0 0
    // band y0=1, y1=3 → 列 sum = [2, 1, 2, 0]
    const bin = new Uint8Array([
      0, 0, 0, 0,
      1, 0, 1, 0,
      1, 1, 1, 0,
      0, 0, 0, 0,
    ]);
    const proj = verticalProjectionBand(bin, 4, 4, 1, 3);
    expect(Array.from(proj)).toEqual([2, 1, 2, 0]);
  });

  it('clips out-of-range y0 / y1 to image bounds', () => {
    const bin = new Uint8Array([1, 1, 1, 1]);
    const proj = verticalProjectionBand(bin, 2, 2, -5, 100);
    // 両列とも 2 行全部 1 なので sum = 2
    expect(Array.from(proj)).toEqual([2, 2]);
  });

  it('returns zeros when y0 >= y1', () => {
    const bin = new Uint8Array([1, 1, 1, 1]);
    const proj = verticalProjectionBand(bin, 2, 2, 1, 1);
    expect(Array.from(proj)).toEqual([0, 0]);
  });
});

// ============================================================
// cropImage
// ============================================================

describe('pdfHideImage — cropImage', () => {
  it('extracts a sub-rectangle independently from the source', () => {
    const img = makeWhiteImage(4, 4);
    // 内側 2x2 (x=1..2, y=1..2) を黒に
    fillBlackRect(img, 1, 1, 2, 2);

    const crop = cropImage(img, { x: 1, y: 1, width: 2, height: 2 });
    expect(crop.width).toBe(2);
    expect(crop.height).toBe(2);
    // 全 pixel が黒 (alpha 255)
    for (let i = 0; i < crop.data.length; i += 4) {
      expect(crop.data[i]).toBe(0);
      expect(crop.data[i + 1]).toBe(0);
      expect(crop.data[i + 2]).toBe(0);
      expect(crop.data[i + 3]).toBe(255);
    }
    // source を変更しても crop は独立
    img.data[0] = 42;
    expect(crop.data[0]).toBe(0);
  });

  it('clips box to image bounds', () => {
    const img = makeWhiteImage(3, 3);
    const crop = cropImage(img, { x: -1, y: -1, width: 5, height: 5 });
    expect(crop.width).toBe(3);
    expect(crop.height).toBe(3);
  });

  it('returns 0x0 image when box has no overlap', () => {
    const img = makeWhiteImage(3, 3);
    const crop = cropImage(img, { x: 10, y: 10, width: 2, height: 2 });
    expect(crop.width).toBe(0);
    expect(crop.height).toBe(0);
    expect(crop.data).toHaveLength(0);
  });
});

// ============================================================
// connectedComponents
// ============================================================

describe('pdfHideImage — connectedComponents', () => {
  it('finds a single 2x2 blob with correct bbox, area, and centroid', () => {
    // 5x5, (1,1)..(2,2) を前景に
    const bin = new Uint8Array(25);
    bin[1 * 5 + 1] = 1;
    bin[1 * 5 + 2] = 1;
    bin[2 * 5 + 1] = 1;
    bin[2 * 5 + 2] = 1;
    const comps = connectedComponents(bin, 5, 5);
    expect(comps).toHaveLength(1);
    expect(comps[0].minX).toBe(1);
    expect(comps[0].minY).toBe(1);
    expect(comps[0].maxX).toBe(2);
    expect(comps[0].maxY).toBe(2);
    expect(comps[0].area).toBe(4);
    expect(comps[0].centroidX).toBeCloseTo(1.5);
    expect(comps[0].centroidY).toBeCloseTo(1.5);
  });

  it('distinguishes two separate blobs', () => {
    // 7x3:
    //   (0,0)(1,0) と (4,1)(5,1)(6,1) が別 blob
    const bin = new Uint8Array(21);
    bin[0] = 1;
    bin[1] = 1;
    bin[1 * 7 + 4] = 1;
    bin[1 * 7 + 5] = 1;
    bin[1 * 7 + 6] = 1;
    const comps = connectedComponents(bin, 7, 3);
    expect(comps).toHaveLength(2);
    // 順序は BFS seed 順 = row-major 走査なので、最初に (0,0) 発 blob
    expect(comps[0].area).toBe(2);
    expect(comps[0].minX).toBe(0);
    expect(comps[0].maxX).toBe(1);
    expect(comps[0].minY).toBe(0);
    expect(comps[0].maxY).toBe(0);

    expect(comps[1].area).toBe(3);
    expect(comps[1].minX).toBe(4);
    expect(comps[1].maxX).toBe(6);
    expect(comps[1].minY).toBe(1);
    expect(comps[1].maxY).toBe(1);
    expect(comps[1].centroidX).toBeCloseTo(5);
    expect(comps[1].centroidY).toBeCloseTo(1);
  });

  it('4-connectivity: diagonally touching pixels are NOT merged', () => {
    // 3x3:
    //   1 0 0
    //   0 1 0
    //   0 0 1
    // 4 近傍では 3 個の独立成分、8 近傍なら 1 個
    const bin = new Uint8Array([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]);
    const comps = connectedComponents(bin, 3, 3);
    expect(comps).toHaveLength(3);
    expect(comps.every((c) => c.area === 1)).toBe(true);
  });

  it('handles blob that touches image border', () => {
    // 3x3 の右下 2x2 blob (border に接する)
    const bin = new Uint8Array([
      0, 0, 0,
      0, 1, 1,
      0, 1, 1,
    ]);
    const comps = connectedComponents(bin, 3, 3);
    expect(comps).toHaveLength(1);
    expect(comps[0].area).toBe(4);
    expect(comps[0].minX).toBe(1);
    expect(comps[0].maxX).toBe(2);
    expect(comps[0].minY).toBe(1);
    expect(comps[0].maxY).toBe(2);
  });

  it('empty image returns empty array', () => {
    expect(connectedComponents(new Uint8Array(0), 0, 0)).toEqual([]);
  });

  it('all-background image returns empty array', () => {
    const bin = new Uint8Array(9); // all zeros
    expect(connectedComponents(bin, 3, 3)).toEqual([]);
  });
});

// ============================================================
// 統合: grayscale → binarize → projection → CC が一貫して動く
// ============================================================

describe('pdfHideImage — integrated pipeline', () => {
  it('finds a single staff-line-like horizontal bar', () => {
    // 10x5 白画像の中央行 (y=2) を黒 1 行に
    const img = makeWhiteImage(10, 5);
    fillBlackRect(img, 0, 2, 10, 1);

    const gray = toGrayscale(img);
    const bin = binarize(gray, 10, 5);
    // y=2 のみ全 10 前景
    const h = horizontalProjection(bin, 10, 5);
    expect(Array.from(h)).toEqual([0, 0, 10, 0, 0]);

    // CC は 1 個、area = 10
    const comps = connectedComponents(bin, 10, 5);
    expect(comps).toHaveLength(1);
    expect(comps[0].area).toBe(10);
    expect(comps[0].minY).toBe(2);
    expect(comps[0].maxY).toBe(2);
  });

  it('finds a vertical barline via verticalProjectionBand', () => {
    // 5x10 白画像の x=2 を上から下まで黒
    const img = makeWhiteImage(5, 10);
    fillBlackRect(img, 2, 0, 1, 10);

    const gray = toGrayscale(img);
    const bin = binarize(gray, 5, 10);
    const v = verticalProjectionBand(bin, 5, 10, 0, 10);
    // 列 2 だけ全 10
    expect(v[0]).toBe(0);
    expect(v[1]).toBe(0);
    expect(v[2]).toBe(10);
    expect(v[3]).toBe(0);
    expect(v[4]).toBe(0);
  });
});
