/**
 * pdfToHide.ts — PDF → .hide ワンショット API
 *
 * 3 フェーズ pipeline:
 *   Phase 1: Audiveris CLI (PDF → MusicXML)
 *   Phase 2: musicXmlToHide (MusicXML → draft .hide)
 *   Phase 3: LLM レビュー (draft .hide + PDF画像 → 校正済み .hide)
 *
 * 依存: Audiveris (システムインストール), pdfjs-dist (画像化), @anthropic-ai/sdk (LLM)
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runAudiveris } from './pdfHideAudiveris';
import { musicXmlToHide } from './musicXmlToHide';
import type { MusicXmlToHideDiagnostic } from './musicXmlToHide';
import { pdfToImages } from './pdfToImages';
import { reviewHideWithLlm } from './pdfHideLlmReview';
import type { LlmReviewResult } from './pdfHideLlmReview';
import { createClaudeCaller } from './pdfHideLlm';
import type { PdfHideLlmOptions } from './pdfHideLlm';

// ============================================================
// 公開型
// ============================================================

export interface PdfToHideOptions {
  /** Audiveris のパス (省略時は自動検出) */
  audiverisPath?: string;
  /** Audiveris タイムアウト ms (default: 600000 = 10分) */
  audiverisTimeout?: number;
  /** LLM 設定 (API key, model, カスタム callLlm) */
  llm?: PdfHideLlmOptions;
  /** LLM レビューを有効にするか (default: true) */
  enableLlmReview?: boolean;
  /** LLM に送る最大ページ数 (default: 8) */
  llmMaxPages?: number;
  /** PDF→画像の DPI (default: 150) */
  dpi?: number;
  /** 進捗コールバック */
  onProgress?: (phase: string, detail: string) => void;
}

export interface PdfToHideResult {
  /** 変換済みの .hide ソーステキスト (LLM レビュー後) */
  hideSource: string;
  /** LLM レビュー前の draft .hide */
  draftHideSource: string;
  /** パート数 */
  partsCount: number;
  /** 小節数 */
  measuresCount: number;
  /** 変換中の警告 */
  warnings: string[];
  /** 構造化 diagnostics */
  diagnostics: MusicXmlToHideDiagnostic[];
  /** LLM レビュー結果 (実行時のみ) */
  llmReview: LlmReviewResult | null;
  /** Audiveris の処理ログ */
  audiverisLog: string;
  /** 中間生成物の MusicXML テキスト (デバッグ用) */
  musicXml: string;
  /** ページ数 */
  pageCount: number;
}

// ============================================================
// 公開API
// ============================================================

/**
 * PDF ファイルパスから .hide ソースに変換する。
 */
export async function pdfToHideFromFile(
  pdfPath: string,
  opts: PdfToHideOptions = {},
): Promise<PdfToHideResult> {
  const progress = opts.onProgress ?? (() => {});
  const enableLlmReview = opts.enableLlmReview !== false;

  // ── Phase 1: Audiveris OMR ──
  progress('audiveris', 'Audiveris で PDF を解析中...');
  const { musicXml, log } = await runAudiveris(pdfPath, {
    audiverisPath: opts.audiverisPath,
    timeout: opts.audiverisTimeout,
    onProgress: (detail) => progress('audiveris', detail),
  });

  // ── Phase 2: MusicXML → draft .hide ──
  progress('convert', 'MusicXML → .hide 変換中...');
  const convResult = musicXmlToHide(musicXml);
  const draftHideSource = convResult.hideSource;
  progress('convert', `draft 完了: ${convResult.partsCount} パート, ${convResult.measuresCount} 小節, ${convResult.warnings.length} warnings`);

  // ── Phase 3: LLM レビュー (optional) ──
  let hideSource = draftHideSource;
  let llmReview: LlmReviewResult | null = null;
  let pageCount = 0;

  if (enableLlmReview) {
    progress('render', 'PDF をページ画像に変換中...');
    const pdfData = readFileSync(pdfPath);
    const { base64Pages, pageCount: pc } = await pdfToImages(pdfData, {
      dpi: opts.dpi,
      onPageRendered: (idx, total) => progress('render', `ページ画像 ${idx + 1}/${total}`),
    });
    pageCount = pc;

    progress('llm-review', `LLM で ${convResult.partsCount} パートを校正中...`);
    const callLlm = createClaudeCaller(opts.llm ?? {});

    llmReview = await reviewHideWithLlm({
      draftHideSource,
      base64Pages,
      warnings: convResult.warnings,
      callLlm,
      maxPages: opts.llmMaxPages,
      onProgress: (detail) => progress('llm-review', detail),
    });

    if (llmReview.wasModified) {
      hideSource = llmReview.correctedSource;
      progress('llm-review', 'LLM による修正あり');
    } else {
      progress('llm-review', 'LLM による修正なし');
    }
  }

  progress('done', `完了: ${convResult.partsCount} パート, ${convResult.measuresCount} 小節`);

  return {
    hideSource,
    draftHideSource,
    partsCount: convResult.partsCount,
    measuresCount: convResult.measuresCount,
    warnings: convResult.warnings,
    diagnostics: convResult.diagnostics,
    llmReview,
    audiverisLog: log,
    musicXml,
    pageCount,
  };
}

/**
 * PDF バイナリを .hide ソースに変換する。
 */
export async function pdfToHide(
  pdfData: ArrayBuffer | Uint8Array,
  opts: PdfToHideOptions = {},
): Promise<PdfToHideResult> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'hide-pdf-'));
  const tmpPath = join(tmpDir, 'input.pdf');
  const bytes = pdfData instanceof ArrayBuffer
    ? new Uint8Array(pdfData)
    : pdfData;
  writeFileSync(tmpPath, bytes);

  try {
    return await pdfToHideFromFile(tmpPath, opts);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
