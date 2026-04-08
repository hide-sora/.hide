/**
 * pdfHideAssemble.ts — PDF→.hide pipeline Phase 3: assembly + diagnostic emit
 *
 * Phase 1 (LLM 全曲構造解析: `pdfHideMeta.ts`) と Phase 2 (古典 OMR 幾何検出:
 * `pdfHideLayout.ts` + `pdfHideNotehead.ts`) の出力を 1 つの `.hide` ソースに
 * 組み立てる pure TS モジュール。
 *
 * 設計原則:
 *  - **silent fill 禁止**: 検出失敗・低信頼セルは `;<level>:<cellId>` インライン
 *    コメント + 構造化 `PdfHideDiagnostic` の両方で必ず可視化する。検出失敗
 *    セルにダミー rest を流し込むときも、コメントで「これは unknown のための
 *    プレースホルダ」と明示する。
 *  - **Phase 4 LLM 補完路線への引き継ぎ**: `lowConfidenceCells` を返し、Phase 4
 *    の `pdfHideLlmFallback.ts` 入力にそのまま渡せるようにする。
 *  - **`analyzeMatrix` re-validation**: 出力ソースを内部で `analyzeMatrix` に
 *    通し、独立検算を `matrixIssues` に積む。これは pipeline 全体の最後に
 *    呼ばれる lint。
 *  - **part model**: `[1]..[N]` を声楽 staffRole === 'voice' に対して順番に割り当てる。
 *    `piano-treble` / `piano-bass` / `percussion` は現状 `unsupportedStaffRole`
 *    diagnostic を emit して hideSource からは除外 (silent fill にならぬよう
 *    diagnostic で明示)。
 *  - **複数ページ対応**: page → system → measure の reading order で各 staff の
 *    cell を flat 配列にし、part 内の連続 measure として出力する。
 *  - **依存**: `pdfHideLayout.ts` / `pdfHideMeta.ts` / `pdfHideNotehead.ts` /
 *    `hideMatrix.ts` / `hideTypes.ts`。LLM call はゼロ。
 */

import { analyzeMatrix } from './hideMatrix';
import type { HideMatrixIssue } from './hideMatrix';
import type { CellBox, LayoutWarning, PageLayout } from './pdfHideLayout';
import type {
  PdfHideClefName,
  PdfHideScoreContext,
  PdfHideStaffRole,
} from './pdfHideMeta';
import type {
  Notehead,
  NoteheadDetectionResult,
  PitchLetter,
} from './pdfHideNotehead';

// ============================================================
// 公開型
// ============================================================

/** セルの最終信頼度 (high → そのまま、mid → 注釈付き、low → 注釈付き、unknown → プレースホルダ) */
export type CellConfidence = 'high' | 'mid' | 'low' | 'unknown';

/** Phase 3 で発行される全 diagnostic の discriminated union */
export type PdfHideDiagnostic =
  | {
      kind: 'cellLowConfidence';
      partLabel: string;
      pageIndex: number;
      systemIndex: number;
      staffIndex: number;
      measureIndex: number;
      globalMeasureIndex: number;
      reason: string;
      noteheadCount: number;
      minConfidence: number;
    }
  | {
      kind: 'cellEmpty';
      partLabel: string;
      pageIndex: number;
      systemIndex: number;
      staffIndex: number;
      measureIndex: number;
      globalMeasureIndex: number;
      reason: string;
    }
  | {
      kind: 'cellUnknown';
      partLabel: string;
      pageIndex: number;
      systemIndex: number;
      staffIndex: number;
      measureIndex: number;
      globalMeasureIndex: number;
      reason: string;
    }
  | {
      kind: 'noteheadCountMismatch';
      partLabel: string;
      pageIndex: number;
      systemIndex: number;
      staffIndex: number;
      measureIndex: number;
      globalMeasureIndex: number;
      expected: number;
      got: number;
    }
  | {
      kind: 'tiedSlurAmbiguous';
      partLabel: string;
      globalMeasureIndex: number;
      detail: string;
    }
  | {
      kind: 'accidentalCarryOverConflict';
      partLabel: string;
      globalMeasureIndex: number;
      detail: string;
    }
  | {
      kind: 'partMeasureCountMismatch';
      partIndex: number;
      partLabel: string;
      got: number;
      expected: number;
    }
  | {
      kind: 'layoutWarning';
      pageIndex: number;
      layoutKind: LayoutWarning['kind'];
      detail: string;
    }
  | {
      kind: 'unsupportedStaffRole';
      staffIndex: number;
      role: PdfHideStaffRole;
      detail: string;
    }
  | {
      kind: 'durationFillMismatch';
      partLabel: string;
      pageIndex: number;
      systemIndex: number;
      staffIndex: number;
      measureIndex: number;
      globalMeasureIndex: number;
      sum: number;
      expected: number;
    }
  | {
      kind: 'totalMeasureCountMismatch';
      gotMaxAcrossParts: number;
      contextTotal: number;
    };

/** セル単位の信頼度サマリ */
export interface PdfHideCellConfidenceEntry {
  pageIndex: number;
  systemIndex: number;
  staffIndex: number;
  measureIndex: number;
  partLabel: string;
  /** 全パート串通しでの絶対 measure index (0-based) */
  globalMeasureIndex: number;
  confidence: CellConfidence;
  /** 検出された notehead 数 (unknown / cellEmpty なら 0) */
  noteheadCount: number;
  /** 最小 notehead confidence (notehead が無ければ 0) */
  minNoteheadConfidence: number;
}

/** Phase 4 LLM 補完入力への引き継ぎ用 (低信頼セル + 検出失敗セル) */
export interface PdfHideLowConfidenceCellId {
  pageIndex: number;
  systemIndex: number;
  staffIndex: number;
  measureIndex: number;
  globalMeasureIndex: number;
  partLabel: string;
  confidence: CellConfidence;
}

/** assemble の入力 */
export interface AssemblePdfHideInput {
  context: PdfHideScoreContext;
  pageLayouts: PageLayout[];
  /**
   * cell → notehead 検出結果. キーは `CellBox` のリファレンス identity を使う.
   * 通常は consumer が `for (const cell of sys.cells) noteheadsByCell.set(cell, detect(...))`
   * のように埋める。
   */
  noteheadsByCell: Map<CellBox, NoteheadDetectionResult>;
  options?: AssemblePdfHideOptions;
}

/** assemble のチューニング knob */
export interface AssemblePdfHideOptions {
  /** 出力 header の DIV. default 32 */
  div?: number;
  /** confidence >= これを 'high' に分類 (default 0.85) */
  highConfidenceThreshold?: number;
  /** confidence >= これを 'mid' に分類 (default 0.55). high 未満 mid 以上 = mid */
  midConfidenceThreshold?: number;
  /**
   * 同一和音判定の x 距離許容 (lineSpacing 倍率).
   * default 0.6 (= notehead 半径ぶん)
   */
  chordGroupingTolerance?: number;
}

/** assemble の出力 */
export interface PdfHideAssembleResult {
  /** 完成した .hide ソース文字列 */
  hideSource: string;
  /** 先頭の `[CLEF:... TIME:N/D KEY:f DIV:32]` ヘッダー文字列 (1 行) */
  header: string;
  /** パート数 (= staffRoles のうち voice な数) */
  partsCount: number;
  /** 全パート串通しでの最大 measure 数 */
  measuresCount: number;
  /** 構造化 diagnostic (silent fill 禁止の昇格先) */
  diagnostics: PdfHideDiagnostic[];
  /** 自由文の警告 (loose な info を string で残すための場所) */
  warnings: string[];
  /** 出力ソースを `analyzeMatrix` に通したときの strict re-validation 結果 */
  matrixIssues: HideMatrixIssue[];
  /** セル単位の confidence 一覧 */
  cellConfidence: PdfHideCellConfidenceEntry[];
  /** 全セルのうち confidence が 'high' でない比率 (0..1). セル 0 のときは 0 */
  lowConfidenceRatio: number;
  /** Phase 4 LLM 補完にかける対象セル ('low' + 'unknown' + 'mid') */
  lowConfidenceCells: PdfHideLowConfidenceCellId[];
}

// ============================================================
// 内部定数 / 変換テーブル
// ============================================================

/** durationUnits → length char (DIV=32 基準) */
const UNITS_TO_LENGTH: ReadonlyArray<readonly [number, string]> = [
  [32, 'm'],
  [16, 'l'],
  [8, 'k'],
  [4, 'j'],
  [2, 'i'],
  [1, 'h'],
];

const DEFAULT_OPTIONS: Required<AssemblePdfHideOptions> = {
  div: 32,
  highConfidenceThreshold: 0.85,
  midConfidenceThreshold: 0.55,
  chordGroupingTolerance: 0.6,
};

// ============================================================
// 主エントリ
// ============================================================

/**
 * Phase 1/2 の出力を 1 本の .hide ソースに組み立てる。
 *
 * 例外は投げない。検出失敗・低信頼セルは diagnostic + コメント + プレースホルダで
 * 可視化し、`analyzeMatrix` での再 validate 結果も `matrixIssues` に積む。
 *
 * @example
 *   const result = assemblePdfHide({
 *     context: meta.context!,
 *     pageLayouts,
 *     noteheadsByCell,
 *   });
 *   if (result.lowConfidenceCells.length > 0) {
 *     // Phase 4 LLM 補完へ引き継ぎ
 *   }
 *   if (result.matrixIssues.length === 0 && result.diagnostics.length === 0) {
 *     // 100% 到達 → そのまま hide studio へ
 *   }
 */
export function assemblePdfHide(
  input: AssemblePdfHideInput,
): PdfHideAssembleResult {
  const opts: Required<AssemblePdfHideOptions> = {
    div: input.options?.div ?? DEFAULT_OPTIONS.div,
    highConfidenceThreshold:
      input.options?.highConfidenceThreshold ??
      DEFAULT_OPTIONS.highConfidenceThreshold,
    midConfidenceThreshold:
      input.options?.midConfidenceThreshold ??
      DEFAULT_OPTIONS.midConfidenceThreshold,
    chordGroupingTolerance:
      input.options?.chordGroupingTolerance ??
      DEFAULT_OPTIONS.chordGroupingTolerance,
  };
  const { context, pageLayouts, noteheadsByCell } = input;
  const diagnostics: PdfHideDiagnostic[] = [];
  const warnings: string[] = [];

  // 1. layout warning を pull-up
  for (const pl of pageLayouts) {
    for (const w of pl.warnings) {
      diagnostics.push({
        kind: 'layoutWarning',
        pageIndex: pl.pageIndex,
        layoutKind: w.kind,
        detail: w.detail,
      });
    }
  }

  // 2. staffRoles → part labels (voice のみ採用、それ以外は unsupported diagnostic)
  const { partLabels, voiceStaffIndices } = buildPartLabels(
    context.staffRoles,
    diagnostics,
  );

  // 3. 各 part 用に reading order で cell を flatten
  //    (page → system → このパートの staffIndex の cell の measure 順)
  const partCellsMap = new Map<string, CellBox[]>();
  for (let i = 0; i < partLabels.length; i++) {
    const partLabel = partLabels[i];
    const staffIdx = voiceStaffIndices[i];
    const cells = collectCellsForStaffIndex(pageLayouts, staffIdx);
    partCellsMap.set(partLabel, cells);
  }

  // 4. 全パートで一致する measure 数を確定し、不一致なら partMeasureCountMismatch
  let maxMeasures = 0;
  for (const cells of partCellsMap.values()) {
    if (cells.length > maxMeasures) maxMeasures = cells.length;
  }
  for (let i = 0; i < partLabels.length; i++) {
    const partLabel = partLabels[i];
    const got = partCellsMap.get(partLabel)?.length ?? 0;
    if (got !== maxMeasures) {
      diagnostics.push({
        kind: 'partMeasureCountMismatch',
        partIndex: i,
        partLabel,
        got,
        expected: maxMeasures,
      });
    }
  }
  if (
    typeof context.totalMeasures === 'number' &&
    context.totalMeasures > 0 &&
    maxMeasures !== context.totalMeasures
  ) {
    diagnostics.push({
      kind: 'totalMeasureCountMismatch',
      gotMaxAcrossParts: maxMeasures,
      contextTotal: context.totalMeasures,
    });
  }

  // 5. 1 小節あたりの想定 unit 数 = (timeNum / timeDen) * div
  //    DIV を 32 固定で出すので、unitsPerMeasure もそれに合わせる
  const timeNum = context.initialTimeSignature.numerator;
  const timeDen = context.initialTimeSignature.denominator;
  const unitsPerMeasure = Math.max(
    1,
    Math.round((timeNum / timeDen) * opts.div),
  );

  // 6. ヘッダー
  const header = buildHeader(
    context.clefsPerStaff[voiceStaffIndices[0]] ?? 'TREBLE',
    timeNum,
    timeDen,
    context.initialKeyFifths,
    opts.div,
  );

  // 7. 各 part の各 cell について token を組み立て、信頼度を判定
  //    出力フォーマットは「1 cell = 1 行」の multi-line 形式とする。
  //    - 1 行目: `[CLEF:... TIME:... KEY:... DIV:...]` (header)
  //    - 各 part: `[N]` (part switch on its own line) を出し、続く各 cell を
  //      `| <tokens> [;<level>:<cellId> reason]` の形で 1 行ずつ出す。
  //      末尾の `;...` 行末コメントが lex で skip されることで、`|` separator が
  //      「次の」cell に正しく引き継がれる (`|` を `;` が食わないように、行頭の
  //      `|` を新しい行に置く)。
  const cellConfidence: PdfHideCellConfidenceEntry[] = [];
  const lowConfidenceCells: PdfHideLowConfidenceCellId[] = [];

  const sourceLines: string[] = [header];
  for (let pi = 0; pi < partLabels.length; pi++) {
    const partLabel = partLabels[pi];
    const cells = partCellsMap.get(partLabel) ?? [];
    sourceLines.push(`[${partLabel}]`);

    for (let m = 0; m < maxMeasures; m++) {
      const cell = cells[m];
      if (!cell) {
        // partMeasureCountMismatch は既に emit 済み。
        // ソースを完結させるため unknown プレースホルダを 1 小節分挿入。
        const cellId = makeCellIdForMissing(pi, m);
        const restSeq = unitsToRestSequence(unitsPerMeasure);
        sourceLines.push(`| ${restSeq} ;unknown:${cellId} part-measure-count-mismatch`);
        continue;
      }
      const detection = noteheadsByCell.get(cell);
      const cellId = makeCellId(cell);
      const result = assembleSingleCell({
        cell,
        detection,
        partLabel,
        globalMeasureIndex: m,
        unitsPerMeasure,
        opts,
        cellId,
        diagnostics,
      });
      // 行頭 `|` separator + tokens + 任意の行末コメント
      const commentSuffix =
        result.endOfLineComment.length > 0
          ? ` ${result.endOfLineComment}`
          : '';
      sourceLines.push(`| ${result.tokenString}${commentSuffix}`);
      cellConfidence.push({
        pageIndex: cell.pageIndex,
        systemIndex: cell.systemIndex,
        staffIndex: cell.staffIndex,
        measureIndex: cell.measureIndex,
        partLabel,
        globalMeasureIndex: m,
        confidence: result.confidence,
        noteheadCount: result.noteheadCount,
        minNoteheadConfidence: result.minNoteheadConfidence,
      });
      if (result.confidence !== 'high') {
        lowConfidenceCells.push({
          pageIndex: cell.pageIndex,
          systemIndex: cell.systemIndex,
          staffIndex: cell.staffIndex,
          measureIndex: cell.measureIndex,
          globalMeasureIndex: m,
          partLabel,
          confidence: result.confidence,
        });
      }
    }
  }

  // 8. ソース完成
  const hideSource = sourceLines.join('\n') + '\n';

  // 9. lowConfidenceRatio
  const totalCells = cellConfidence.length;
  const nonHighCells = cellConfidence.filter(
    (c) => c.confidence !== 'high',
  ).length;
  const lowConfidenceRatio = totalCells === 0 ? 0 : nonHighCells / totalCells;

  // 10. analyzeMatrix で strict re-validate (silent fill 禁止の自助確認)
  let matrixIssues: HideMatrixIssue[] = [];
  try {
    const matrixResult = analyzeMatrix(hideSource);
    matrixIssues = matrixResult.issues;
  } catch (e) {
    warnings.push(
      `analyzeMatrix が例外を投げました: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return {
    hideSource,
    header,
    partsCount: partLabels.length,
    measuresCount: maxMeasures,
    diagnostics,
    warnings,
    matrixIssues,
    cellConfidence,
    lowConfidenceRatio,
    lowConfidenceCells,
  };
}

// ============================================================
// 内部: ヘッダー
// ============================================================

/** clef 名を `[CLEF:...]` に書く形式に正規化 */
function normalizeClef(clef: PdfHideClefName | undefined): string {
  if (!clef) return 'TREBLE';
  const upper = String(clef).toUpperCase();
  // 既知の主要値のみ通す。それ以外は string そのまま (downstream で警告される想定)
  const known = new Set([
    'TREBLE',
    'BASS',
    'ALTO',
    'TENOR',
    'SOPRANO',
    'MEZZO',
    'TREBLE_8VA',
    'TREBLE_8VB',
    'BASS_8VA',
    'BASS_8VB',
    'PERCUSSION',
  ]);
  if (known.has(upper)) return upper;
  // hideTypes.HideClef は TREBLE/BASS/ALTO/TENOR/PERCUSSION のみサポート
  // 他の値は TREBLE に fallback (consumer 側で diagnostic 化される想定)
  return 'TREBLE';
}

/** `[CLEF:T TIME:N/D KEY:f DIV:d]` を組み立て */
function buildHeader(
  clef: PdfHideClefName,
  timeNum: number,
  timeDen: number,
  keyFifths: number,
  div: number,
): string {
  return `[CLEF:${normalizeClef(clef)} TIME:${timeNum}/${timeDen} KEY:${keyFifths} DIV:${div}]`;
}

// ============================================================
// 内部: part labels
// ============================================================

/**
 * `staffRoles` から voice staff のインデックスと part label を生成する。
 * voice 以外 (piano-treble / piano-bass / percussion) は `unsupportedStaffRole`
 * diagnostic を emit して hideSource からは除外する (silent fill 回避)。
 *
 * voice 番号は 1-origin。`[1]`, `[2]`, ..., `[N]` を返す。
 */
function buildPartLabels(
  staffRoles: PdfHideStaffRole[],
  diagnostics: PdfHideDiagnostic[],
): { partLabels: string[]; voiceStaffIndices: number[] } {
  const partLabels: string[] = [];
  const voiceStaffIndices: number[] = [];
  let voiceCounter = 0;
  for (let i = 0; i < staffRoles.length; i++) {
    const role = staffRoles[i];
    if (role === 'voice') {
      voiceCounter++;
      partLabels.push(String(voiceCounter));
      voiceStaffIndices.push(i);
    } else {
      diagnostics.push({
        kind: 'unsupportedStaffRole',
        staffIndex: i,
        role,
        detail: `staff ${i} は role='${role}' のため hideSource から除外しました (Phase 3 は voice のみ支援)`,
      });
    }
  }
  return { partLabels, voiceStaffIndices };
}

// ============================================================
// 内部: per-staff cell collection
// ============================================================

/**
 * 全 page → system → measure を reading order で walk して、指定 staffIndex の
 * cell を flat 配列にする。出力配列の index がそのまま global measure index に
 * 対応する (= part 内の連続 measure 番号)。
 */
function collectCellsForStaffIndex(
  pageLayouts: PageLayout[],
  staffIndex: number,
): CellBox[] {
  const out: CellBox[] = [];
  // pageLayouts は consumer によって順序保証される想定だが念のため pageIndex でソート
  const pages = [...pageLayouts].sort((a, b) => a.pageIndex - b.pageIndex);
  for (const pl of pages) {
    const systems = [...pl.systems].sort(
      (a, b) => a.systemIndex - b.systemIndex,
    );
    for (const sys of systems) {
      // sys.cells は staffIdx 先, measureIdx 後の順 → staffIndex でフィルタして
      // measureIndex でソートし直す
      const inStaff = sys.cells
        .filter((c) => c.staffIndex === staffIndex)
        .sort((a, b) => a.measureIndex - b.measureIndex);
      for (const c of inStaff) out.push(c);
    }
  }
  return out;
}

// ============================================================
// 内部: cell ID
// ============================================================

/** `;low-confidence:p0s1i2m3` のような cellId 文字列を作る */
function makeCellId(cell: CellBox): string {
  return `p${cell.pageIndex}s${cell.systemIndex}i${cell.staffIndex}m${cell.measureIndex}`;
}

/** part-mismatch で missing cell を埋めるときの仮 cellId */
function makeCellIdForMissing(partIndex: number, globalMeasureIndex: number): string {
  return `missing-part${partIndex}-m${globalMeasureIndex}`;
}

// ============================================================
// 内部: rest 列生成 (unknown / cell-empty / duration-fill 用)
// ============================================================

/**
 * `units` を greedy に length char に分解した rest 列文字列を返す。
 * 例: 32 → "Rm", 24 → "Rl Rk", 6 → "Rj Ri", 1 → "Rh"
 *
 * 用途: 検出失敗・unknown・duration-fill 等で「分かっている時間長を rest で
 * 埋める」必要があるとき。これらは silent fill ではなく、生成箇所で必ず
 * 明示的なコメント (`;unknown:`, `;cell-empty:`, `;low-confidence:` etc.) と
 * `PdfHideDiagnostic` の発行を伴う。
 */
function unitsToRestSequence(units: number): string {
  if (units <= 0) return '';
  const parts: string[] = [];
  let remaining = units;
  for (const [u, ch] of UNITS_TO_LENGTH) {
    while (remaining >= u) {
      parts.push(`R${ch}`);
      remaining -= u;
    }
  }
  // 残り (1 未満の端数) は丸めて 'h' を 1 つ足す
  if (remaining > 0) parts.push('Rh');
  return parts.join(' ');
}

// ============================================================
// 内部: per-cell assembly
// ============================================================

interface AssembleSingleCellInput {
  cell: CellBox;
  detection: NoteheadDetectionResult | undefined;
  partLabel: string;
  globalMeasureIndex: number;
  unitsPerMeasure: number;
  opts: Required<AssemblePdfHideOptions>;
  cellId: string;
  diagnostics: PdfHideDiagnostic[];
}

interface AssembleSingleCellResult {
  /** cell の中身 (token 列、空白区切り)。`|` 等の境界記号は含まない (caller がつなぐ) */
  tokenString: string;
  /**
   * 行末コメント (`;...`)。confidence が高くなく、追加のメタ情報を残したいときに
   * 1 行で書ける情報を入れる。空文字なら付けない。
   */
  endOfLineComment: string;
  confidence: CellConfidence;
  noteheadCount: number;
  minNoteheadConfidence: number;
}

/** 1 cell を組み立てる: notehead 列 → token 文字列 + 信頼度 */
function assembleSingleCell(
  input: AssembleSingleCellInput,
): AssembleSingleCellResult {
  const {
    cell,
    detection,
    partLabel,
    globalMeasureIndex,
    unitsPerMeasure,
    opts,
    cellId,
    diagnostics,
  } = input;

  // (a) detection が無い → unknown
  if (!detection) {
    diagnostics.push({
      kind: 'cellUnknown',
      partLabel,
      pageIndex: cell.pageIndex,
      systemIndex: cell.systemIndex,
      staffIndex: cell.staffIndex,
      measureIndex: cell.measureIndex,
      globalMeasureIndex,
      reason: 'noteheadsByCell に該当 cell の detection 結果がありません',
    });
    return {
      tokenString: unitsToRestSequence(unitsPerMeasure),
      endOfLineComment: `;unknown:${cellId} no-detection`,
      confidence: 'unknown',
      noteheadCount: 0,
      minNoteheadConfidence: 0,
    };
  }

  // (b) detection が空 → cellEmpty (休符と区別したい: 検出失敗かもしれない)
  if (detection.noteheads.length === 0) {
    diagnostics.push({
      kind: 'cellEmpty',
      partLabel,
      pageIndex: cell.pageIndex,
      systemIndex: cell.systemIndex,
      staffIndex: cell.staffIndex,
      measureIndex: cell.measureIndex,
      globalMeasureIndex,
      reason: 'notehead が 1 つも検出されませんでした (rest 候補 or 検出失敗)',
    });
    return {
      tokenString: unitsToRestSequence(unitsPerMeasure),
      endOfLineComment: `;cell-empty:${cellId} no-noteheads`,
      confidence: 'unknown',
      noteheadCount: 0,
      minNoteheadConfidence: 0,
    };
  }

  // (c) notehead 列を chord にグルーピングして token 化
  const sorted = [...detection.noteheads].sort(
    (a, b) => a.centroidX - b.centroidX,
  );
  // chord グルーピング (cell の lineSpacing は知らないので bbox 幅平均から推定)
  const tolerance = estimateChordTolerance(sorted, opts.chordGroupingTolerance);
  const groups: Notehead[][] = [];
  let currentGroup: Notehead[] = [];
  let currentX = -Infinity;
  for (const nh of sorted) {
    if (currentGroup.length === 0 || nh.centroidX - currentX <= tolerance) {
      currentGroup.push(nh);
      currentX = currentX === -Infinity ? nh.centroidX : (currentX + nh.centroidX) / 2;
    } else {
      groups.push(currentGroup);
      currentGroup = [nh];
      currentX = nh.centroidX;
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  const tokens: string[] = [];
  let totalUnits = 0;
  let minConf = Infinity;
  for (const group of groups) {
    const tokenStr = chordGroupToToken(group);
    if (tokenStr === null) continue; // pitch 取得不能はスキップ (個別 diagnostic は将来)
    tokens.push(tokenStr.text);
    totalUnits += tokenStr.units;
    for (const nh of group) {
      if (nh.confidence < minConf) minConf = nh.confidence;
    }
  }
  if (minConf === Infinity) minConf = 0;

  // (d) 合計 duration が unitsPerMeasure と合わない → fill / truncate + diagnostic
  let durationFixed = false;
  if (totalUnits < unitsPerMeasure && tokens.length > 0) {
    diagnostics.push({
      kind: 'durationFillMismatch',
      partLabel,
      pageIndex: cell.pageIndex,
      systemIndex: cell.systemIndex,
      staffIndex: cell.staffIndex,
      measureIndex: cell.measureIndex,
      globalMeasureIndex,
      sum: totalUnits,
      expected: unitsPerMeasure,
    });
    const fill = unitsToRestSequence(unitsPerMeasure - totalUnits);
    if (fill.length > 0) {
      // 末尾に rest を追加して埋める。コメントは行末で別途付与する。
      tokens.push(fill);
    }
    durationFixed = true;
  } else if (totalUnits > unitsPerMeasure) {
    diagnostics.push({
      kind: 'durationFillMismatch',
      partLabel,
      pageIndex: cell.pageIndex,
      systemIndex: cell.systemIndex,
      staffIndex: cell.staffIndex,
      measureIndex: cell.measureIndex,
      globalMeasureIndex,
      sum: totalUnits,
      expected: unitsPerMeasure,
    });
    durationFixed = true;
  }

  // (e) 信頼度の決定
  let confidence: CellConfidence;
  if (durationFixed) {
    // duration がズレた cell は 'low' に格下げ (LLM Phase 4 の補完対象)
    confidence = 'low';
  } else if (minConf >= opts.highConfidenceThreshold) {
    confidence = 'high';
  } else if (minConf >= opts.midConfidenceThreshold) {
    confidence = 'mid';
  } else {
    confidence = 'low';
  }

  // (f) low / mid なら cellLowConfidence diagnostic を追加 (silent fill 防止)
  //     行末コメントも合わせて返す。コメントは caller (multi-line emit) が
  //     その cell 行の末尾に追加する。lex は `;` 〜 `\n` を skip するので、
  //     行末配置なら次行の `|` separator は影響を受けない。
  let endOfLineComment = '';
  if (confidence !== 'high') {
    diagnostics.push({
      kind: 'cellLowConfidence',
      partLabel,
      pageIndex: cell.pageIndex,
      systemIndex: cell.systemIndex,
      staffIndex: cell.staffIndex,
      measureIndex: cell.measureIndex,
      globalMeasureIndex,
      reason: durationFixed
        ? `duration mismatch: ${totalUnits}u / expected ${unitsPerMeasure}u`
        : `min notehead confidence ${minConf.toFixed(3)}`,
      noteheadCount: detection.noteheads.length,
      minConfidence: minConf,
    });
    endOfLineComment = `;${confidence}-confidence:${cellId} minConf=${minConf.toFixed(3)}`;
  }

  return {
    tokenString: tokens.join(' '),
    endOfLineComment,
    confidence,
    noteheadCount: detection.noteheads.length,
    minNoteheadConfidence: minConf === Infinity ? 0 : minConf,
  };
}

// ============================================================
// 内部: chord グルーピングの tolerance 推定
// ============================================================

/**
 * `Notehead` 列から chord 判定 tolerance (pixel) を推定する。
 * `Notehead.width` の median を取り、その `lineSpacingRatio` 倍を返す。
 * notehead が 1 個以下なら 0.
 */
function estimateChordTolerance(
  noteheads: Notehead[],
  ratio: number,
): number {
  if (noteheads.length <= 1) return 0;
  const widths = noteheads.map((n) => n.width).sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)];
  return median * ratio;
}

// ============================================================
// 内部: chord group → token text
// ============================================================

interface ChordTokenText {
  text: string;
  units: number;
}

/**
 * 1 chord グループを 1 つのトークン文字列にする。
 *
 * - 各 notehead の `letter` が undefined のときはそのピッチを skip
 * - duration は group 先頭の notehead の `durationUnits` を採用 (chord の音価は通常一致)
 * - duration が不明なら quarter (`k` = DIV/4 unit) を fallback
 * - alter は `notehead.alter` をそのまま反映 (`#` / `b` / `n` / 無し)
 *
 * 例: `[{letter:'C',octave:4,alter:0},{letter:'E',octave:4,alter:0},{letter:'G',octave:4,alter:0}]`
 *     duration 8 → "C4E4G4k"
 */
function chordGroupToToken(group: Notehead[]): ChordTokenText | null {
  if (group.length === 0) return null;
  const pitched = group.filter((n) => n.letter !== undefined && n.octave !== undefined);
  if (pitched.length === 0) {
    // x notehead 等 (pitch なし)。現状の Phase 3 では pitch なしは出さない。
    // 将来 percussion staff が voice に分類されない限り発生しない想定。
    return null;
  }
  // duration: group 先頭の durationUnits を採用. 無ければ k (= 8u @ DIV32)
  const durationUnits = pitched[0].durationUnits ?? 8;
  const lengthChar = unitsToLengthChar(durationUnits);
  let body = '';
  for (const n of pitched) {
    body += letterPart(n.letter!, n.alter, n.accidentalSource);
    body += String(n.octave!);
  }
  body += lengthChar;
  return { text: body, units: durationUnits };
}

/** durationUnits → length char (default 'k') */
function unitsToLengthChar(units: number): string {
  for (const [u, ch] of UNITS_TO_LENGTH) {
    if (u === units) return ch;
  }
  // 非対応: 最も近いものを返す (down-round)
  for (const [u, ch] of UNITS_TO_LENGTH) {
    if (u <= units) return ch;
  }
  return 'h';
}

/** letter + alter marker. accidentalSource === 'explicit' で alter==0 のときのみ 'n' */
function letterPart(
  letter: PitchLetter,
  alter: number | undefined,
  accidentalSource: Notehead['accidentalSource'],
): string {
  if (alter === undefined || alter === 0) {
    if (accidentalSource === 'explicit') return `${letter}n`;
    return letter;
  }
  if (alter > 0) return `${letter}#`;
  return `${letter}b`;
}
