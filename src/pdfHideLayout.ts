/**
 * pdfHideLayout.ts — PDF→.hide pipeline Phase 2a: staff line + barline + cell box 検出
 *
 * 古典 OMR の構造層。Phase 1 (`pdfHideMeta.ts`) が全曲構造を LLM で読んでいる前提で、
 * 各ページから「どこに staff (5 線譜) が並んでいて、どこに barline が立っていて、
 * どの矩形が 1 cell (1 staff × 1 measure) か」を幾何的に決定する。
 *
 * 設計:
 *  - 依存: `pdfHideImage.ts` のみ (pure TS、zero deps)
 *  - engraved PDF (Finale / Sibelius / Dorico / MuseScore 等) を前提に hard-code 値を選ぶ
 *    deskew / denoise はしない。skew 済み入力は受理しない
 *  - 不整合は `LayoutWarning` として `PageLayout.warnings` に積む。silent fill 禁止
 *  - 最小アルゴリズム:
 *    1. binarize → horizontal projection で staff line 行を peak として抽出
 *    2. 連続行をクラスタ化して staff line 本数を確定 (1 peak = 1 line)
 *    3. 5 本ずつ順に束ねて StaffBand を作る
 *    4. `context.stavesPerSystem` ごとに top→bottom で StaffBand を束ねて SystemLayout
 *    5. 各 system 内で、staff ごとに vertical projection を取り 90% 以上黒の column を
 *       barline candidate とする (stem 除外: stem は staff 高の 90% を超えない)
 *    6. 全 staff で candidate だった column だけ「真の barline」として intersect
 *    7. 隣接 column を centroid に畳んで `barlineXs` とする
 *    8. barline ペアごとに `CellBox` を生成
 */

import {
  toGrayscale,
  binarize,
  horizontalProjection,
  verticalProjectionBand,
} from './pdfHideImage';
import type { PdfHideImage } from './pdfHideImage';

// ============================================================
// 型
// ============================================================

/**
 * 1 staff band = 5 線譜 1 組。`lineYs` は上から順に 5 本の y 座標 (浮動小数)。
 * `lineSpacing` は隣接 line の median 間隔 (pixel)。
 */
export interface StaffBand {
  /** 最上線 y (= lineYs[0]、inclusive、浮動小数) */
  topY: number;
  /** 最下線 y (= lineYs[4]、inclusive) */
  bottomY: number;
  /** 5 本の staff line の y 座標、上→下 (length === 5) */
  lineYs: number[];
  /** 隣接 line の median 間隔 (pixel) */
  lineSpacing: number;
}

/**
 * 1 system = 1 段の譜表グループ。`stavesPerSystem` 本の staff から成る。
 * `barlineXs` は system 全体を貫く barline の x 座標 (左→右、system 開始・終了線を含む)。
 * `cells` は staff × measure の全組合せで (top→bottom, left→right 順)。
 */
export interface SystemLayout {
  /** page 内 system index (0-based, 上から下) */
  systemIndex: number;
  /** system 上端 y (= 最上 staff の topY) */
  topY: number;
  /** system 下端 y (= 最下 staff の bottomY) */
  bottomY: number;
  /** system 内の staff band (length === stavesPerSystem、上→下) */
  staves: StaffBand[];
  /** 検出された barline の x 座標 (左→右、浮動小数). 長さ ≥ 2 で measure 数 = length - 1 */
  barlineXs: number[];
  /** 全 cell (staff × measure). 先頭から staffIndex 0 の measure 0..N-1 → staffIndex 1 の 0..N-1 ... 順 */
  cells: CellBox[];
}

/**
 * 1 cell = 1 staff × 1 measure の bounding box。座標は元 page image の pixel 空間。
 * width / height は exclusive 右下までの幅・高さ。
 *
 * この box は staff line 範囲のみ (topY..bottomY) を収める。Phase 2b の notehead 検出では
 * ledger line 上下に広げるため、consumer 側で `lineSpacing` 倍して padding する想定。
 */
export interface CellBox {
  /** page index (0-based) */
  pageIndex: number;
  /** page 内 system index (0-based) */
  systemIndex: number;
  /** system 内 staff index (0-based、上から下) */
  staffIndex: number;
  /** system 内 measure index (0-based、左から右) */
  measureIndex: number;
  /** 左上 x (inclusive、浮動小数) */
  x: number;
  /** 左上 y (inclusive) */
  y: number;
  /** 幅 (`x + width` = 右端 exclusive) */
  width: number;
  /** 高さ (`y + height` = 下端 exclusive) */
  height: number;
}

/**
 * Layout 検出で発生した不整合警告。`noStaffLinesDetected` / `noBarlinesDetected` 等の
 * 致命度の異なる warning を 1 つの discriminated union で扱う。
 *
 * silent fill 禁止原則に則り、consumer はこれを PdfHideDiagnostic に昇格して最終的に
 * hide studio の human-in-the-loop に渡す。
 */
export interface LayoutWarning {
  pageIndex: number;
  kind:
    | 'noStaffLinesDetected'
    | 'staffLineCountMismatch'
    | 'irregularLineSpacing'
    | 'shortSystem'
    | 'noBarlinesDetected'
    | 'tooFewBarlines';
  detail: string;
}

/**
 * 1 page の layout extraction 結果。
 */
export interface PageLayout {
  /** page index (0-based) */
  pageIndex: number;
  /** page 幅 (pixel) */
  width: number;
  /** page 高さ (pixel) */
  height: number;
  /** 検出された system (上→下) */
  systems: SystemLayout[];
  /** このページの layout warning */
  warnings: LayoutWarning[];
}

/**
 * `extractPageLayout` の入力。`context` は Phase 1 `PdfHideScoreContext` を structural に
 * subset して、Iteration 2 時点で必須な field だけ (`stavesPerSystem`) を要求する。
 */
export interface ExtractLayoutInput {
  /** ページ画像配列 (index === pageIndex) */
  pageImages: PdfHideImage[];
  /**
   * Phase 1 の score context の structural subset.
   * 実用上は `PdfHideScoreContext` を丸ごと渡して OK (余剰 field は無視される)。
   */
  context: {
    /** 1 system あたりの staff 数 (例: 声楽 4 パート + ピアノ大譜表 → 6) */
    stavesPerSystem: number;
  };
  /** チューニング knob (optional、省略時 engraved 用 default) */
  options?: PdfHideLayoutOptions;
}

/**
 * Layout 検出のチューニング knob. 通常は default で良い (engraved 用 hard-code 値).
 */
export interface PdfHideLayoutOptions {
  /**
   * Staff line peak 判定の閾値 (画像幅に対する割合). default 0.5.
   * `horizontalProjection[y] >= width * staffLinePeakRatio` となる行を staff line 候補とする.
   */
  staffLinePeakRatio?: number;
  /**
   * Barline candidate 判定の閾値 (staff 高に対する割合). default 0.9.
   * staff 高の 90% 以上黒 column を barline 候補とする (stem は通常 ~70% までなので除外される).
   */
  barlineCoverageRatio?: number;
}

// ============================================================
// 主エントリ
// ============================================================

/**
 * 全ページから layout (staff bands + barlines + cells) を抽出する。
 *
 * 入力は `PdfHideImage[]` と Phase 1 の score context (の subset)。
 * 各ページ処理は独立なので順次実行するだけ (並列化したければ consumer 側で Promise.all)。
 *
 * 例外は投げない。検出不能・不整合は `PageLayout.warnings` に積む。
 */
export function extractPageLayout(input: ExtractLayoutInput): PageLayout[] {
  const { pageImages, context, options = {} } = input;
  const opts: Required<PdfHideLayoutOptions> = {
    staffLinePeakRatio: options.staffLinePeakRatio ?? 0.5,
    barlineCoverageRatio: options.barlineCoverageRatio ?? 0.9,
  };
  return pageImages.map((img, pageIndex) =>
    extractPageLayoutSingle(img, pageIndex, context.stavesPerSystem, opts),
  );
}

// ============================================================
// 単一ページ処理
// ============================================================

function extractPageLayoutSingle(
  image: PdfHideImage,
  pageIndex: number,
  stavesPerSystem: number,
  opts: Required<PdfHideLayoutOptions>,
): PageLayout {
  const { width, height } = image;
  const warnings: LayoutWarning[] = [];

  if (width === 0 || height === 0) {
    warnings.push({
      pageIndex,
      kind: 'noStaffLinesDetected',
      detail: `空の画像 (width=${width}, height=${height})`,
    });
    return { pageIndex, width, height, systems: [], warnings };
  }

  // 1. binarize
  const gray = toGrayscale(image);
  const bin = binarize(gray, width, height);

  // 2. horizontal projection → staff line y list
  const hproj = horizontalProjection(bin, width, height);
  const staffLineYs = findStaffLineYs(hproj, width, opts.staffLinePeakRatio);

  if (staffLineYs.length === 0) {
    warnings.push({
      pageIndex,
      kind: 'noStaffLinesDetected',
      detail: 'horizontal projection に閾値超えのピークが無い',
    });
    return { pageIndex, width, height, systems: [], warnings };
  }

  // 3. 5 本ずつ staff band にまとめる
  const staffBands = groupIntoStaffBands(staffLineYs, pageIndex, warnings);
  if (staffBands.length === 0) {
    return { pageIndex, width, height, systems: [], warnings };
  }

  // 4. staff band → system grouping (stavesPerSystem 本ずつ、top→bottom)
  const systems = groupIntoSystems(staffBands, stavesPerSystem, pageIndex, warnings);

  // 5. 各 system で barline 検出 + cell 構築
  for (const sys of systems) {
    detectBarlinesForSystem(bin, width, height, sys, pageIndex, opts, warnings);
    buildCellsForSystem(sys, pageIndex);
  }

  return { pageIndex, width, height, systems, warnings };
}

// ============================================================
// staff line 検出
// ============================================================

/**
 * 水平 projection から staff line の y 座標を抽出する。
 * 閾値超えの連続行 (line は 1-2 px 厚) をクラスタ化し、centroid を 1 本として返す。
 */
function findStaffLineYs(
  hproj: Uint32Array,
  width: number,
  ratio: number,
): number[] {
  const threshold = width * ratio;
  const ys: number[] = [];
  let runStart = -1;
  for (let y = 0; y < hproj.length; y++) {
    const bright = hproj[y] >= threshold;
    if (bright) {
      if (runStart < 0) runStart = y;
    } else if (runStart >= 0) {
      // run [runStart, y-1] の centroid
      ys.push((runStart + (y - 1)) / 2);
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    ys.push((runStart + (hproj.length - 1)) / 2);
  }
  return ys;
}

// ============================================================
// 5 本ずつ staff band 化
// ============================================================

/**
 * sorted staff line y 配列を先頭から 5 本ずつ束ねて StaffBand[] を返す。
 * 5 本単位に割り切れない端数が出たら `staffLineCountMismatch` warning。
 * band 内 line 間隔が均一でなければ `irregularLineSpacing` warning (情報のみ、band は作る)。
 */
function groupIntoStaffBands(
  lineYs: number[],
  pageIndex: number,
  warnings: LayoutWarning[],
): StaffBand[] {
  const remainder = lineYs.length % 5;
  if (remainder !== 0) {
    warnings.push({
      pageIndex,
      kind: 'staffLineCountMismatch',
      detail: `検出 staff line ${lineYs.length} 本は 5 の倍数でない (余り ${remainder} 本を破棄)`,
    });
  }
  const usable = lineYs.length - remainder;
  const bands: StaffBand[] = [];
  for (let i = 0; i < usable; i += 5) {
    const groupLines = lineYs.slice(i, i + 5);
    const topY = groupLines[0];
    const bottomY = groupLines[4];
    const gaps = [
      groupLines[1] - groupLines[0],
      groupLines[2] - groupLines[1],
      groupLines[3] - groupLines[2],
      groupLines[4] - groupLines[3],
    ];
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const medianSpacing = (sortedGaps[1] + sortedGaps[2]) / 2;
    // 均等性 check: max / min が 1.5 超 かつ 絶対差 > 2 px なら warning
    if (sortedGaps[3] > sortedGaps[0] * 1.5 && sortedGaps[3] - sortedGaps[0] > 2) {
      warnings.push({
        pageIndex,
        kind: 'irregularLineSpacing',
        detail: `staff band at y=${topY}: line gaps = [${gaps.map((g) => g.toFixed(1)).join(', ')}]`,
      });
    }
    bands.push({
      topY,
      bottomY,
      lineYs: groupLines,
      lineSpacing: medianSpacing,
    });
  }
  return bands;
}

// ============================================================
// system grouping
// ============================================================

/**
 * StaffBand[] を先頭から `stavesPerSystem` 本ずつまとめて SystemLayout にする。
 * 端数 (最終 system が短い) は `shortSystem` warning として emit しつつ、短いまま system 化する。
 */
function groupIntoSystems(
  bands: StaffBand[],
  stavesPerSystem: number,
  pageIndex: number,
  warnings: LayoutWarning[],
): SystemLayout[] {
  if (stavesPerSystem <= 0) return [];
  const systems: SystemLayout[] = [];
  let idx = 0;
  let systemIndex = 0;
  while (idx < bands.length) {
    const take = Math.min(stavesPerSystem, bands.length - idx);
    const group = bands.slice(idx, idx + take);
    if (take < stavesPerSystem) {
      warnings.push({
        pageIndex,
        kind: 'shortSystem',
        detail: `system ${systemIndex}: ${take} staves (expected ${stavesPerSystem})`,
      });
    }
    systems.push({
      systemIndex,
      topY: group[0].topY,
      bottomY: group[take - 1].bottomY,
      staves: group,
      barlineXs: [],
      cells: [],
    });
    idx += take;
    systemIndex++;
  }
  return systems;
}

// ============================================================
// barline 検出 (per-system, per-staff intersect)
// ============================================================

/**
 * 1 system 内で barline x 座標を検出して `system.barlineXs` にセットする。
 *
 * アルゴリズム:
 *  1. 各 staff 単位で `verticalProjectionBand(staff.topY, staff.bottomY+1)` を計算
 *  2. そのうち `staff 高 × barlineCoverageRatio (0.9)` 以上の column を candidate とする
 *     (これにより staff 高の ~70% しかない stem は自動的に除外される)
 *  3. system 内の全 staff で candidate だった column のみを「真の barline」として intersect
 *     (multi-staff system では stem は 1 staff にしか出ないため除外、
 *      single-staff system では step 2 の 90% しきいで大半の stem を除外)
 *  4. 連続 column を centroid に畳んで最終 x 座標列とする
 */
function detectBarlinesForSystem(
  bin: Uint8Array,
  width: number,
  height: number,
  system: SystemLayout,
  pageIndex: number,
  opts: Required<PdfHideLayoutOptions>,
  warnings: LayoutWarning[],
): void {
  // 1-2. 各 staff の candidate column bitmap
  const perStaffCandidates: Uint8Array[] = [];
  for (const staff of system.staves) {
    // staff 高 (inclusive pixel 数). topY/bottomY は浮動小数なので Math.round で近似する.
    const topPx = Math.round(staff.topY);
    const botPx = Math.round(staff.bottomY);
    const staffHeight = botPx - topPx + 1;
    if (staffHeight <= 0) {
      perStaffCandidates.push(new Uint8Array(width));
      continue;
    }
    const vproj = verticalProjectionBand(bin, width, height, topPx, botPx + 1);
    const threshold = staffHeight * opts.barlineCoverageRatio;
    const candidates = new Uint8Array(width);
    for (let x = 0; x < width; x++) {
      candidates[x] = vproj[x] >= threshold ? 1 : 0;
    }
    perStaffCandidates.push(candidates);
  }

  // 3. 全 staff で candidate な column のみを intersect
  const intersect = new Uint8Array(width);
  if (perStaffCandidates.length > 0) {
    for (let x = 0; x < width; x++) {
      let all = 1;
      for (const c of perStaffCandidates) {
        if (c[x] === 0) {
          all = 0;
          break;
        }
      }
      intersect[x] = all;
    }
  }

  // 4. 連続 column を centroid 化
  const xs: number[] = [];
  let runStart = -1;
  for (let x = 0; x < width; x++) {
    if (intersect[x] === 1) {
      if (runStart < 0) runStart = x;
    } else if (runStart >= 0) {
      xs.push((runStart + (x - 1)) / 2);
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    xs.push((runStart + (width - 1)) / 2);
  }

  system.barlineXs = xs;
  if (xs.length === 0) {
    warnings.push({
      pageIndex,
      kind: 'noBarlinesDetected',
      detail: `system ${system.systemIndex}: barline 検出なし`,
    });
  } else if (xs.length === 1) {
    warnings.push({
      pageIndex,
      kind: 'tooFewBarlines',
      detail: `system ${system.systemIndex}: barline が 1 本のみ (measure を作れない)`,
    });
  }
}

// ============================================================
// cell box 構築
// ============================================================

/**
 * `system.barlineXs` と `system.staves` から cell を全組合せで生成して
 * `system.cells` にセットする。staffIndex 先、measureIndex 後の順で並ぶ。
 *
 * 1 measure = 連続する barline ペア `(barlineXs[m], barlineXs[m+1])` の間。
 * cell の x 範囲は両端 barline 自身を含まない。
 */
function buildCellsForSystem(system: SystemLayout, pageIndex: number): void {
  const { barlineXs, staves } = system;
  if (barlineXs.length < 2) {
    system.cells = [];
    return;
  }
  const cells: CellBox[] = [];
  for (let staffIdx = 0; staffIdx < staves.length; staffIdx++) {
    const staff = staves[staffIdx];
    const cellY = staff.topY;
    const cellHeight = staff.bottomY - staff.topY + 1;
    for (let m = 0; m < barlineXs.length - 1; m++) {
      const leftBar = barlineXs[m];
      const rightBar = barlineXs[m + 1];
      // barline 自身を除外: [leftBar+0.5, rightBar-0.5]
      const cellX = leftBar + 0.5;
      const cellWidth = rightBar - leftBar - 1;
      cells.push({
        pageIndex,
        systemIndex: system.systemIndex,
        staffIndex: staffIdx,
        measureIndex: m,
        x: cellX,
        y: cellY,
        width: cellWidth,
        height: cellHeight,
      });
    }
  }
  system.cells = cells;
}
