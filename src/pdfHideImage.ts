/**
 * pdfHideImage.ts — PDF→.hide pipeline の画像プリミティブ層
 *
 * DOM の `ImageData` と構造的に互換な `PdfHideImage` 型と、そこに対する
 * pure TS の基本画像処理関数群を提供する。依存なし、browser / Node どちらでも動く。
 *
 * Phase 2 (古典 OMR) 以降の全モジュール (`pdfHideLayout.ts` / `pdfHideNotehead.ts` 等)
 * がここから import する。
 *
 * 設計:
 *  - `PdfHideImage` は DOM `ImageData` の構造的サブセット (`data` / `width` / `height` のみ)
 *    → consumer は `HTMLCanvasElement.getContext('2d').getImageData()` の結果を
 *    そのまま渡せる。PDF→画像化は consumer 責務 (pdfjs-dist / canvas 依存を持たない)。
 *  - binary image は `Uint8Array` で 0 = 背景 (白)、1 = 前景 (黒インク)
 *  - grayscale は `Uint8Array`、0 = 黒、255 = 白 (= 反転していない、人間の感覚通り)
 *  - projection は `Uint32Array` (行/列ごとの前景 pixel 数)
 *  - `connectedComponents` は 4 近傍 BFS
 */

// ============================================================
// 型
// ============================================================

/**
 * DOM `ImageData` と構造的に互換な RGBA 画像型。
 * consumer は `HTMLCanvasElement.getContext('2d').getImageData()` の結果を
 * そのまま渡せる。`data` は row-major、`[R,G,B,A, R,G,B,A, ...]` の並び。
 */
export interface PdfHideImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * 軸揃え矩形領域 (pixel 単位、`cropImage` に渡す)。
 * `(x, y)` が左上、`(x+width, y+height)` が右下 (exclusive)。
 */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * `connectedComponents` の 1 成分。bbox は inclusive、centroid は構成 pixel の座標平均。
 */
export interface Component {
  /** 構成 pixel の x 最小値 (inclusive) */
  minX: number;
  /** 構成 pixel の y 最小値 (inclusive) */
  minY: number;
  /** 構成 pixel の x 最大値 (inclusive) */
  maxX: number;
  /** 構成 pixel の y 最大値 (inclusive) */
  maxY: number;
  /** 構成 pixel 総数 */
  area: number;
  /** 重心 x (浮動小数、構成 pixel の x 座標平均) */
  centroidX: number;
  /** 重心 y (浮動小数、構成 pixel の y 座標平均) */
  centroidY: number;
}

// ============================================================
// grayscale
// ============================================================

/**
 * RGBA 画像を grayscale 化する。
 * 人間の視覚感度に合わせた ITU-R BT.601 weight を使用
 * (`Y = 0.299*R + 0.587*G + 0.114*B`、整数演算で `(77*R + 150*G + 29*B) >> 8`)。
 * 返り値は `Uint8Array`、size = `width * height`、`0` = 黒、`255` = 白。
 *
 * `alpha === 0` の pixel は「背景」扱いで `255` (白) に吸い寄せる。
 * engraved PDF では通常 alpha が 255 だが、透過ページに備えた保険。
 */
export function toGrayscale(image: PdfHideImage): Uint8Array {
  const { data, width, height } = image;
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    const a = data[i + 3];
    if (a === 0) {
      out[j] = 255;
      continue;
    }
    // (77 + 150 + 29) === 256 なので >>8 が正しい除算になる
    out[j] = (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2]) >> 8;
  }
  return out;
}

// ============================================================
// binarize (Otsu 法)
// ============================================================

/**
 * Otsu 法で grayscale 画像を 2 値化する。
 * 返り値は `Uint8Array`、size = `width * height`、
 * `0` = 背景 (白側)、`1` = 前景 (黒インク側)。
 *
 * `gray` 側の convention と反転している点に注意:
 * grayscale 255 (白) → bin 0、grayscale 0 (黒) → bin 1。
 * Otsu 閾値 `t` 未満 (= 暗い) を前景とする。
 *
 * アルゴリズム:
 *  1. 256 bin のヒストグラムを作る
 *  2. 各 threshold `t` で class 間分散 = `wB * wF * (mB - mF)^2` を計算
 *  3. 最大値を取る `t` を採用
 *
 * `gray[i] <= threshold` を前景とする (`<` だと「全黒+全白」のような
 * 極端な bimodal で Otsu が `t = 0` を選んだ瞬間に黒 pixel も境界条件で
 * 落ちてしまうため、等号を含めるほうが直感と一致する)。
 *
 * 均質画像 (ヒストグラムが 1 峰) では threshold = 128 に fallback する。
 */
export function binarize(
  gray: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const total = width * height;
  if (total === 0) return new Uint8Array(0);

  // ヒストグラム
  const hist = new Uint32Array(256);
  for (let i = 0; i < total; i++) hist[gray[i]]++;

  // Otsu の class 間分散を最大化
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const diff = mB - mF;
    const varBetween = wB * wF * diff * diff;
    if (varBetween > maxVar) {
      maxVar = varBetween;
      threshold = t;
    }
  }

  // gray <= threshold → 前景 (黒インク側)
  const out = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    out[i] = gray[i] <= threshold ? 1 : 0;
  }
  return out;
}

// ============================================================
// projection histograms
// ============================================================

/**
 * 水平 projection: 各 y について前景 pixel の個数を数える。
 * staff line 検出 (5 本横縞の peak) に使う。
 * 返り値 length = `height`。
 */
export function horizontalProjection(
  bin: Uint8Array,
  width: number,
  height: number,
): Uint32Array {
  const out = new Uint32Array(height);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      sum += bin[rowStart + x];
    }
    out[y] = sum;
  }
  return out;
}

/**
 * 垂直 projection (band limited): 各 x について `y0 ≤ y < y1` の範囲で
 * 前景 pixel の個数を数える。staff band 内の barline 検出等に使う。
 * 返り値 length = `width`。
 *
 * `y0`, `y1` は画像境界にクリップされる。`y0 >= y1` のときは全 0 の配列を返す。
 */
export function verticalProjectionBand(
  bin: Uint8Array,
  width: number,
  height: number,
  y0: number,
  y1: number,
): Uint32Array {
  const lo = Math.max(0, Math.floor(y0));
  const hi = Math.min(height, Math.ceil(y1));
  const out = new Uint32Array(width);
  if (hi <= lo) return out;
  for (let y = lo; y < hi; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      out[x] += bin[rowStart + x];
    }
  }
  return out;
}

// ============================================================
// crop
// ============================================================

/**
 * RGBA 画像を軸揃え矩形で切り出す。
 * `box` は画像境界にクリップされる。box がまったく画像と重ならない場合は
 * 0×0 の空 `PdfHideImage` を返す。
 *
 * 返り値は新しい `PdfHideImage` で所有権独立 (`data` は新規 `Uint8ClampedArray`)。
 * cell ごとの部分画像取り出し (Phase 2b notehead detection 前段) に使う。
 */
export function cropImage(image: PdfHideImage, box: Box): PdfHideImage {
  const { data: srcData, width: srcW, height: srcH } = image;
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(srcW, Math.floor(box.x + box.width));
  const y1 = Math.min(srcH, Math.floor(box.y + box.height));
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcRowStart = ((y0 + y) * srcW + x0) * 4;
    const dstRowStart = y * w * 4;
    // 1 行分を一括コピー (set でサブ array をコピー)
    out.set(srcData.subarray(srcRowStart, srcRowStart + w * 4), dstRowStart);
  }
  return { data: out, width: w, height: h };
}

// ============================================================
// connected components (4-connectivity, BFS)
// ============================================================

/**
 * 4 近傍 connected components 抽出。
 * 入力は `binarize` の出力 (0/1 の `Uint8Array`)。
 * 前景 (`1`) pixel を BFS で塊に分け、各塊を `Component` として返す。
 *
 * notehead / accidental / stem 等の幾何的候補抽出に使う (Phase 2b の前段)。
 *
 * 計算量: `O(N)`、`N = width * height`
 * メモリ: `visited` Uint8Array × N + BFS queue (最大で画像全体)
 */
export function connectedComponents(
  bin: Uint8Array,
  width: number,
  height: number,
): Component[] {
  const total = width * height;
  if (total === 0) return [];

  const visited = new Uint8Array(total);
  const result: Component[] = [];

  // BFS queue (全成分で再利用可能、サイズは最大 N)。pixel index を直接格納。
  const queue = new Int32Array(total);

  for (let seed = 0; seed < total; seed++) {
    if (bin[seed] === 0 || visited[seed] === 1) continue;

    // 新しい成分開始
    visited[seed] = 1;
    let qHead = 0;
    let qTail = 0;
    queue[qTail++] = seed;

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let area = 0;
    let sumX = 0;
    let sumY = 0;

    while (qHead < qTail) {
      const idx = queue[qHead++];
      const x = idx % width;
      const y = (idx - x) / width;

      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      area++;
      sumX += x;
      sumY += y;

      // 4 近傍 (左右上下)
      if (x > 0) {
        const n = idx - 1;
        if (bin[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          queue[qTail++] = n;
        }
      }
      if (x < width - 1) {
        const n = idx + 1;
        if (bin[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          queue[qTail++] = n;
        }
      }
      if (y > 0) {
        const n = idx - width;
        if (bin[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          queue[qTail++] = n;
        }
      }
      if (y < height - 1) {
        const n = idx + width;
        if (bin[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          queue[qTail++] = n;
        }
      }
    }

    result.push({
      minX,
      minY,
      maxX,
      maxY,
      area,
      centroidX: sumX / area,
      centroidY: sumY / area,
    });
  }

  return result;
}
