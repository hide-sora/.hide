/**
 * .hide language — main entry point.
 *
 * 公開 API:
 *   compileHide(source, opts)         → MusicXML 文字列 + warnings   (stream mode, v1.8)
 *   analyzeMatrix(source)              → grid-aligned matrix         (matrix mode, v1.9)
 *   iterateMeasures(matrix)            → 時間整列した小節イテレータ
 *   measureToChord(matrix, measure)    → ある時刻の全鳴音 (HidePitch[])
 *   classifyChord(pitches)             → triad/seventh コード分類
 *   classifyMatrixMeasures(matrix)     → 各小節の ChordLabel 配列
 *   analyzeVoiceLeading(matrix)        → 声部進行 caution observation (descriptive、禁則ではない)
 *   musicXmlToHide(xml, opts)          → MusicXML → .hide 逆変換 + 構造化 diagnostics
 *   buildLlmReviewPrompt(input)        → 診断 + 画像 + hideSource を LLM プロンプトに組み立て
 *   buildLlmReviewPromptFromResult(r)  → musicXmlToHide の結果からワンステップで prompt
 *   applyLlmReviewResponse(input)      → LLM 応答から修正済み .hide を抽出 + 再検証 + 差分計算
 *   startReviewLoop(input)             → 多ラウンド LLM レビュー state machine の初期化
 *   continueReviewLoop(state, response) → state machine を 1 ラウンド進める
 *   runReviewLoop(input)               → callLlm callback でループを最後まで回す async wrapper
 *   tokenize(source)                   → 生トークン列 (低レベル)
 *   parse(lex)                         → AST (低レベル)
 *   expand(ast)                        → パート分離・反復展開済み AST
 *   astToMusicXML(ast, opts)           → MusicXML (中レベル)
 *
 * 詳細仕様は README.md (priority paper v1.8 + v1.9) を参照。
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

// v1.9 LLM レビュー pipeline 用プロンプト構築層
// (診断 + 画像 + hideSource を 1 つの multimodal prompt に組み立てる)
export {
  buildLlmReviewPrompt,
  buildLlmReviewPromptFromResult,
} from './hideLlmReview';
export type {
  LlmReviewPrompt,
  LlmReviewInput,
  LlmReviewImage,
  LlmReviewContentBlock,
  LlmReviewSummary,
  LlmReviewPieceContext,
} from './hideLlmReview';

// v1.9 LLM レビュー pipeline 用 apply layer
// (LLM 応答テキスト → 修正済み .hide ソース抽出 + 再検証 + 差分計算)
export { applyLlmReviewResponse } from './hideLlmReviewApply';
export type {
  LlmReviewApplyInput,
  LlmReviewApplyResult,
  LlmReviewUnresolvedItem,
  LlmReviewValidation,
  LlmReviewDelta,
  LlmReviewChangedPart,
} from './hideLlmReviewApply';

// v1.9 LLM レビュー pipeline 用ループ層 (multi-round state machine + callback wrapper)
// (1 ラウンドで収束しない場合の反復戦略 + 終了判定)
export {
  startReviewLoop,
  continueReviewLoop,
  runReviewLoop,
  DEFAULT_MAX_ROUNDS,
} from './hideLlmReviewLoop';
export type {
  LlmReviewLoopInput,
  LlmReviewLoopRound,
  LlmReviewLoopState,
  LlmReviewLoopTermination,
  LlmReviewLoopFinalResult,
  RunReviewLoopInput,
} from './hideLlmReviewLoop';

// follow-up context type は prompt builder にあるが loop 層が使うので一緒に export
export type { LlmReviewFollowupContext } from './hideLlmReview';

// v1.9 ハモリ提案 LLM プロンプト構築層 (matrix mode の生成タスク向け consumer)
// (現状 .hide + task → "次の一手" を提案させるための prompt builder。
//  hideLlmReview とは正反対の前提: silent fill OK / ポップ・現代アカペラ /
//  古典和声の禁則は適用しない / 画像は使わない)
export { buildHamoringSuggestPrompt } from './hideHamoringSuggest';
export type {
  HamoringSuggestPrompt,
  HamoringSuggestInput,
  HamoringSuggestTask,
  HamoringContentBlock,
  HamoringSuggestSummary,
  HamoringPieceContext,
} from './hideHamoringSuggest';

// 低レベル API (LSP / 解析ツール / カスタム pipeline 用)
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
