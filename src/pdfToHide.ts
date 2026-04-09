/**
 * pdfToHide.ts — PDF → .hide ワンショット API
 *
 * 4 フェーズ pipeline を 1 関数で実行する end-to-end API。
 *
 *   Phase 1: LLM Vision 全曲構造解析 (pdfHideMeta)
 *   Phase 2a: 古典 OMR レイアウト検出 (pdfHideLayout)
 *   Phase 2b: 古典 OMR notehead 検出 (pdfHideNotehead)
 *   Phase 3: assembly + diagnostic emit (pdfHideAssemble)
 *   Phase 4: LLM 低信頼セル補完 (pdfHideLlmFallback, optional)
 *
 * 依存: pdfjs-dist (PDF→画像), @anthropic-ai/sdk (LLM)
 */

import type { PdfHideImage } from './pdfHideImage';
import type { PdfHideScoreContext, PdfHideMetaImage } from './pdfHideMeta';
import type { PageLayout, CellBox } from './pdfHideLayout';
import type { NoteheadDetectionResult } from './pdfHideNotehead';
import type {
  PdfHideAssembleResult,
  PdfHideDiagnostic,
} from './pdfHideAssemble';
import type { PdfHideFallbackCellOverride } from './pdfHideLlmFallback';
import type { CallLlmFn, PdfHideLlmOptions } from './pdfHideLlm';
import type { HideMatrixIssue } from './hideMatrix';

import { buildPdfHideMetaPrompt, applyPdfHideMetaResponse } from './pdfHideMeta';
import { extractPageLayout } from './pdfHideLayout';
import { detectNoteheadsInCell } from './pdfHideNotehead';
import { assemblePdfHide } from './pdfHideAssemble';
import {
  buildPdfHideLlmFallbackPrompt,
  applyPdfHideLlmFallbackResponse,
} from './pdfHideLlmFallback';
import { createClaudeCaller } from './pdfHideLlm';
import { pdfToImages, pdfToImagesFromFile } from './pdfToImages';

// ============================================================
// 公開型
// ============================================================

export interface PdfToHideOptions {
  /** LLM 設定 (API key, model, カスタム callLlm) */
  llm?: PdfHideLlmOptions;
  /** レンダリング DPI (default: 150) */
  dpi?: number;
  /** Phase 4 (LLM fallback) を実行するか (default: true) */
  enableFallback?: boolean;
  /** Phase 4 の低信頼度閾値 (default: 0.1 = 10% 以上のセルが低信頼なら fallback) */
  fallbackThreshold?: number;
  /** 楽曲メタデータヒント (タイトル、作曲者など) */
  pieceHint?: { title?: string; composer?: string };
  /** 進捗コールバック */
  onProgress?: (phase: string, detail: string) => void;
}

export interface PdfToHideResult {
  /** 変換済みの .hide ソーステキスト */
  hideSource: string;
  /** Phase 1 で抽出した楽曲コンテキスト */
  context: PdfHideScoreContext;
  /** Phase 2a のレイアウト情報 */
  pageLayouts: PageLayout[];
  /** Phase 3 の assembly 結果 */
  assembleResult: PdfHideAssembleResult;
  /** Phase 4 の cell overrides (fallback 実行時) */
  fallbackOverrides: PdfHideFallbackCellOverride[];
  /** 全フェーズの統合 diagnostics */
  diagnostics: PdfHideDiagnostic[];
  /** 全フェーズの統合 warnings */
  warnings: string[];
  /** matrix 再解析の issues */
  matrixIssues: HideMatrixIssue[];
  /** パート数 */
  partsCount: number;
  /** 小節数 */
  measuresCount: number;
  /** ページ数 */
  pageCount: number;
}

// ============================================================
// 公開API
// ============================================================

/**
 * PDF バイナリを .hide ソースに変換する。
 *
 * @example
 *   import { readFileSync } from 'fs';
 *   const pdf = readFileSync('score.pdf');
 *   const result = await pdfToHide(pdf);
 *   console.log(result.hideSource);
 */
export async function pdfToHide(
  pdfData: ArrayBuffer | Uint8Array,
  opts: PdfToHideOptions = {},
): Promise<PdfToHideResult> {
  const progress = opts.onProgress ?? (() => {});
  const callLlm = createClaudeCaller(opts.llm ?? {});

  // ── Step 0: PDF → 画像 ──
  progress('render', 'PDF をページ画像に変換中...');
  const { images, base64Pages, pageCount } = await pdfToImages(pdfData, {
    dpi: opts.dpi,
  });

  // ── Phase 1: LLM 全曲構造解析 ──
  progress('phase1', 'LLM で楽曲構造を解析中...');
  const context = await runPhase1(images, base64Pages, callLlm, opts);

  // ── Phase 2a: レイアウト検出 ──
  progress('phase2a', '五線・小節線を検出中...');
  const pageLayouts = extractPageLayout({
    pageImages: images,
    context: { stavesPerSystem: context.stavesPerSystem },
  });

  // ── Phase 2b: 符頭検出 ──
  progress('phase2b', '音符を認識中...');
  const noteheadsByCell = runPhase2b(images, pageLayouts, context);

  // ── Phase 3: assembly ──
  progress('phase3', '.hide ソースを組み立て中...');
  const assembleResult = assemblePdfHide({
    context,
    pageLayouts,
    noteheadsByCell,
  });

  // ── Phase 4: LLM fallback (optional) ──
  let fallbackOverrides: PdfHideFallbackCellOverride[] = [];
  let hideSource = assembleResult.hideSource;

  const enableFallback = opts.enableFallback !== false;
  const threshold = opts.fallbackThreshold ?? 0.1;

  if (
    enableFallback &&
    assembleResult.lowConfidenceRatio > threshold &&
    assembleResult.lowConfidenceCells.length > 0
  ) {
    progress('phase4', '低信頼セルを LLM で補正中...');
    const result = await runPhase4(
      base64Pages,
      assembleResult,
      context,
      callLlm,
    );
    fallbackOverrides = result.overrides;
    if (result.correctedSource) {
      hideSource = result.correctedSource;
    }
  }

  return {
    hideSource,
    context,
    pageLayouts,
    assembleResult,
    fallbackOverrides,
    diagnostics: assembleResult.diagnostics,
    warnings: [...assembleResult.warnings],
    matrixIssues: assembleResult.matrixIssues,
    partsCount: assembleResult.partsCount,
    measuresCount: assembleResult.measuresCount,
    pageCount,
  };
}

/**
 * PDF ファイルパスから .hide に変換する (Node.js 専用)。
 */
export async function pdfToHideFromFile(
  filePath: string,
  opts: PdfToHideOptions = {},
): Promise<PdfToHideResult> {
  const { readFileSync } = await import('node:fs');
  const data = readFileSync(filePath);
  return pdfToHide(data.buffer as ArrayBuffer, opts);
}

// ============================================================
// 内部: Phase 1 (LLM 全曲構造解析)
// ============================================================

async function runPhase1(
  _images: PdfHideImage[],
  base64Pages: Array<{ base64: string; mediaType: 'image/png' }>,
  callLlm: CallLlmFn,
  opts: PdfToHideOptions,
): Promise<PdfHideScoreContext> {
  const pageImages: PdfHideMetaImage[] = base64Pages.map((p, i) => ({
    base64: p.base64,
    mediaType: p.mediaType,
    pageNumber: i + 1,
  }));

  const prompt = buildPdfHideMetaPrompt({
    pageImages,
    pieceHint: opts.pieceHint
      ? { title: opts.pieceHint.title, composer: opts.pieceHint.composer }
      : undefined,
  });

  const responseText = await callLlm({
    systemPrompt: prompt.systemPrompt,
    userContent: prompt.userContent,
    maxTokens: 4096,
  });

  const result = applyPdfHideMetaResponse({
    llmResponse: responseText,
  });

  if (!result.context) {
    throw new Error(
      `Phase 1 failed: LLM 応答のパースに失敗しました。` +
      (result.parseError ? ` Error: ${result.parseError}` : '') +
      (result.warnings.length > 0 ? ` Warnings: ${result.warnings.join('; ')}` : ''),
    );
  }

  return result.context;
}

// ============================================================
// 内部: Phase 2b (符頭検出)
// ============================================================

function runPhase2b(
  images: PdfHideImage[],
  pageLayouts: PageLayout[],
  context: PdfHideScoreContext,
): Map<CellBox, NoteheadDetectionResult> {
  const results = new Map<CellBox, NoteheadDetectionResult>();

  for (const layout of pageLayouts) {
    const pageImage = images[layout.pageIndex];
    if (!pageImage) continue;

    for (const system of layout.systems) {
      for (const cell of system.cells) {
        const staffBand = system.staves[cell.staffIndex];
        if (!staffBand) continue;

        // Phase 1 context から clef / key を取得
        const clef = context.clefsPerStaff[cell.staffIndex] ?? 'treble';
        const keyFifths = context.initialKeyFifths;

        const result = detectNoteheadsInCell({
          pageImage,
          cell,
          staffBand,
          clef,
          keyFifths,
        });

        results.set(cell, result);
      }
    }
  }

  return results;
}

// ============================================================
// 内部: Phase 4 (LLM fallback)
// ============================================================

async function runPhase4(
  base64Pages: Array<{ base64: string; mediaType: 'image/png' }>,
  assembleResult: PdfHideAssembleResult,
  context: PdfHideScoreContext,
  callLlm: CallLlmFn,
): Promise<{
  overrides: PdfHideFallbackCellOverride[];
  correctedSource: string | null;
}> {
  const allOverrides: PdfHideFallbackCellOverride[] = [];

  // Group low-confidence cells by page
  const cellsByPage = new Map<number, typeof assembleResult.lowConfidenceCells>();
  for (const cell of assembleResult.lowConfidenceCells) {
    const pageIndex = cell.pageIndex;
    if (!cellsByPage.has(pageIndex)) cellsByPage.set(pageIndex, []);
    cellsByPage.get(pageIndex)!.push(cell);
  }

  // Per-page LLM fallback (can be parallelized by consumer)
  for (const [pageIndex, cells] of cellsByPage) {
    const pageBase64 = base64Pages[pageIndex];
    if (!pageBase64) continue;

    const prompt = buildPdfHideLlmFallbackPrompt({
      pageImage: {
        base64: pageBase64.base64,
        mediaType: pageBase64.mediaType,
        pageNumber: pageIndex + 1,
      },
      draftHideSourceForPage: assembleResult.hideSource,
      lowConfidenceCells: cells.map(c => ({
        cellId: `p${c.pageIndex}s${c.systemIndex}i${c.staffIndex}m${c.measureIndex}`,
        partLabel: c.partLabel,
        globalMeasureIndex: c.globalMeasureIndex,
        confidence: c.confidence as 'mid' | 'low' | 'unknown',
      })),
      context: {
        clef: context.clefsPerStaff[0] ?? 'treble',
        timeSignature: {
          numerator: context.initialTimeSignature.numerator,
          denominator: context.initialTimeSignature.denominator,
        },
        keyFifths: context.initialKeyFifths,
        div: 32,
      },
    });

    const responseText = await callLlm({
      systemPrompt: prompt.systemPrompt,
      userContent: prompt.userContent,
      maxTokens: 4096,
    });

    const cellIds = cells.map(
      c => `p${c.pageIndex}s${c.systemIndex}i${c.staffIndex}m${c.measureIndex}`,
    );
    const result = applyPdfHideLlmFallbackResponse({
      llmResponse: responseText,
      expectedCellIds: cellIds,
    });

    allOverrides.push(...result.cellOverrides);
  }

  // Apply overrides to hideSource
  if (allOverrides.length === 0) {
    return { overrides: [], correctedSource: null };
  }

  let corrected = assembleResult.hideSource;
  for (const override of allOverrides) {
    // Replace inline comment markers with corrected tokens
    // Format: ";level:cellId" → corrected tokens
    const commentPattern = new RegExp(
      `;[a-z]+:${escapeRegex(override.cellId)}\\b[^\\n]*`,
      'g',
    );
    corrected = corrected.replace(commentPattern, override.tokens);
  }

  return { overrides: allOverrides, correctedSource: corrected };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
