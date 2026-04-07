/**
 * hideLlmReviewApply.ts — v1.9 LLM レビュー pipeline 用 apply layer
 *
 * `hideLlmReview.ts` (= a 部分: prompt builder) と対をなす b 部分。
 * `buildLlmReviewPrompt` が組み立てた multimodal prompt に対する LLM の応答
 * (raw テキスト) を受け取り、修正済み .hide ソースを取り出して再検証する。
 *
 * 入力:
 *   - LLM 応答テキスト (raw) — 修正サマリ + ```hide``` ブロック + UNRESOLVED
 *   - 元の .hide ソース (delta 計算用)
 *
 * 出力 (`LlmReviewApplyResult`):
 *   - 修正済み .hide ソース (`revisedHideSource`、最初のフェンスを採用)
 *   - 修正サマリ (`summaryText`、ブロック前の自由記述)
 *   - UNRESOLVED 項目 (`unresolved`、bullet prefix を除去)
 *   - 再検証結果 (`validation`、`analyzeMatrix` で再パース → 残存 issue)
 *   - 元との差分 (`delta`、line / part レベル)
 *   - apply 自身の警告 (`warnings`、応答 shape の問題)
 *
 * 設計思想:
 *   - **silent fill 禁止** という reverse converter の方針を apply 層でも貫く。
 *     LLM 応答を「無条件に受け入れる」のではなく、必ず `analyzeMatrix` で再
 *     パースして残存 issue を呼び出し側に surface する。
 *   - 「diff merge」は LLM が **全ソースを出力する契約** (system prompt 既定)
 *     なので patch 適用ではなく **replace + 差分レポート**。delta は consumer
 *     が変更箇所を review するための情報源であり、merge そのものは「新ソース
 *     をそのまま新 state とする」モデル。
 *   - LLM 応答の shape (markdown fence の表記揺れ、UNRESOLVED の bullet style)
 *     は不安定なので正規表現は寛容に書く。一方で誤検出を避けるため、
 *     "UNRESOLVED" 系の探索は **fenced block の後** だけを対象にする
 *     (ブロック内のコメントを誤検出しないように)。
 *   - LLM 呼び出しは行わない — pure parser。
 *
 * スコープ外 (将来作業):
 *   - LLM 呼び出しそのもの
 *   - 1 ラウンドでカバーできない場合のループ戦略 (= ロードマップ (c) 部分。
 *     apply 結果の `validation.issues` と `unresolved` を見て次の prompt を組み
 *     立てる層は別ファイルに切る予定)
 *   - 元の `MusicXmlToHideDiagnostic` を「resolved/unresolved」に自動マッピング
 *     する仕組み (LLM の summaryText は free-form なので確実な対応付け不能。
 *     代わりに `validation.issues` を見て「新ソースに残った構造的問題」を消費
 *     側で判断する)
 */

import { analyzeMatrix } from './hideMatrix';
import type { HideMatrixIssue } from './hideMatrix';
import { HideParseError } from './hideErrors';

// ============================================================
// 公開型
// ============================================================

/** apply 層への入力 */
export interface LlmReviewApplyInput {
  /** LLM 応答テキスト (生) */
  llmResponse: string;
  /** 元の .hide ソース。delta 計算に使う */
  originalHideSource: string;
}

/** apply 層の結果 */
export interface LlmReviewApplyResult {
  /** ```hide``` フェンスブロックが少なくとも 1 つ見つかったか */
  hideBlockFound: boolean;
  /** 見つかったブロック数 (>1 のとき warning) */
  hideBlockCount: number;
  /**
   * 修正済み .hide ソース。最初のブロックを採用する。
   * ブロックが見つからなかった場合は `undefined`。
   */
  revisedHideSource?: string;
  /** ```hide``` ブロックより前にあった自由記述テキスト (修正概要) */
  summaryText: string;
  /** UNRESOLVED 項目 (各行 1 項目、bullet prefix 除去済み) */
  unresolved: LlmReviewUnresolvedItem[];
  /** 修正済みソースを `analyzeMatrix` で再検証した結果 */
  validation: LlmReviewValidation;
  /** 元と修正後の差分 */
  delta: LlmReviewDelta;
  /** apply 層自身が検出した警告 (応答 shape の問題) */
  warnings: string[];
}

/** UNRESOLVED ブロックから抽出した 1 項目 */
export interface LlmReviewUnresolvedItem {
  /** Bullet prefix (`-`/`*`/`1.`) を除去した本文 */
  text: string;
  /** 1-based の出現順序 */
  index: number;
}

/** 修正済み .hide ソースの再検証結果 */
export interface LlmReviewValidation {
  /** `analyzeMatrix` が throw せずに解析できたか */
  parsed: boolean;
  /** `parsed=false` のときの parse error メッセージ */
  parseError?: string;
  /** Matrix mode が修正後ソースに見つけた issue (空配列なら clean) */
  issues: HideMatrixIssue[];
  /** issue kind の sorted unique リスト (素早い「残った種別」確認用) */
  issueKinds: string[];
}

/** 元と修正後の差分 */
export interface LlmReviewDelta {
  /** 元と修正後がバイト一致か */
  unchanged: boolean;
  /** 元のライン数 */
  originalLineCount: number;
  /** 修正後のライン数 */
  revisedLineCount: number;
  /** 修正後にあって元にないライン (set 差分、grid form 想定) */
  addedLines: string[];
  /** 元にあって修正後にないライン */
  removedLines: string[];
  /**
   * パートラベル単位の変更詳細。
   * `[1]| ... |` 形式の行を label で対応付けて before/after を返す。
   * 行が完全一致するパートはここに含まれない。
   */
  changedParts: LlmReviewChangedPart[];
}

/** パートラベル単位の差分 1 件 */
export interface LlmReviewChangedPart {
  /** パートラベル (例: "1", "2", "P") */
  label: string;
  /** 元の行 (新規追加されたパートでは undefined) */
  before?: string;
  /** 修正後の行 (削除されたパートでは undefined) */
  after?: string;
}

// ============================================================
// 公開API
// ============================================================

/**
 * LLM レビュー応答を解析して、修正済み .hide ソースを取り出す。
 *
 * @example
 *   // 1. 元の reverse-conversion result から prompt を組み立てる
 *   const result = musicXmlToHide(xml);
 *   const prompt = buildLlmReviewPromptFromResult(result, pageImages, ctx);
 *
 *   // 2. LLM を呼ぶ (apply 層スコープ外)
 *   const msg = await anthropic.messages.create({
 *     model: 'claude-opus-4-6',
 *     system: prompt.systemPrompt,
 *     messages: [{ role: 'user', content: prompt.userContent }],
 *     max_tokens: 4096,
 *   });
 *   const responseText = msg.content
 *     .filter(b => b.type === 'text')
 *     .map(b => b.text).join('\n');
 *
 *   // 3. apply 層で解析
 *   const apply = applyLlmReviewResponse({
 *     llmResponse: responseText,
 *     originalHideSource: result.hideSource,
 *   });
 *
 *   // 4. 受け入れ判定
 *   if (apply.validation.parsed && apply.validation.issues.length === 0) {
 *     // ✓ clean な新 state を採用
 *     finalHideSource = apply.revisedHideSource!;
 *   } else {
 *     // → 次ラウンドの prompt を構築 (= ロードマップ (c))
 *   }
 */
export function applyLlmReviewResponse(
  input: LlmReviewApplyInput,
): LlmReviewApplyResult {
  const warnings: string[] = [];

  // 1. ```hide``` フェンスブロック抽出
  const hideBlocks = extractHideBlocks(input.llmResponse);
  if (hideBlocks.length === 0) {
    warnings.push('LLM 応答に ```hide``` フェンスブロックが見つかりませんでした');
  } else if (hideBlocks.length > 1) {
    warnings.push(
      'LLM 応答に ```hide``` フェンスブロックが ' +
        hideBlocks.length +
        ' 個あります — 最初のものを採用しました',
    );
  }
  const revisedHideSource = hideBlocks.length > 0 ? hideBlocks[0] : undefined;

  // 2. summary text (最初のブロック前のテキスト)
  const summaryText = extractSummaryText(input.llmResponse);

  // 3. UNRESOLVED 抽出 (最初のブロック後のテキストから探す)
  const unresolved = extractUnresolvedItems(input.llmResponse);

  // 4. validation (matrix mode で再パース)
  const validation = validateRevisedSource(revisedHideSource);

  // 5. delta 計算
  const delta = computeDelta(input.originalHideSource, revisedHideSource);
  if (delta.unchanged && hideBlocks.length > 0) {
    warnings.push(
      '修正済み .hide ソースが元のソースとバイト一致です — LLM が変更を加えなかった可能性があります',
    );
  }

  return {
    hideBlockFound: hideBlocks.length > 0,
    hideBlockCount: hideBlocks.length,
    revisedHideSource,
    summaryText,
    unresolved,
    validation,
    delta,
    warnings,
  };
}

// ============================================================
// 内部: fenced block 抽出
// ============================================================

/**
 * 応答から ```hide ... ``` を全て抽出する。
 *
 * 寛容性:
 *   - ` ```hide` の前後の whitespace 許容
 *   - CRLF / LF 両対応
 *   - 閉じフェンス前後の whitespace 許容
 *
 * 厳格性:
 *   - **language tag は `hide` のみ** — `python` / `text` / 無印は無視
 *   - 開閉フェンスの間に必ず改行が必要 (one-line ` ```hide foo``` ` は捨てる)
 */
function extractHideBlocks(response: string): string[] {
  const blocks: string[] = [];
  // ` ``` ` の後 word boundary つきで `hide`、行末まで何でも、
  // 改行、内容 (non-greedy)、改行、` ``` ` の後行末まで
  const re = /```[ \t]*hide[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(response)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

// ============================================================
// 内部: summary 抽出
// ============================================================

/**
 * 最初の ```hide``` ブロックより前のテキストを修正サマリとして返す。
 * ブロックがない場合は UNRESOLVED より前 (or 全文) を返す。
 */
function extractSummaryText(response: string): string {
  const m = /```[ \t]*hide[ \t]*\r?\n/.exec(response);
  if (m) {
    return response.slice(0, m.index).trim();
  }
  // ブロックがない場合: UNRESOLVED より前を summary とみなす
  const u = /^\s*UNRESOLVED\b/im.exec(response);
  if (u) {
    return response.slice(0, u.index).trim();
  }
  return response.trim();
}

// ============================================================
// 内部: UNRESOLVED 抽出
// ============================================================

/**
 * 応答から UNRESOLVED 項目を抽出する。
 *
 * 検索範囲:
 *   - 最初の ```hide``` ブロックの **後** のテキストだけを見る。
 *     ブロック内に書かれた "UNRESOLVED" コメントを誤検出しないため。
 *   - ブロックがない場合は応答全体を見る。
 *
 * パース仕様:
 *   - `^UNRESOLVED` で始まる行をヘッダーとする (case-insensitive)
 *   - ヘッダー行に inline content (`UNRESOLVED: foo`) があればそれを 1 項目目として採用
 *   - 後続の行を順に読み、bullet prefix (`-`, `*`, `+`, `1.`, `1)`) を除去して項目化
 *   - 空行で打ち切る (ただし、項目がまだない場合は skip して継続)
 *   - 次の heading (`## ...`) や fenced block で打ち切る
 */
function extractUnresolvedItems(response: string): LlmReviewUnresolvedItem[] {
  // 最初の ```hide``` ブロックの後ろを検索範囲とする
  let searchText = response;
  const blockRe = /```[ \t]*hide[ \t]*\r?\n[\s\S]*?\r?\n[ \t]*```/;
  const blockMatch = blockRe.exec(response);
  if (blockMatch) {
    searchText = response.slice(blockMatch.index + blockMatch[0].length);
  }

  const lines = searchText.split(/\r?\n/);
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*UNRESOLVED\b/i.test(lines[i])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const items: LlmReviewUnresolvedItem[] = [];
  const pushItem = (text: string) => {
    items.push({ text, index: items.length + 1 });
  };

  // ヘッダー行に inline content がある場合は 1 項目目として採用
  const headerInline = lines[headerIdx]
    .replace(/^\s*UNRESOLVED\s*[:：]?\s*/i, '')
    .trim();
  if (headerInline !== '') {
    pushItem(headerInline);
  }

  // 後続の行を読む
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) break;            // 次の heading で打ち切り
    if (/^[ \t]*```/.test(line)) break;            // fenced block で打ち切り
    if (line.trim() === '') {
      // 項目がまだない (header の直後の空行) なら継続、
      // 1 つ以上既にあれば打ち切り
      if (items.length > 0) break;
      continue;
    }
    const cleaned = stripBulletPrefix(line).trim();
    if (cleaned !== '') pushItem(cleaned);
  }

  return items;
}

/** `- foo` / `* foo` / `+ foo` / `1. foo` / `1) foo` の prefix を除去 */
function stripBulletPrefix(line: string): string {
  return line.replace(/^\s*([-*+]|\d+[.)])\s+/, '');
}

// ============================================================
// 内部: validation
// ============================================================

function validateRevisedSource(
  source: string | undefined,
): LlmReviewValidation {
  if (source === undefined) {
    return {
      parsed: false,
      parseError: 'no ```hide``` block found in LLM response',
      issues: [],
      issueKinds: [],
    };
  }
  try {
    const result = analyzeMatrix(source);
    return {
      parsed: true,
      issues: result.issues,
      issueKinds: uniqueSorted(result.issues.map(i => i.kind)),
    };
  } catch (e) {
    let message: string;
    if (e instanceof HideParseError) {
      message = e.message;
    } else if (e instanceof Error) {
      message = e.message;
    } else {
      message = String(e);
    }
    return {
      parsed: false,
      parseError: message,
      issues: [],
      issueKinds: [],
    };
  }
}

// ============================================================
// 内部: delta 計算
// ============================================================

function computeDelta(
  original: string,
  revised: string | undefined,
): LlmReviewDelta {
  if (revised === undefined) {
    const origLines = splitLinesOrEmpty(original);
    return {
      unchanged: false,
      originalLineCount: origLines.length,
      revisedLineCount: 0,
      addedLines: [],
      removedLines: origLines.slice(),
      changedParts: extractParts(origLines).map(p => ({
        label: p.label,
        before: p.line,
      })),
    };
  }

  if (original === revised) {
    const lines = splitLinesOrEmpty(original);
    return {
      unchanged: true,
      originalLineCount: lines.length,
      revisedLineCount: lines.length,
      addedLines: [],
      removedLines: [],
      changedParts: [],
    };
  }

  const origLines = splitLinesOrEmpty(original);
  const revLines = splitLinesOrEmpty(revised);

  // 行レベル set 差分 (順序は保持)
  const origSet = new Set(origLines);
  const revSet = new Set(revLines);
  const removedLines = origLines.filter(l => !revSet.has(l));
  const addedLines = revLines.filter(l => !origSet.has(l));

  // パートラベル単位の差分
  const changedParts = computeChangedParts(origLines, revLines);

  return {
    unchanged: false,
    originalLineCount: origLines.length,
    revisedLineCount: revLines.length,
    addedLines,
    removedLines,
    changedParts,
  };
}

function splitLinesOrEmpty(s: string): string[] {
  return s === '' ? [] : s.split(/\r?\n/);
}

interface ExtractedPart {
  label: string;
  line: string;
}

/** `[label]| ... |` 形式の行をすべて拾う */
function extractParts(lines: string[]): ExtractedPart[] {
  const re = /^\s*\[([^\]]+)\]\s*\|/;
  const out: ExtractedPart[] = [];
  for (const line of lines) {
    const m = re.exec(line);
    if (m) out.push({ label: m[1], line });
  }
  return out;
}

function computeChangedParts(
  origLines: string[],
  revLines: string[],
): LlmReviewChangedPart[] {
  // ラベル → 行 (同じラベルが複数あれば最後の出現を採用)
  const origByLabel = new Map<string, string>();
  const revByLabel = new Map<string, string>();
  const labelOrder: string[] = [];
  const seenInOrder = new Set<string>();

  for (const part of extractParts(origLines)) {
    if (!seenInOrder.has(part.label)) {
      labelOrder.push(part.label);
      seenInOrder.add(part.label);
    }
    origByLabel.set(part.label, part.line);
  }
  for (const part of extractParts(revLines)) {
    if (!seenInOrder.has(part.label)) {
      labelOrder.push(part.label);
      seenInOrder.add(part.label);
    }
    revByLabel.set(part.label, part.line);
  }

  const changed: LlmReviewChangedPart[] = [];
  for (const label of labelOrder) {
    const before = origByLabel.get(label);
    const after = revByLabel.get(label);
    if (before !== after) {
      changed.push({ label, before, after });
    }
  }
  return changed;
}

// ============================================================
// 内部: utilities
// ============================================================

function uniqueSorted(items: string[]): string[] {
  return Array.from(new Set(items)).sort();
}
