/**
 * pdfHideMeta.ts — PDF→.hide pipeline Phase 1: 全曲構造解析 (LLM Vision 1 ショット)
 *
 * Phase 1 は古典 OMR が苦手な領域 (全曲構造 / 歌詞 / コード / メタ情報) を LLM Vision で
 * 1 ショット読みする層。
 *
 * 入力:
 *   1. `pageImages: PdfHideMetaImage[]` — 全ページ画像 (base64)。
 *      全ページ送る理由は、転調・繰り返し・拍子変更・テンポ変化を取り逃さないため。
 *   2. `pieceHint?` — タイトル・作曲者などのグラウンディング (任意)
 *   3. `additionalInstructions?` — タスク固有の追加指示 (任意)
 *
 * 出力:
 *   - `buildPdfHideMetaPrompt(input)` → `PdfHideMetaPrompt` (Anthropic 風 multimodal prompt)
 *   - LLM 応答を `applyPdfHideMetaResponse({ llmResponse })` に流すと
 *     `PdfHideScoreContext` (parse 済み + validate 済み) または `parseError` が返る
 *
 * 設計:
 *   - silent fill 禁止。LLM が確信を持てない optional field は null/省略してよい
 *   - 必須 field が欠けたら `parseError` で fail (silent fallback しない)
 *   - 出力は ` ```json ... ``` ` フェンスブロック 1 つに固定
 *   - `PdfHideScoreContext` の必須 field は Phase 2a (`pdfHideLayout.ts`) と Phase 3
 *     (`pdfHideAssemble.ts`) が strict に依存するため厳格に validate する
 *   - 任意 field は型不整合で warn-and-drop (互換性のため)
 */

// ============================================================
// 公開型: 入力 / プロンプト
// ============================================================

/**
 * 1 ページ画像。`mediaType` はカメルケース (内部入力フォーマット)。
 * Anthropic wire format (`media_type` snake_case) に変換するのは
 * `interleaveSectionsAndImages` の責務。
 */
export interface PdfHideMetaImage {
  /** Base64 エンコードされた画像データ (`data:` プレフィックス無し) */
  base64: string;
  /** MIME タイプ */
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** 1-based ページ番号 (任意、グラウンディング用) */
  pageNumber?: number;
  /** ページラベル (任意、例: "page 1") */
  label?: string;
}

/**
 * Anthropic API 風 multimodal content block.
 * フィールド名は Anthropic Messages API の wire format に揃えており、
 * `messages[0].content` にそのまま投入できる。
 */
export type PdfHideMetaContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    };

/** 楽曲メタデータのグラウンディング (任意、LLM が画像と矛盾するときは画像優先) */
export interface PdfHideMetaPieceHint {
  title?: string;
  composer?: string;
  arranger?: string;
  /** 自由記述 (例: "アカペラ 4 声 + ピアノ", "歌詞は日本語と英語の 2 段") */
  notes?: string;
}

/** プロンプト構築の入力 */
export interface PdfHideMetaInput {
  /**
   * 全ページ画像 (1 ページ以上、配列順序がそのまま LLM への提示順序)。
   * 全曲構造解析のため、原則として **全ページ送る**。
   */
  pageImages: PdfHideMetaImage[];
  /** 任意: 楽曲メタデータヒント */
  pieceHint?: PdfHideMetaPieceHint;
  /** 任意: タスク固有の追加指示 */
  additionalInstructions?: string;
}

/** 集計情報 (UI / ログ向け) */
export interface PdfHideMetaSummary {
  imageCount: number;
  hasPieceHint: boolean;
  hasAdditionalInstructions: boolean;
}

/** プロンプト構築結果 */
export interface PdfHideMetaPrompt {
  /** Provider-agnostic system instruction */
  systemPrompt: string;
  /** Anthropic 風 user message content (drop directly into `messages[0].content`) */
  userContent: PdfHideMetaContentBlock[];
  /** テキストのみのフラット表現 (非マルチモーダル / デバッグログ用) */
  textOnlyPrompt: string;
  /** UI / ログ向け集計 */
  summary: PdfHideMetaSummary;
}

// ============================================================
// 公開型: PdfHideScoreContext (LLM 応答の parsed 形)
// ============================================================

/** 1 staff の役割 */
export type PdfHideStaffRole = 'voice' | 'piano-treble' | 'piano-bass' | 'percussion';

/**
 * Clef 名 (string で受けて consumer 側で normalize する想定).
 * 主要値: 'TREBLE' | 'BASS' | 'ALTO' | 'TENOR' | 'SOPRANO' | 'MEZZO'
 *        | 'TREBLE_8VA' | 'TREBLE_8VB' | 'BASS_8VA' | 'BASS_8VB'
 *        | 'PERCUSSION'
 */
export type PdfHideClefName = string;

/** 拍子 */
export interface PdfHideTimeSignature {
  numerator: number;
  denominator: number;
}

/** 転調 */
export interface PdfHideKeyChange {
  /** 0-indexed measure 番号 (pickup を 0 とする) */
  measureIndex: number;
  /** 新しい fifths (-7..+7) */
  fifths: number;
}

/** 拍子変更 */
export interface PdfHideTimeChange {
  measureIndex: number;
  numerator: number;
  denominator: number;
}

/** 反復構造 1 ペア */
export interface PdfHideRepeatSpan {
  /** 0-indexed 開始 measure */
  startMeasure: number;
  /** 0-indexed 終了 measure (inclusive) */
  endMeasure: number;
  /** 'simple' = 通常 :| 反復、'volta1' = 1 回目用 ending、'volta2' = 2 回目用 ending */
  kind: 'simple' | 'volta1' | 'volta2';
}

/** テンポ表記 */
export interface PdfHideTempoMark {
  measureIndex: number;
  /** "Allegro", "rit.", "a tempo", など */
  marking: string;
  /** 数値 BPM (任意) */
  bpm?: number;
}

/** 練習番号 / リハーサルマーク */
export interface PdfHideRehearsalMark {
  measureIndex: number;
  label: string;
}

/** セクションラベル (Verse / Chorus 等) */
export interface PdfHideSectionLabel {
  measureIndex: number;
  label: string;
}

/** コードシンボル (staff 上の文字) */
export interface PdfHideChordSymbol {
  measureIndex: number;
  /** 拍位置 (0-indexed、float、任意) */
  beat?: number;
  /** どの staff の上にあるか (0-indexed、任意) */
  staffIndex?: number;
  /** "C", "Am", "G7", "Cmaj7", "D/F#" など */
  text: string;
}

/** 歌詞 1 段 */
export interface PdfHideLyricRow {
  /** 段 index (0-indexed、0 = 1 番) */
  rowIndex: number;
  /** 言語ヒント (任意、例: "ja", "en") */
  language?: string;
  /** どの staff に紐付くか (0-indexed、未指定 = 全 voice 共有) */
  attachedStaffIndex?: number;
  /** 全文 (空白区切り、人間目視用) */
  text: string;
}

/** 歌詞構造全体 */
export interface PdfHideLyrics {
  rows: PdfHideLyricRow[];
}

/**
 * Phase 1 LLM 全曲構造解析の出力. Phase 2a (`pdfHideLayout.ts`) と Phase 3
 * (`pdfHideAssemble.ts`) がここから必要な情報を読む。
 *
 * 必須フィールドは strict validate される (欠けたら `parseError`)。
 * 任意フィールドは型不整合で warn-and-drop。
 */
export interface PdfHideScoreContext {
  // === 編成情報 (必須) ===
  /** 声楽パート数 (1 以上) */
  voicePartsCount: number;
  /** ピアノ大譜表があるか */
  hasPiano: boolean;
  /** パーカッションパート (× notehead / ボイスパーカッション) があるか */
  hasPercussion: boolean;
  /** 1 system あたりの 5 線譜総数 = voicePartsCount + (hasPiano?2:0) + (hasPercussion?1:0) */
  stavesPerSystem: number;
  /** stavesPerSystem 個の役割 (上→下) */
  staffRoles: PdfHideStaffRole[];

  // === 基本情報 (必須) ===
  /** stavesPerSystem 個の音部記号 (上→下) */
  clefsPerStaff: PdfHideClefName[];
  /** 初期拍子 */
  initialTimeSignature: PdfHideTimeSignature;
  /** 初期調 (-7..+7) */
  initialKeyFifths: number;
  /** 歌詞段数 (歌詞無しなら 0) */
  lyricsRows: number;
  /** 全小節数 */
  totalMeasures: number;

  // === メタ情報 (任意) ===
  title?: string;
  composer?: string;
  arranger?: string;
  translator?: string;
  copyright?: string;

  // === 全曲構造 (任意) ===
  keyChanges?: PdfHideKeyChange[];
  timeChanges?: PdfHideTimeChange[];
  repeatStructure?: PdfHideRepeatSpan[];
  tempoMarks?: PdfHideTempoMark[];

  // === ナビゲーション (任意) ===
  rehearsalMarks?: PdfHideRehearsalMark[];
  sectionLabels?: PdfHideSectionLabel[];

  // === 表層 (任意) ===
  chordSymbols?: PdfHideChordSymbol[];
  lyrics?: PdfHideLyrics;
}

// ============================================================
// 公開型: apply layer
// ============================================================

/** `applyPdfHideMetaResponse` の入力 */
export interface PdfHideMetaApplyInput {
  /** LLM の生応答テキスト */
  llmResponse: string;
}

/** `applyPdfHideMetaResponse` の結果 */
export interface PdfHideMetaApplyResult {
  /** 正常に parse + validate できたら set される */
  context?: PdfHideScoreContext;
  /** 致命エラー時の理由 (この場合 `context` は undefined) */
  parseError?: string;
  /** 非致命警告 (例: 任意フィールドの型が合わなくて drop した) */
  warnings: string[];
  /** 抽出された生 JSON 文字列 (debug 用、抽出失敗時 undefined) */
  rawJson?: string;
}

// ============================================================
// 公開API: prompt builder
// ============================================================

/**
 * 全ページ画像 + ヒントから Phase 1 LLM 全曲構造解析用プロンプトを構築する。
 *
 * @example
 *   const prompt = buildPdfHideMetaPrompt({
 *     pageImages: [
 *       { mediaType: 'image/png', base64: page1Base64, pageNumber: 1 },
 *       { mediaType: 'image/png', base64: page2Base64, pageNumber: 2 },
 *     ],
 *     pieceHint: { title: 'My Arrangement', composer: 'arr. me' },
 *   });
 *   const resp = await anthropic.messages.create({
 *     model: 'claude-opus-4-6',
 *     max_tokens: 4096,
 *     system: prompt.systemPrompt,
 *     messages: [{ role: 'user', content: prompt.userContent }],
 *   });
 *   const meta = applyPdfHideMetaResponse({ llmResponse: resp.content[0].text });
 */
export function buildPdfHideMetaPrompt(input: PdfHideMetaInput): PdfHideMetaPrompt {
  const pageImages = input.pageImages ?? [];
  const systemPrompt = buildSystemPrompt();
  const sections = buildUserSections(input);
  const userContent = interleaveSectionsAndImages(sections, pageImages);
  const textOnlyPrompt = buildTextOnlyPrompt(sections, pageImages);
  const summary: PdfHideMetaSummary = {
    imageCount: pageImages.length,
    hasPieceHint: hasPieceHint(input.pieceHint),
    hasAdditionalInstructions:
      input.additionalInstructions !== undefined &&
      input.additionalInstructions.trim() !== '',
  };
  return { systemPrompt, userContent, textOnlyPrompt, summary };
}

// ============================================================
// 公開API: apply layer
// ============================================================

/**
 * LLM 応答テキストから ` ```json ... ``` ` ブロックを抽出し、
 * `PdfHideScoreContext` に validate する。
 *
 * 必須フィールドが 1 つでも欠けたら `parseError` で fail。
 * 任意フィールドの型不整合は `warnings` に積みつつドロップ。
 */
export function applyPdfHideMetaResponse(
  input: PdfHideMetaApplyInput,
): PdfHideMetaApplyResult {
  const warnings: string[] = [];

  const rawJson = extractJsonBlock(input.llmResponse);
  if (rawJson === null) {
    return {
      parseError: '応答に ```json ... ``` ブロックが見つかりません',
      warnings,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    return {
      parseError: `JSON parse 失敗: ${e instanceof Error ? e.message : String(e)}`,
      warnings,
      rawJson,
    };
  }

  if (!isRecord(parsed)) {
    return {
      parseError: 'JSON のトップレベルがオブジェクトではありません',
      warnings,
      rawJson,
    };
  }

  const validation = validateScoreContext(parsed, warnings);
  if ('parseError' in validation) {
    return { parseError: validation.parseError, warnings, rawJson };
  }

  return { context: validation.context, warnings, rawJson };
}

// ============================================================
// 内部: system prompt
// ============================================================

function buildSystemPrompt(): string {
  return `あなたはアカペラ楽譜の構造解析エンジニアです。渡された全ページの画像から、楽曲全体のメタ情報・編成・全曲進行構造・歌詞・コードを 1 つの JSON として抽出します。

**重要な前提**:
- 画像が真の source-of-truth。推測や既知曲からの補完は禁止です。
- 確信が持てない optional フィールドは null か省略して構いません。**必須フィールドだけは必ず埋めてください**。
- データは **1 つの \`\`\`json ... \`\`\` フェンスブロック** に入れてください。ブロックの前後には自由記述で構いません (概要・注意点など)。
- 小節番号 (\`measureIndex\`) は **0-indexed** で、pickup (アウフタクト) も 1 小節として 0 と数えてください。

**必須フィールド** (これが欠けたら出力は無効):
- \`voicePartsCount\` (number, ≥1): 声楽パート数 (例: SATB なら 4)
- \`hasPiano\` (boolean): ピアノ大譜表 (= treble + bass の 2 staves) があるか
- \`hasPercussion\` (boolean): パーカッションパート (× notehead / ボイスパーカッション含む) があるか
- \`stavesPerSystem\` (number, ≥1): 1 system あたりの 5 線譜総数 (= voicePartsCount + (hasPiano ? 2 : 0) + (hasPercussion ? 1 : 0))
- \`staffRoles\` (string[], length === stavesPerSystem): 上から下への staff 役割。各要素は "voice" / "piano-treble" / "piano-bass" / "percussion" のいずれか
- \`clefsPerStaff\` (string[], length === stavesPerSystem): 上から下への音部記号。"TREBLE" / "BASS" / "ALTO" / "TENOR" / "SOPRANO" / "MEZZO" / "TREBLE_8VA" / "TREBLE_8VB" / "BASS_8VA" / "BASS_8VB" / "PERCUSSION"
- \`initialTimeSignature\`: { "numerator": number, "denominator": number }
- \`initialKeyFifths\` (integer, -7..+7): 初期調。positive = #、negative = ♭
- \`lyricsRows\` (integer, ≥0): 歌詞段数 (歌詞無しなら 0)
- \`totalMeasures\` (integer, ≥1): 全小節数

**任意フィールド** (確信があるときだけ埋める):
- \`title\`, \`composer\`, \`arranger\`, \`translator\`, \`copyright\` (string)
- \`keyChanges\`: \`[{ "measureIndex": int, "fifths": int }]\` 転調位置
- \`timeChanges\`: \`[{ "measureIndex": int, "numerator": int, "denominator": int }]\` 拍子変更位置
- \`repeatStructure\`: \`[{ "startMeasure": int, "endMeasure": int, "kind": "simple" | "volta1" | "volta2" }]\`
- \`tempoMarks\`: \`[{ "measureIndex": int, "marking": string, "bpm"?: number }]\` (例: "Allegro", "rit.", "a tempo")
- \`rehearsalMarks\`: \`[{ "measureIndex": int, "label": string }]\` (例: 練習番号 A/B/C)
- \`sectionLabels\`: \`[{ "measureIndex": int, "label": string }]\` (例: "Verse 1", "Chorus")
- \`chordSymbols\`: \`[{ "measureIndex": int, "beat"?: number, "staffIndex"?: int, "text": string }]\` (例: "C", "Am", "G7", "Cmaj7", "D/F#")
- \`lyrics\`: \`{ "rows": [{ "rowIndex": int, "language"?: string, "attachedStaffIndex"?: int, "text": string }] }\`

**出力フォーマット (厳守)**:
1. 先頭: 数行の概要 (例: "4 声アカペラ + ピアノ、F メジャー、4/4 拍子、16 小節、歌詞 1 段 (日本語)")
2. その直後に 1 つの \`\`\`json ... \`\`\` ブロック (上記スキーマ)
3. 必要に応じてブロックの後に補足コメント (任意)

判別不能な楽譜・写真・スキャン等で抽出が困難な場合は、必須フィールドだけを最良推定で埋めて補足コメントに「精度低 (画像不鮮明)」等を明記してください。**推測で欠落フィールドを埋めるのは禁止です** — どうしても判別不能なら必須フィールドにも null 等のプレースホルダを置かず、その時点で応答を打ち切って理由を書いてください。`;
}

// ============================================================
// 内部: user content sections
// ============================================================

interface UserSection {
  id: string;
  text: string;
}

function buildUserSections(input: PdfHideMetaInput): UserSection[] {
  const sections: UserSection[] = [];
  const ctx = input.pieceHint;
  if (hasPieceHint(ctx)) {
    const lines: string[] = ['## 楽曲ヒント (任意、画像と矛盾するときは画像優先)'];
    if (ctx?.title) lines.push(`- title: ${ctx.title}`);
    if (ctx?.composer) lines.push(`- composer: ${ctx.composer}`);
    if (ctx?.arranger) lines.push(`- arranger: ${ctx.arranger}`);
    if (ctx?.notes) lines.push(`- notes: ${ctx.notes}`);
    sections.push({ id: 'pieceHint', text: lines.join('\n') });
  }

  const imageCount = input.pageImages?.length ?? 0;
  sections.push({
    id: 'imagesIntro',
    text:
      imageCount > 0
        ? `## 楽譜画像 (${imageCount} ページ、ページ番号順)`
        : '## 楽譜画像 (なし — 画像が渡されていません)',
  });

  // 画像はここに interleave される (interleaveSectionsAndImages 参照)

  const instructionLines: string[] = [
    '## 抽出指示',
    '上記の全ページ画像を全曲通して観察し、システムプロンプトに記載のスキーマに従って **1 つの ```json ... ``` ブロック** を出力してください。',
    '- 必須フィールドは絶対に省略しないでください。',
    '- 任意フィールドは確信が持てるものだけ埋めてください。',
    '- 全ページを通読し、転調・繰り返し・拍子変更・テンポ変化を取り逃さないでください。',
  ];
  if (input.additionalInstructions && input.additionalInstructions.trim() !== '') {
    instructionLines.push('', '### 追加指示', input.additionalInstructions.trim());
  }
  sections.push({ id: 'instructions', text: instructionLines.join('\n') });

  return sections;
}

// ============================================================
// 内部: section + image の interleave
// ============================================================

function interleaveSectionsAndImages(
  sections: UserSection[],
  pageImages: PdfHideMetaImage[],
): PdfHideMetaContentBlock[] {
  const out: PdfHideMetaContentBlock[] = [];
  for (const sec of sections) {
    if (sec.id === 'instructions') {
      // 画像の後に instructions を置きたいので、その前に images を flush
      for (const img of pageImages) {
        out.push(imageToBlock(img));
      }
      out.push({ type: 'text', text: sec.text });
    } else {
      out.push({ type: 'text', text: sec.text });
    }
  }
  return out;
}

function imageToBlock(img: PdfHideMetaImage): PdfHideMetaContentBlock {
  return {
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
  };
}

// ============================================================
// 内部: text-only fallback
// ============================================================

function buildTextOnlyPrompt(
  sections: UserSection[],
  pageImages: PdfHideMetaImage[],
): string {
  const parts: string[] = [];
  for (const sec of sections) {
    if (sec.id === 'instructions') {
      // 画像 placeholder
      for (const img of pageImages) {
        const ref =
          img.label ??
          (img.pageNumber !== undefined ? `page ${img.pageNumber}` : 'page');
        parts.push(`[image: ${ref}, ${img.mediaType}, base64 omitted]`);
      }
      parts.push(sec.text);
    } else {
      parts.push(sec.text);
    }
  }
  return parts.join('\n\n');
}

// ============================================================
// 内部: piece hint helper
// ============================================================

function hasPieceHint(ctx: PdfHideMetaPieceHint | undefined): boolean {
  if (!ctx) return false;
  return Boolean(
    (ctx.title && ctx.title.trim() !== '') ||
      (ctx.composer && ctx.composer.trim() !== '') ||
      (ctx.arranger && ctx.arranger.trim() !== '') ||
      (ctx.notes && ctx.notes.trim() !== ''),
  );
}

// ============================================================
// 内部: JSON ブロック抽出
// ============================================================

/**
 * 応答から最初の ` ```json ... ``` ` ブロックを抽出する。
 *
 * 寛容性: language tag は case-insensitive (`json` / `JSON`)、開閉フェンス前後の whitespace を許容。
 * 厳格性: 必ずフェンス内部に改行が必要。fenceless JSON は受理しない。
 */
function extractJsonBlock(response: string): string | null {
  const re = /```[ \t]*json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/i;
  const m = re.exec(response);
  return m ? m[1]! : null;
}

// ============================================================
// 内部: 型ガード
// ============================================================

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isInteger(v: unknown): v is number {
  return isFiniteNumber(v) && Number.isInteger(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

const STAFF_ROLES: ReadonlySet<string> = new Set([
  'voice',
  'piano-treble',
  'piano-bass',
  'percussion',
]);

function isStaffRole(v: unknown): v is PdfHideStaffRole {
  return isString(v) && STAFF_ROLES.has(v);
}

const REPEAT_KINDS: ReadonlySet<string> = new Set(['simple', 'volta1', 'volta2']);

// ============================================================
// 内部: validate 本体
// ============================================================

type ValidateResult =
  | { context: PdfHideScoreContext }
  | { parseError: string };

function validateScoreContext(
  obj: Record<string, unknown>,
  warnings: string[],
): ValidateResult {
  const errors: string[] = [];

  // === 必須 field ===
  const voicePartsCount = obj.voicePartsCount;
  if (!isInteger(voicePartsCount) || voicePartsCount < 1) {
    errors.push('`voicePartsCount` は 1 以上の整数である必要があります');
  }

  const hasPiano = obj.hasPiano;
  if (!isBoolean(hasPiano)) {
    errors.push('`hasPiano` は boolean である必要があります');
  }

  const hasPercussion = obj.hasPercussion;
  if (!isBoolean(hasPercussion)) {
    errors.push('`hasPercussion` は boolean である必要があります');
  }

  const stavesPerSystem = obj.stavesPerSystem;
  if (!isInteger(stavesPerSystem) || stavesPerSystem < 1) {
    errors.push('`stavesPerSystem` は 1 以上の整数である必要があります');
  }

  const staffRolesRaw = obj.staffRoles;
  let staffRoles: PdfHideStaffRole[] | null = null;
  if (!Array.isArray(staffRolesRaw) || !staffRolesRaw.every(isStaffRole)) {
    errors.push(
      '`staffRoles` は ("voice"|"piano-treble"|"piano-bass"|"percussion") の配列である必要があります',
    );
  } else {
    staffRoles = staffRolesRaw as PdfHideStaffRole[];
  }

  const clefsPerStaffRaw = obj.clefsPerStaff;
  let clefsPerStaff: PdfHideClefName[] | null = null;
  if (!isStringArray(clefsPerStaffRaw)) {
    errors.push('`clefsPerStaff` は string の配列である必要があります');
  } else {
    clefsPerStaff = clefsPerStaffRaw;
  }

  // staffRoles / clefsPerStaff の長さは stavesPerSystem に一致するべき
  if (
    staffRoles &&
    isInteger(stavesPerSystem) &&
    staffRoles.length !== stavesPerSystem
  ) {
    errors.push(
      `\`staffRoles\` の長さ ${staffRoles.length} が \`stavesPerSystem\` ${stavesPerSystem} と一致しません`,
    );
  }
  if (
    clefsPerStaff &&
    isInteger(stavesPerSystem) &&
    clefsPerStaff.length !== stavesPerSystem
  ) {
    errors.push(
      `\`clefsPerStaff\` の長さ ${clefsPerStaff.length} が \`stavesPerSystem\` ${stavesPerSystem} と一致しません`,
    );
  }

  const tsRaw = obj.initialTimeSignature;
  let initialTimeSignature: PdfHideTimeSignature | null = null;
  if (
    !isRecord(tsRaw) ||
    !isInteger(tsRaw.numerator) ||
    !isInteger(tsRaw.denominator) ||
    tsRaw.numerator < 1 ||
    tsRaw.denominator < 1
  ) {
    errors.push(
      '`initialTimeSignature` は { numerator: ≥1 int, denominator: ≥1 int } である必要があります',
    );
  } else {
    initialTimeSignature = {
      numerator: tsRaw.numerator,
      denominator: tsRaw.denominator,
    };
  }

  const initialKeyFifths = obj.initialKeyFifths;
  if (
    !isInteger(initialKeyFifths) ||
    initialKeyFifths < -7 ||
    initialKeyFifths > 7
  ) {
    errors.push('`initialKeyFifths` は -7..+7 の整数である必要があります');
  }

  const lyricsRows = obj.lyricsRows;
  if (!isInteger(lyricsRows) || lyricsRows < 0) {
    errors.push('`lyricsRows` は 0 以上の整数である必要があります');
  }

  const totalMeasures = obj.totalMeasures;
  if (!isInteger(totalMeasures) || totalMeasures < 1) {
    errors.push('`totalMeasures` は 1 以上の整数である必要があります');
  }

  if (errors.length > 0) {
    return { parseError: errors.join('; ') };
  }

  // ここまで通れば全必須 field が valid
  const ctx: PdfHideScoreContext = {
    voicePartsCount: voicePartsCount as number,
    hasPiano: hasPiano as boolean,
    hasPercussion: hasPercussion as boolean,
    stavesPerSystem: stavesPerSystem as number,
    staffRoles: staffRoles!,
    clefsPerStaff: clefsPerStaff!,
    initialTimeSignature: initialTimeSignature!,
    initialKeyFifths: initialKeyFifths as number,
    lyricsRows: lyricsRows as number,
    totalMeasures: totalMeasures as number,
  };

  // === 任意 field === (warn-and-drop)
  if (obj.title !== undefined && obj.title !== null) {
    if (isNonEmptyString(obj.title)) ctx.title = obj.title;
    else warnings.push('`title` は string 型ではないため drop しました');
  }
  if (obj.composer !== undefined && obj.composer !== null) {
    if (isNonEmptyString(obj.composer)) ctx.composer = obj.composer;
    else warnings.push('`composer` は string 型ではないため drop しました');
  }
  if (obj.arranger !== undefined && obj.arranger !== null) {
    if (isNonEmptyString(obj.arranger)) ctx.arranger = obj.arranger;
    else warnings.push('`arranger` は string 型ではないため drop しました');
  }
  if (obj.translator !== undefined && obj.translator !== null) {
    if (isNonEmptyString(obj.translator)) ctx.translator = obj.translator;
    else warnings.push('`translator` は string 型ではないため drop しました');
  }
  if (obj.copyright !== undefined && obj.copyright !== null) {
    if (isNonEmptyString(obj.copyright)) ctx.copyright = obj.copyright;
    else warnings.push('`copyright` は string 型ではないため drop しました');
  }

  // keyChanges
  if (obj.keyChanges !== undefined && obj.keyChanges !== null) {
    const arr = parseKeyChanges(obj.keyChanges, warnings);
    if (arr.length > 0) ctx.keyChanges = arr;
  }
  // timeChanges
  if (obj.timeChanges !== undefined && obj.timeChanges !== null) {
    const arr = parseTimeChanges(obj.timeChanges, warnings);
    if (arr.length > 0) ctx.timeChanges = arr;
  }
  // repeatStructure
  if (obj.repeatStructure !== undefined && obj.repeatStructure !== null) {
    const arr = parseRepeatStructure(obj.repeatStructure, warnings);
    if (arr.length > 0) ctx.repeatStructure = arr;
  }
  // tempoMarks
  if (obj.tempoMarks !== undefined && obj.tempoMarks !== null) {
    const arr = parseTempoMarks(obj.tempoMarks, warnings);
    if (arr.length > 0) ctx.tempoMarks = arr;
  }
  // rehearsalMarks
  if (obj.rehearsalMarks !== undefined && obj.rehearsalMarks !== null) {
    const arr = parseLabeledMarks(obj.rehearsalMarks, 'rehearsalMarks', warnings);
    if (arr.length > 0) ctx.rehearsalMarks = arr;
  }
  // sectionLabels
  if (obj.sectionLabels !== undefined && obj.sectionLabels !== null) {
    const arr = parseLabeledMarks(obj.sectionLabels, 'sectionLabels', warnings);
    if (arr.length > 0) ctx.sectionLabels = arr;
  }
  // chordSymbols
  if (obj.chordSymbols !== undefined && obj.chordSymbols !== null) {
    const arr = parseChordSymbols(obj.chordSymbols, warnings);
    if (arr.length > 0) ctx.chordSymbols = arr;
  }
  // lyrics
  if (obj.lyrics !== undefined && obj.lyrics !== null) {
    const ly = parseLyrics(obj.lyrics, warnings);
    if (ly) ctx.lyrics = ly;
  }

  return { context: ctx };
}

function parseKeyChanges(v: unknown, warnings: string[]): PdfHideKeyChange[] {
  if (!Array.isArray(v)) {
    warnings.push('`keyChanges` は配列ではないため drop しました');
    return [];
  }
  const out: PdfHideKeyChange[] = [];
  v.forEach((item, i) => {
    if (
      isRecord(item) &&
      isInteger(item.measureIndex) &&
      item.measureIndex >= 0 &&
      isInteger(item.fifths) &&
      item.fifths >= -7 &&
      item.fifths <= 7
    ) {
      out.push({ measureIndex: item.measureIndex, fifths: item.fifths });
    } else {
      warnings.push(`\`keyChanges[${i}]\` の形式が不正なため drop しました`);
    }
  });
  return out;
}

function parseTimeChanges(v: unknown, warnings: string[]): PdfHideTimeChange[] {
  if (!Array.isArray(v)) {
    warnings.push('`timeChanges` は配列ではないため drop しました');
    return [];
  }
  const out: PdfHideTimeChange[] = [];
  v.forEach((item, i) => {
    if (
      isRecord(item) &&
      isInteger(item.measureIndex) &&
      item.measureIndex >= 0 &&
      isInteger(item.numerator) &&
      item.numerator >= 1 &&
      isInteger(item.denominator) &&
      item.denominator >= 1
    ) {
      out.push({
        measureIndex: item.measureIndex,
        numerator: item.numerator,
        denominator: item.denominator,
      });
    } else {
      warnings.push(`\`timeChanges[${i}]\` の形式が不正なため drop しました`);
    }
  });
  return out;
}

function parseRepeatStructure(
  v: unknown,
  warnings: string[],
): PdfHideRepeatSpan[] {
  if (!Array.isArray(v)) {
    warnings.push('`repeatStructure` は配列ではないため drop しました');
    return [];
  }
  const out: PdfHideRepeatSpan[] = [];
  v.forEach((item, i) => {
    if (
      isRecord(item) &&
      isInteger(item.startMeasure) &&
      item.startMeasure >= 0 &&
      isInteger(item.endMeasure) &&
      item.endMeasure >= item.startMeasure &&
      isString(item.kind) &&
      REPEAT_KINDS.has(item.kind)
    ) {
      out.push({
        startMeasure: item.startMeasure,
        endMeasure: item.endMeasure,
        kind: item.kind as PdfHideRepeatSpan['kind'],
      });
    } else {
      warnings.push(`\`repeatStructure[${i}]\` の形式が不正なため drop しました`);
    }
  });
  return out;
}

function parseTempoMarks(v: unknown, warnings: string[]): PdfHideTempoMark[] {
  if (!Array.isArray(v)) {
    warnings.push('`tempoMarks` は配列ではないため drop しました');
    return [];
  }
  const out: PdfHideTempoMark[] = [];
  v.forEach((item, i) => {
    if (
      isRecord(item) &&
      isInteger(item.measureIndex) &&
      item.measureIndex >= 0 &&
      isNonEmptyString(item.marking)
    ) {
      const tm: PdfHideTempoMark = {
        measureIndex: item.measureIndex,
        marking: item.marking,
      };
      if (isFiniteNumber(item.bpm) && item.bpm > 0) {
        tm.bpm = item.bpm;
      }
      out.push(tm);
    } else {
      warnings.push(`\`tempoMarks[${i}]\` の形式が不正なため drop しました`);
    }
  });
  return out;
}

function parseLabeledMarks(
  v: unknown,
  fieldName: 'rehearsalMarks' | 'sectionLabels',
  warnings: string[],
): PdfHideRehearsalMark[] {
  if (!Array.isArray(v)) {
    warnings.push(`\`${fieldName}\` は配列ではないため drop しました`);
    return [];
  }
  const out: PdfHideRehearsalMark[] = [];
  v.forEach((item, i) => {
    if (
      isRecord(item) &&
      isInteger(item.measureIndex) &&
      item.measureIndex >= 0 &&
      isNonEmptyString(item.label)
    ) {
      out.push({ measureIndex: item.measureIndex, label: item.label });
    } else {
      warnings.push(`\`${fieldName}[${i}]\` の形式が不正なため drop しました`);
    }
  });
  return out;
}

function parseChordSymbols(
  v: unknown,
  warnings: string[],
): PdfHideChordSymbol[] {
  if (!Array.isArray(v)) {
    warnings.push('`chordSymbols` は配列ではないため drop しました');
    return [];
  }
  const out: PdfHideChordSymbol[] = [];
  v.forEach((item, i) => {
    if (
      isRecord(item) &&
      isInteger(item.measureIndex) &&
      item.measureIndex >= 0 &&
      isNonEmptyString(item.text)
    ) {
      const cs: PdfHideChordSymbol = {
        measureIndex: item.measureIndex,
        text: item.text,
      };
      if (isFiniteNumber(item.beat) && item.beat >= 0) cs.beat = item.beat;
      if (isInteger(item.staffIndex) && item.staffIndex >= 0) {
        cs.staffIndex = item.staffIndex;
      }
      out.push(cs);
    } else {
      warnings.push(`\`chordSymbols[${i}]\` の形式が不正なため drop しました`);
    }
  });
  return out;
}

function parseLyrics(v: unknown, warnings: string[]): PdfHideLyrics | null {
  if (!isRecord(v) || !Array.isArray(v.rows)) {
    warnings.push('`lyrics` は { rows: array } である必要があるため drop しました');
    return null;
  }
  const rows: PdfHideLyricRow[] = [];
  v.rows.forEach((item, i) => {
    if (
      isRecord(item) &&
      isInteger(item.rowIndex) &&
      item.rowIndex >= 0 &&
      isString(item.text)
    ) {
      const row: PdfHideLyricRow = {
        rowIndex: item.rowIndex,
        text: item.text,
      };
      if (isNonEmptyString(item.language)) row.language = item.language;
      if (isInteger(item.attachedStaffIndex) && item.attachedStaffIndex >= 0) {
        row.attachedStaffIndex = item.attachedStaffIndex;
      }
      rows.push(row);
    } else {
      warnings.push(`\`lyrics.rows[${i}]\` の形式が不正なため drop しました`);
    }
  });
  if (rows.length === 0) return null;
  return { rows };
}
