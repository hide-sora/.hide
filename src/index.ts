/**
 * .hide language — main entry point.
 *
 * 公開 API:
 *   compileHide(source, opts)          → MusicXML 文字列 + warnings   (stream mode, v1.8)
 *   analyzeMatrix(source)              → grid-aligned matrix          (matrix mode, v1.9)
 *   iterateMeasures(matrix)            → 時間整列した小節イテレータ
 *   measureToChord(matrix, measure)    → ある時刻の全鳴音 (HidePitch[])
 *   classifyChord(pitches)             → triad/seventh コード分類
 *   classifyMatrixMeasures(matrix)     → 各小節の ChordLabel 配列
 *   analyzeVoiceLeading(matrix)        → 声部進行 caution observation (descriptive、禁則ではない)
 *   musicXmlToHide(xml, opts)          → MusicXML → .hide 逆変換 + 構造化 diagnostics
 *
 *   === v1.10 PDF→.hide pipeline (Audiveris OMR + musicXmlToHide) ===
 *   pdfToHide(pdfData, opts)             → PDF → Audiveris → MusicXML → .hide
 *   pdfToHideFromFile(path, opts)        → 同上 (ファイルパス版)
 *   runAudiveris(pdfPath, opts)          → Audiveris CLI wrapper (PDF → MusicXML)
 *
 *   === 低レベル画像処理 / OMR モジュール (experimental) ===
 *   buildPdfHideMetaPrompt / applyPdfHideMetaResponse — LLM 構造解析
 *   extractPageLayout — 五線/小節線の幾何検出
 *   detectNoteheadsInCell — テンプレートマッチ符頭検出
 *   assemblePdfHide — assembly + diagnostic emit
 *   buildPdfHideLlmFallbackPrompt / applyPdfHideLlmFallbackResponse — LLM fallback
 *
 *   === 低レベル API ===
 *   tokenize(source)                   → 生トークン列
 *   parse(lex)                         → AST
 *   expand(ast)                        → パート分離・反復展開済み AST
 *   astToMusicXML(ast, opts)           → MusicXML
 *
 * 詳細仕様は README.md (priority paper v1.8 + v1.9 + v1.10) を参照。
 */

export { compileHide, isHideFileName, HideParseError } from './hideLoader';
export type { HideCompileOptions, HideCompileResult } from './hideLoader';

// v1.9 matrix mode (multi-voice grid analysis)
export {
  analyzeMatrix,
  analyzeMatrixFromLex,
  iterateMeasures,
  measureToChord,
} from './hideMatrix';
export type {
  HideMatrix,
  HideMatrixCell,
  HideMatrixMeasure,
  HideMatrixIssue,
  HideMatrixIssueKind,
  HideMatrixResult,
} from './hideMatrix';

// v1.9 chord 分類レイヤー (matrix mode 上の高レベル consumer)
export {
  classifyChord,
  classifyMatrixMeasures,
} from './hideChord';
export type {
  ChordLabel,
  ChordQuality,
} from './hideChord';

// v1.9 声部進行解析レイヤー (descriptive: 古典和声の caution を浮上させる、禁則ではない)
export { analyzeVoiceLeading } from './hideVoiceLeading';
export type {
  VoiceLeadingAnalysis,
  VoiceLeadingTransition,
  VoiceLeadingObservation,
  VoiceLeadingObservationKind,
} from './hideVoiceLeading';

// v1.9 MusicXML → .hide 逆変換 (Bach corpus 取り込み + LLM レビュー pipeline)
export { musicXmlToHide } from './musicXmlToHide';
export type {
  MusicXmlToHideOptions,
  MusicXmlToHideResult,
  MusicXmlToHideDiagnostic,
} from './musicXmlToHide';

// ============================================================
// v1.10 PDF→.hide pipeline (Plan H: 適材適所 hybrid + 100% 優先)
// ============================================================

// 画像基盤 (pure TS, 依存ゼロ. DOM ImageData と構造的互換)
export {
  toGrayscale,
  binarize,
  horizontalProjection,
  verticalProjectionBand,
  cropImage,
  connectedComponents,
} from './pdfHideImage';
export type {
  PdfHideImage,
  Box,
  Component,
} from './pdfHideImage';

// Phase 1: LLM Vision 全曲構造解析 (タイトル/編成/拍子/調/全小節数/歌詞 等)
export {
  buildPdfHideMetaPrompt,
  applyPdfHideMetaResponse,
} from './pdfHideMeta';
export type {
  PdfHideMetaImage,
  PdfHideMetaContentBlock,
  PdfHideMetaPieceHint,
  PdfHideMetaInput,
  PdfHideMetaSummary,
  PdfHideMetaPrompt,
  PdfHideMetaApplyInput,
  PdfHideMetaApplyResult,
  PdfHideScoreContext,
  PdfHideStaffRole,
  PdfHideClefName,
  PdfHideTimeSignature,
  PdfHideKeyChange,
  PdfHideTimeChange,
  PdfHideRepeatSpan,
  PdfHideTempoMark,
  PdfHideRehearsalMark,
  PdfHideSectionLabel,
  PdfHideChordSymbol,
  PdfHideLyricRow,
  PdfHideLyrics,
} from './pdfHideMeta';

// Phase 2a: 古典 OMR レイアウト検出 (staff/system/cell 幾何)
export { extractPageLayout } from './pdfHideLayout';
export type {
  StaffBand,
  SystemLayout,
  CellBox,
  LayoutWarning,
  PageLayout,
  ExtractLayoutInput,
  PdfHideLayoutOptions,
} from './pdfHideLayout';

// Phase 2b: 古典 OMR notehead 検出 (SMuFL/Bravura テンプレマッチ + confidence)
export { detectNoteheadsInCell } from './pdfHideNotehead';
export type {
  NoteheadKind,
  StemDirection,
  PitchLetter,
  Notehead,
  NoteheadWarning,
  NoteheadDetectionInput,
  NoteheadDetectionOptions,
  NoteheadDetectionResult,
} from './pdfHideNotehead';

// Phase 3: assembly + diagnostic emit (silent fill 禁止)
export { assemblePdfHide } from './pdfHideAssemble';
export type {
  CellConfidence,
  PdfHideDiagnostic,
  PdfHideCellConfidenceEntry,
  PdfHideLowConfidenceCellId,
  AssemblePdfHideInput,
  AssemblePdfHideOptions,
  PdfHideAssembleResult,
} from './pdfHideAssemble';

// Phase 4: LLM 低信頼セル補完 (通常フローの一部、低信頼セルがあれば走らせる)
export {
  buildPdfHideLlmFallbackPrompt,
  applyPdfHideLlmFallbackResponse,
} from './pdfHideLlmFallback';
export type {
  PdfHideFallbackImage,
  PdfHideFallbackContentBlock,
  PdfHideFallbackContext,
  PdfHideLowConfidenceCellRef,
  PdfHideLlmFallbackInput,
  PdfHideLlmFallbackSummary,
  PdfHideLlmFallbackPrompt,
  PdfHideLlmFallbackApplyInput,
  PdfHideFallbackCellOverride,
  PdfHideFallbackUnresolvedItem,
  PdfHideLlmFallbackApplyResult,
} from './pdfHideLlmFallback';

// ============================================================
// End-to-end PDF→.hide (Audiveris OMR → musicXmlToHide)
// ============================================================

export { pdfToHide, pdfToHideFromFile } from './pdfToHide';
export type { PdfToHideOptions, PdfToHideResult } from './pdfToHide';

// Audiveris CLI wrapper
export { runAudiveris } from './pdfHideAudiveris';
export type { AudiverisOptions, AudiverisResult } from './pdfHideAudiveris';

// LLM レビュー (draft .hide + PDF画像 → 校正)
export { reviewHideWithLlm } from './pdfHideLlmReview';
export type { LlmReviewInput, LlmReviewResult } from './pdfHideLlmReview';

// PDF→画像変換
export { pdfToImages, pdfToImagesFromFile } from './pdfToImages';
export type { PdfToImagesOptions, PdfToImagesResult } from './pdfToImages';

// LLM 接続レイヤー
export { createClaudeCaller } from './pdfHideLlm';
export type { CallLlmFn, CallLlmInput, PdfHideLlmOptions } from './pdfHideLlm';

// v1.9 ハモリ提案 LLM プロンプト構築層 (matrix mode の生成タスク向け consumer)
export { buildHamoringSuggestPrompt } from './hideHamoringSuggest';
export type {
  HamoringSuggestPrompt,
  HamoringSuggestInput,
  HamoringSuggestTask,
  HamoringContentBlock,
  HamoringSuggestSummary,
  HamoringPieceContext,
} from './hideHamoringSuggest';

// ============================================================
// 低レベル API (LSP / 解析ツール / カスタム pipeline 用)
// ============================================================
export { tokenize } from './hideLexer';
export type { HideLexResult, HideRawToken, HideBarlineRawToken } from './hideLexer';
export { parse } from './hideParser';
export type { HideParseResult } from './hideParser';
export { expand } from './hideExpander';
export type { HideExpandResult } from './hideExpander';
export { astToMusicXML, partitionedAstToMusicXML } from './hideToMusicXML';

// 型定義
export type {
  HideAst,
  HideHeader,
  HideClef,
  HideToken,
  HideNoteToken,
  HideRestToken,
  HideMetaToken,
  HideRepeatGroup,
  HideTupletGroup,
  HideTupletMemberInfo,
  HidePitch,
  HideUnit,
  HidePart,
  HidePartitionedAst,
  PartMeta,
} from './hideTypes';

export {
  HIDE_HEADER_DEFAULT,
  LENGTH_ALIAS_TO_UNITS,
  NOTE_STEP_NORMALIZE,
  PART_LABEL_META,
  getLengthUnits,
  getPartMeta,
} from './hideTypes';

export type { HideSourcePosition } from './hideErrors';
export { offsetToPosition } from './hideErrors';
