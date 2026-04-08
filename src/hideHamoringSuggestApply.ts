/**
 * hideHamoringSuggestApply.ts — v1.9 ハモリ提案 LLM パイプライン用 apply layer
 *
 * `hideHamoringSuggest.ts` (= a 部分: prompt builder) と対をなす b 部分。
 * `buildHamoringSuggestPrompt` が組み立てた text-only prompt に対する LLM の
 * 応答 (raw テキスト) を受け取り、提案された .hide ソースを取り出して再検証
 * + コード進行 / voice leading を再計算 + 元との差分を計算 + 任意で task-aware
 * soft contract check を行う pure parser。
 *
 * `hideLlmReviewApply.ts` を構造的 twin として持つが、生成タスク用なので
 * **前提が逆向き** (silent fill OK / 古典禁則を適用しない / 画像 source-of-truth
 * ではない / UNRESOLVED 概念なし / 複数ブロックは想定内):
 *
 *  | 観点               | hideLlmReviewApply  | hideHamoringSuggestApply |
 *  |--------------------|---------------------|---------------------------|
 *  | ブロック数         | 1 つを期待 (複数=warning) | **複数を期待** (primary + 代替案) |
 *  | UNRESOLVED tail    | あり                | **なし** (system prompt 仕様にない) |
 *  | silent fill        | 禁止                | **OK**                    |
 *  | voice leading      | issue 扱い          | **caution 扱い**          |
 *  | 任意の task 入力   | なし                | **あり** (soft contract check) |
 *  | chord/VL 再計算    | 行わない            | **行う** (parsed=true 時)  |
 *  | decline 検出       | なし                | **あり** (no fence + summary) |
 *
 * 入力:
 *   - LLM 応答テキスト (raw) — 提案サマリ + ```hide``` ブロック (+ 任意で代替案)
 *   - 元の .hide ソース (delta 計算用)
 *   - 任意: 元の `HamoringSuggestTask` (task-aware soft contract check 用)
 *
 * 出力 (`HamoringSuggestApplyResult`):
 *   - primary proposal (= 最初のブロック) を top-level に配置
 *     (`revisedHideSource` / `validation` / `delta`)
 *   - 代替案 (= 2 番目以降のブロック) を `alternates[]` に独立した validation +
 *     delta + 任意 label つきで返す
 *   - 提案サマリ text (`summaryText`、最初のフェンス前の自由記述)
 *   - decline 検出 (`declined`、no fence + 説明文 = 「提案できないとき」)
 *   - 任意: task-aware soft contract check (`taskCheck`)
 *   - apply 自身の警告 (`warnings`、応答 shape の問題)
 *
 * 設計思想:
 *   - **silent fill OK** — 生成タスクなのでパースに失敗しても rejection の根拠
 *     にしない。代わりに `validation.parseError` を surface し、consumer (将来の
 *     loop 層) が次の prompt を組み立てるかどうか判断する。
 *   - **複数ブロックは想定内** — system prompt が「代替案がある場合は別の
 *     ```hide``` ブロックを追加し、それぞれの上に **代替案 1**, **代替案 2**
 *     のようにラベルを付けてください」と明示しているので、複数 found は warning
 *     ではなく成功扱い。
 *   - **decline mode** — system prompt は「提案できないとき (タスクが矛盾している
 *     / 入力が壊れている等) は、その旨を最初の数行に明記し、```hide``` ブロックは
 *     省略してください」と書いてあるので、no fence + non-empty summary は LLM が
 *     正規のチャネルで decline したシグナル。`declined: true` で surface する。
 *   - **task-aware check は soft warning だけ** — proposal を reject しない。
 *     LLM が「addPart 依頼に対して既存パートを変更してしまった」場合でも、
 *     consumer が編集として受け入れるかどうかは consumer の判断に任せる。
 *   - **chord / VL を proposal に同梱** — `analyzeMatrix` が走った後の matrix を
 *     再利用して `classifyMatrixMeasures` + `analyzeVoiceLeading` を呼ぶ。コスト
 *     は LLM 呼び出しに比べれば無視できる。consumer が proposal の音楽的特徴を
 *     一覧できるようにする。
 *   - **将来の `hideHamoringSuggestLoop.ts` のため**、top-level field の配置
 *     (`revisedHideSource` / `validation` / `delta` / `summaryText`) は
 *     `LlmReviewApplyResult` と同形に揃える。loop 層が `hideLlmReviewLoop.ts`
 *     をほぼ流用できるように。
 *   - **LLM 呼び出しは行わない** — pure parser。
 *
 * スコープ外 (将来作業):
 *   - LLM 呼び出しそのもの
 *   - 多ラウンドループ (= ロードマップ c 部分)
 *   - 提案を元 .hide にマージするロジック (主案 = full source 置換が基本仕様、
 *     snippet 入力時の貼り付け位置決定は consumer 側で行う)
 */

import type { HideMatrix, HideMatrixIssue } from './hideMatrix';
import { analyzeMatrix } from './hideMatrix';
import type { ChordLabel } from './hideChord';
import { classifyMatrixMeasures } from './hideChord';
import type { VoiceLeadingObservation } from './hideVoiceLeading';
import { analyzeVoiceLeading } from './hideVoiceLeading';
import type { HamoringSuggestTask } from './hideHamoringSuggest';
import { HideParseError } from './hideErrors';

// ============================================================
// 公開型
// ============================================================

/** apply 層への入力 */
export interface HamoringSuggestApplyInput {
  /** LLM 応答テキスト (生) */
  llmResponse: string;
  /** 元の .hide ソース。delta 計算に使う */
  originalHideSource: string;
  /**
   * 任意: prompt を組み立てたときの task。
   * 渡すと task-aware soft contract check (`taskCheck` field) が走る。
   * 省略すると pure な解析のみ行う (`taskCheck` は undefined になる)。
   */
  task?: HamoringSuggestTask;
}

/** apply 層の結果 */
export interface HamoringSuggestApplyResult {
  /** ```hide``` ブロックが少なくとも 1 つ見つかったか (= 非 decline mode) */
  hideBlockFound: boolean;
  /** ```hide``` ブロックの総数 (primary + alternates) */
  hideBlockCount: number;
  /**
   * Primary proposal = 最初のブロック。
   * decline mode では undefined。
   */
  revisedHideSource?: string;
  /** 最初のブロックより前の自由記述 (提案サマリ) */
  summaryText: string;
  /**
   * decline mode 検出。
   * `hideBlockCount === 0 && summaryText.trim() !== ''` で true。
   *
   * 「LLM が提案を拒否した (タスクが矛盾している/入力が壊れている等)」シグナル。
   * system prompt が "提案できないとき...```hide``` ブロックは省略してください"
   * と書いているので、no fence + 説明文 = 正規 decline channel。
   */
  declined: boolean;
  /** Primary proposal の再検証 (analyzeMatrix + chord + VL) */
  validation: HamoringSuggestProposalValidation;
  /** Primary proposal の元との差分 */
  delta: HamoringSuggestDelta;
  /**
   * 代替案 = ブロック 2..N (primary は含まない、`index` は 1-based)。
   * 各々が独立に validation + delta + 任意 label を持つ。
   * primary しかないとき空配列。
   */
  alternates: HamoringAlternateProposal[];
  /**
   * Task-aware soft contract check。
   * `input.task` が渡され、かつ primary が parsed=true のときのみ存在。
   * すべて警告レベル — proposal を reject することはない。
   */
  taskCheck?: HamoringSuggestTaskCheck;
  /** apply 層自身の警告 (応答 shape の問題、task check 由来の警告など) */
  warnings: string[];
}

/**
 * Primary or 代替案 1 件の検証結果 (analyzeMatrix + chord + VL を一括)。
 *
 * `chordLabels` / `voiceLeadingObservations` は `parsed: true` のときのみ
 * populate される (パース失敗時の silent fill を避けるため undefined のまま)。
 */
export interface HamoringSuggestProposalValidation {
  /** `analyzeMatrix` が throw せずに解析できたか */
  parsed: boolean;
  /** `parsed=false` のときの parse error メッセージ */
  parseError?: string;
  /** Matrix mode が proposal に見つけた issue (空配列なら clean) */
  issues: HideMatrixIssue[];
  /** issue.kind の sorted unique 配列 */
  issueKinds: string[];
  /**
   * proposal のコード進行 (各小節の和音ラベル、null は分類不能)。
   * `parsed=true` のときのみ populate。
   */
  chordLabels?: Array<ChordLabel | null>;
  /**
   * proposal の voice leading 観察 (caution、エラーではない)。
   * `parsed=true` のときのみ populate。空配列は「caution なし」を意味する。
   */
  voiceLeadingObservations?: VoiceLeadingObservation[];
}

/** 元と proposal の差分 (`LlmReviewDelta` と同形) */
export interface HamoringSuggestDelta {
  /** 元と proposal がバイト一致か */
  unchanged: boolean;
  /** 元のライン数 */
  originalLineCount: number;
  /** proposal のライン数 */
  revisedLineCount: number;
  /** proposal にあって元にないライン (set 差分、grid form 想定) */
  addedLines: string[];
  /** 元にあって proposal にないライン */
  removedLines: string[];
  /**
   * パートラベル単位の変更詳細。
   * `[1]| ... |` 形式の行を label で対応付けて before/after を返す。
   * 行が完全一致するパートはここに含まれない。
   */
  changedParts: HamoringSuggestChangedPart[];
}

/** パートラベル単位の差分 1 件 */
export interface HamoringSuggestChangedPart {
  /** パートラベル (例: "1", "2", "P") */
  label: string;
  /** 元の行 (新規追加されたパートでは undefined) */
  before?: string;
  /** proposal の行 (削除されたパートでは undefined) */
  after?: string;
}

/** 代替案 1 件 (primary とは別、`index` は 1-based) */
export interface HamoringAlternateProposal {
  /** 1-based の代替案番号 (primary は含まない、最初の代替案が `index=1`) */
  index: number;
  /** この代替案の .hide ソース */
  hideSource: string;
  /**
   * フェンスの直前から best-effort 抽出した label (例: "代替案 1", "代替案 2")。
   * 見つからなければ undefined。
   */
  label?: string;
  /** primary と同じ validation 形 */
  validation: HamoringSuggestProposalValidation;
  /** この代替案 vs **元 .hide** の差分 (vs primary ではない) */
  delta: HamoringSuggestDelta;
}

/**
 * Task-aware soft contract check。
 *
 * `HamoringSuggestTask.kind` に対応する discriminated union。すべての
 * violation/warning は情報目的のみ — proposal を reject しない。
 */
export type HamoringSuggestTaskCheck =
  | {
      kind: 'continue';
      /** primary が「追加分のみのスニペット」っぽいか (= 元ソースが proposal に
       *  含まれていない) */
      snippetMode: boolean;
      /** primary が「元の全ソース + 追加分」っぽいか (= 元ソースが proposal の
       *  prefix) */
      fullSourceMode: boolean;
      /**
       * 追加された小節数。
       * snippet モードでは proposal の総小節数。
       * full モードでは proposal の総小節数 - 元の総小節数。
       * パース失敗時は 0。
       */
      measuresAdded: number;
      warnings: string[];
    }
  | {
      kind: 'addPart';
      /** task.partLabel が primary の part labels に追加されているか */
      partLabelAdded: boolean;
      /** 既存パートの行が byte-identical のままか */
      existingPartsPreserved: boolean;
      /** 既存パートのうち、行が変わってしまったもののラベル (1-based 出現順) */
      mutatedExistingPartLabels: string[];
      warnings: string[];
    }
  | {
      kind: 'fixSection';
      /** [fromMeasure, toMeasure] 範囲外が原文どおり保たれているか */
      outsideRangeUntouched: boolean;
      /** 範囲外なのに変更されてしまった小節 (1-based, 昇順) */
      leakedMeasures: number[];
      warnings: string[];
    }
  | {
      kind: 'reharmonize';
      /** [fromMeasure, toMeasure] 範囲外が原文どおり保たれているか */
      outsideRangeUntouched: boolean;
      /** 範囲外なのに変更されてしまった小節 (1-based, 昇順) */
      leakedMeasures: number[];
      /**
       * トップ声部 (= proposal の `partLabels[0]`) が範囲内で byte-identical か。
       * = メロディ保持 check (system prompt が「メロディは保つ」と指示している)。
       */
      topPartPreservedInRange: boolean;
      warnings: string[];
    }
  | {
      kind: 'freeform';
      /** freeform は意味的契約が無いので check 不能、symmetry のための placeholder */
      warnings: string[];
    };

// ============================================================
// 公開API
// ============================================================

/**
 * ハモリ提案 LLM 応答を解析して、提案された .hide ソースと診断情報を取り出す。
 *
 * @example
 *   // 1. 元の編曲から prompt を組み立てる
 *   const prompt = buildHamoringSuggestPrompt({
 *     hideSource: currentArrangement,
 *     task: { kind: 'addPart', partLabel: '3', voiceDescription: 'alto' },
 *   });
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
 *   const apply = applyHamoringSuggestResponse({
 *     llmResponse: responseText,
 *     originalHideSource: currentArrangement,
 *     task: { kind: 'addPart', partLabel: '3' }, // task-aware check 有効
 *   });
 *
 *   // 4. 受け入れ判定
 *   if (apply.declined) {
 *     // LLM が「提案できない」と返した — 別の task で再試行 or 諦める
 *   } else if (apply.validation.parsed && apply.validation.issues.length === 0) {
 *     // ✓ clean な提案を採用
 *     finalHideSource = apply.revisedHideSource!;
 *     // taskCheck も確認: addPart の場合 partLabelAdded === true を期待
 *     if (apply.taskCheck?.kind === 'addPart' && !apply.taskCheck.partLabelAdded) {
 *       console.warn('依頼したパートが追加されていません');
 *     }
 *   } else {
 *     // → 代替案を検討 or 次ラウンドの prompt を構築
 *   }
 */
export function applyHamoringSuggestResponse(
  input: HamoringSuggestApplyInput,
): HamoringSuggestApplyResult {
  const warnings: string[] = [];

  // 1. ```hide``` フェンスブロックを全件抽出 (offset 付き)
  const blockMatches = extractHideBlockMatches(input.llmResponse);
  if (blockMatches.length === 0) {
    warnings.push('LLM 応答に ```hide``` フェンスブロックが見つかりませんでした');
  }

  // 2. summary text (最初のブロック前のテキスト)
  const summaryText = extractSummaryText(input.llmResponse);

  // 3. decline 判定
  const declined = detectDecline(blockMatches.length, summaryText);
  if (blockMatches.length === 0 && !declined) {
    warnings.push(
      'LLM 応答に ```hide``` ブロックも提案サマリも見つかりませんでした (応答が空か shape が不明です)',
    );
  }

  // 4. primary を取り出して validate
  const primarySource = blockMatches.length > 0 ? blockMatches[0]!.content : undefined;
  const primaryAnalysis = validateAndAnalyzeProposal(primarySource);
  const validation = primaryAnalysis.validation;

  // 5. primary の delta
  const delta = computeDelta(input.originalHideSource, primarySource);
  if (delta.unchanged && blockMatches.length > 0) {
    warnings.push(
      '提案された .hide ソースが元のソースとバイト一致です — LLM が変更を加えなかった可能性があります',
    );
  }

  // 6. 代替案 = blocks[1..]
  const alternates: HamoringAlternateProposal[] = [];
  for (let i = 1; i < blockMatches.length; i++) {
    const m = blockMatches[i]!;
    const altAnalysis = validateAndAnalyzeProposal(m.content);
    const altDelta = computeDelta(input.originalHideSource, m.content);
    const label = extractAlternateLabel(input.llmResponse, m.headerStart);
    alternates.push({
      index: i,
      hideSource: m.content,
      label,
      validation: altAnalysis.validation,
      delta: altDelta,
    });
  }

  // 7. task-aware soft contract check (任意)
  let taskCheck: HamoringSuggestTaskCheck | undefined;
  if (input.task !== undefined && validation.parsed && primarySource !== undefined && primaryAnalysis.matrix !== undefined) {
    taskCheck = runTaskCheck(
      input.task,
      input.originalHideSource,
      primarySource,
      primaryAnalysis.matrix,
    );
    // taskCheck の warnings を top-level にも mirror (consumer が warnings だけ
    // 見ても気付けるように)
    for (const w of taskCheck.warnings) {
      warnings.push(`[task=${taskCheck.kind}] ${w}`);
    }
  }

  return {
    hideBlockFound: blockMatches.length > 0,
    hideBlockCount: blockMatches.length,
    revisedHideSource: primarySource,
    summaryText,
    declined,
    validation,
    delta,
    alternates,
    taskCheck,
    warnings,
  };
}

// ============================================================
// 内部: fenced block 抽出
// ============================================================

interface HideBlockMatch {
  /** ブロック内容 (フェンス記号と language tag は除外) */
  content: string;
  /** 開きフェンス (` ```hide ` 行) の絶対 offset */
  headerStart: number;
}

/**
 * 応答から ```hide ... ``` を全て抽出する (offset 付き)。
 *
 * 寛容性:
 *   - ` ```hide` の前後の whitespace 許容
 *   - CRLF / LF 両対応
 *   - 閉じフェンス前後の whitespace 許容
 *
 * 厳格性:
 *   - **language tag は `hide` のみ** — `python` / `text` / 無印は無視
 *   - 開閉フェンスの間に必ず改行が必要
 */
function extractHideBlockMatches(response: string): HideBlockMatch[] {
  const matches: HideBlockMatch[] = [];
  const re = /```[ \t]*hide[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(response)) !== null) {
    matches.push({
      content: m[1]!,
      headerStart: m.index,
    });
  }
  return matches;
}

// ============================================================
// 内部: summary 抽出
// ============================================================

/**
 * 最初の ```hide``` ブロックより前のテキストを提案サマリとして返す。
 * ブロックがない場合は応答全文を trim して返す (decline mode 用)。
 *
 * 注意: hideLlmReviewApply の `extractSummaryText` には UNRESOLVED フォールバック
 * 分岐があるが、ハモリ提案の出力フォーマットには UNRESOLVED 概念がないので削除。
 */
function extractSummaryText(response: string): string {
  const m = /```[ \t]*hide[ \t]*\r?\n/.exec(response);
  if (m) {
    return response.slice(0, m.index).trim();
  }
  return response.trim();
}

// ============================================================
// 内部: 代替案ラベル抽出
// ============================================================

/**
 * フェンスの直前から best-effort で「代替案 N」label を拾う。
 *
 * 探索戦略:
 *  1. blockStartOffset の直前 1024 文字を slice (応答全体を見る必要はない)
 *  2. その範囲内の最大 10 個の非空行を後ろから順に走査
 *  3. 各行から markdown 装飾 (heading `#`, bullet, `**`, `__`) を剥がす
 *  4. 「代替案」を含む最初の行を採用 (number があれば "代替案 N" に正規化)
 *  5. 直前の非空行を全て調べても見つからなければ undefined
 *
 * なぜ複数行を見るか: 実際の LLM 応答は
 *   ```
 *   **代替案 1**
 *
 *   ジャズ風コードへの変更案。
 *
 *   ```hide
 *   ```
 * のように、見出しと fence の間に空行と説明文 1〜2 行が入るのが普通。
 * 直前 1 行だけ見ると説明文が拾われてしまう。
 *
 * 例:
 *   "**代替案 1**" → "代替案 1"
 *   "代替案1:"      → "代替案 1"
 *   "## 代替案 2"   → "代替案 2"
 *   "別案"          → undefined (誤検出回避)
 */
function extractAlternateLabel(
  response: string,
  blockStartOffset: number,
): string | undefined {
  const sliceStart = Math.max(0, blockStartOffset - 1024);
  const before = response.slice(sliceStart, blockStartOffset);
  const lines = before.split(/\r?\n/);
  // 直前の非空行を後ろから最大 10 個まで取り出す
  const nonEmptyLines: string[] = [];
  for (let i = lines.length - 1; i >= 0 && nonEmptyLines.length < 10; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed !== '') {
      nonEmptyLines.push(trimmed);
    }
  }
  for (const line of nonEmptyLines) {
    // markdown 装飾を剥がす: 先頭の heading (#)、bullet、強調 (**, __)
    const stripped = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/[*_]{1,3}/g, '')
      .trim();
    const m = /代替案\s*(\d+)?/.exec(stripped);
    if (!m) continue;
    if (m[1]) {
      return `代替案 ${m[1]}`;
    }
    // 番号なしの場合、コロン等の末尾装飾を剥がして返す
    return stripped.replace(/[:：]\s*$/, '');
  }
  return undefined;
}

// ============================================================
// 内部: decline 判定
// ============================================================

/**
 * decline mode = no fence + 非空 summary。
 *
 * system prompt は「提案できないとき...その旨を最初の数行に明記し、
 * ```hide``` ブロックは省略してください」と書いてある。これに従って LLM が
 * 正規 decline channel を使った場合、no fence + 説明文 という shape になる。
 */
function detectDecline(hideBlockCount: number, summaryText: string): boolean {
  return hideBlockCount === 0 && summaryText.trim() !== '';
}

// ============================================================
// 内部: validation
// ============================================================

/**
 * Proposal を `analyzeMatrix` で再パースし、成功時は `classifyMatrixMeasures`
 * + `analyzeVoiceLeading` を recompute して validation に同梱する。
 *
 * 戻り値の `matrix` は呼び出し側 (= `runTaskCheck`) で使うが、`validation`
 * からは隠す (型を clean に保つため)。
 */
function validateAndAnalyzeProposal(source: string | undefined): {
  validation: HamoringSuggestProposalValidation;
  matrix?: HideMatrix;
} {
  if (source === undefined) {
    return {
      validation: {
        parsed: false,
        parseError: 'no ```hide``` block found in LLM response',
        issues: [],
        issueKinds: [],
      },
    };
  }
  try {
    const result = analyzeMatrix(source);
    const chordLabels = classifyMatrixMeasures(result.matrix);
    const vlAnalysis = analyzeVoiceLeading(result.matrix);
    return {
      validation: {
        parsed: true,
        issues: result.issues,
        issueKinds: uniqueSorted(result.issues.map((i) => i.kind)),
        chordLabels,
        voiceLeadingObservations: vlAnalysis.observations,
      },
      matrix: result.matrix,
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
      validation: {
        parsed: false,
        parseError: message,
        issues: [],
        issueKinds: [],
      },
    };
  }
}

// ============================================================
// 内部: delta 計算
// ============================================================

function computeDelta(
  original: string,
  revised: string | undefined,
): HamoringSuggestDelta {
  if (revised === undefined) {
    const origLines = splitLinesOrEmpty(original);
    return {
      unchanged: false,
      originalLineCount: origLines.length,
      revisedLineCount: 0,
      addedLines: [],
      removedLines: origLines.slice(),
      changedParts: extractParts(origLines).map((p) => ({
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
  const removedLines = origLines.filter((l) => !revSet.has(l));
  const addedLines = revLines.filter((l) => !origSet.has(l));

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

/** `[label]| ... |` 形式の行をすべて拾う (順序保持) */
function extractParts(lines: string[]): ExtractedPart[] {
  const re = /^\s*\[([^\]]+)\]\s*\|/;
  const out: ExtractedPart[] = [];
  for (const line of lines) {
    const m = re.exec(line);
    if (m) out.push({ label: m[1]!, line });
  }
  return out;
}

function computeChangedParts(
  origLines: string[],
  revLines: string[],
): HamoringSuggestChangedPart[] {
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

  const changed: HamoringSuggestChangedPart[] = [];
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
// 内部: task-aware contract check
// ============================================================

/**
 * task ごとに 5 種別の dispatch を行う。
 * すべての check は **soft** — `warnings` に文字列を積むだけで proposal を
 * reject しない。
 */
function runTaskCheck(
  task: HamoringSuggestTask,
  originalHideSource: string,
  proposalSource: string,
  proposalMatrix: HideMatrix,
): HamoringSuggestTaskCheck {
  switch (task.kind) {
    case 'continue':
      return checkContinueTask(task, originalHideSource, proposalSource, proposalMatrix);
    case 'addPart':
      return checkAddPartTask(task, originalHideSource, proposalSource);
    case 'fixSection':
      return checkFixSectionTask(task, originalHideSource, proposalMatrix);
    case 'reharmonize':
      return checkReharmonizeTask(task, originalHideSource, proposalMatrix);
    case 'freeform':
      return { kind: 'freeform', warnings: [] };
  }
}

function checkContinueTask(
  task: Extract<HamoringSuggestTask, { kind: 'continue' }>,
  originalHideSource: string,
  _proposalSource: string,
  proposalMatrix: HideMatrix,
): HamoringSuggestTaskCheck {
  const warnings: string[] = [];

  // 元の matrix を取り直す
  let originalMatrix: HideMatrix | undefined;
  try {
    originalMatrix = analyzeMatrix(originalHideSource).matrix;
  } catch {
    warnings.push('元 .hide ソースのパースに失敗 — measuresAdded の計算は不正確です');
  }
  const originalMeasureCount = originalMatrix?.measures.length ?? 0;
  const proposalMeasureCount = proposalMatrix.measures.length;

  // fullSourceMode = 元の N 小節がそっくり proposal の先頭 N 小節として保存されている
  // (= 編曲全体を再掲した上で末尾に小節を追加)
  // snippetMode = それ以外 (= 追加分のみのスニペットを返した)
  let fullSourceMode = false;
  if (
    originalMatrix !== undefined &&
    originalMeasureCount > 0 &&
    proposalMeasureCount >= originalMeasureCount
  ) {
    fullSourceMode = true;
    for (let mi = 0; mi < originalMeasureCount; mi++) {
      const origCells = originalMatrix.measures[mi]!.cells;
      const propCells = proposalMatrix.measures[mi]!.cells;
      if (!measureCellsEqual(origCells, propCells)) {
        fullSourceMode = false;
        break;
      }
    }
  }

  const snippetMode = !fullSourceMode;
  const measuresAdded = fullSourceMode
    ? proposalMeasureCount - originalMeasureCount
    : proposalMeasureCount;

  if (measuresAdded < task.measuresToAdd) {
    warnings.push(
      `提案された小節数 (${measuresAdded}) が依頼数 (${task.measuresToAdd}) より少ないです`,
    );
  } else if (measuresAdded > task.measuresToAdd + 1) {
    // off-by-one (pickup 等) は許容
    warnings.push(
      `提案された小節数 (${measuresAdded}) が依頼数 (${task.measuresToAdd}) より多いです`,
    );
  }

  return {
    kind: 'continue',
    snippetMode,
    fullSourceMode,
    measuresAdded: Math.max(0, measuresAdded),
    warnings,
  };
}

function checkAddPartTask(
  task: Extract<HamoringSuggestTask, { kind: 'addPart' }>,
  originalHideSource: string,
  proposalSource: string,
): HamoringSuggestTaskCheck {
  const warnings: string[] = [];

  const origLines = splitLinesOrEmpty(originalHideSource);
  const propLines = splitLinesOrEmpty(proposalSource);
  const origParts = extractParts(origLines);
  const propParts = extractParts(propLines);

  const origLabelSet = new Set(origParts.map((p) => p.label));
  const propLabelSet = new Set(propParts.map((p) => p.label));

  const partLabelAdded = propLabelSet.has(task.partLabel) && !origLabelSet.has(task.partLabel);

  // 既存パートが byte-identical のままか
  const origByLabel = new Map<string, string>();
  for (const p of origParts) origByLabel.set(p.label, p.line);
  const propByLabel = new Map<string, string>();
  for (const p of propParts) propByLabel.set(p.label, p.line);

  const mutatedExistingPartLabels: string[] = [];
  for (const p of origParts) {
    const after = propByLabel.get(p.label);
    if (after === undefined) {
      // 既存パートが proposal から消えた = mutation
      mutatedExistingPartLabels.push(p.label);
    } else if (after !== p.line) {
      mutatedExistingPartLabels.push(p.label);
    }
  }
  const existingPartsPreserved = mutatedExistingPartLabels.length === 0;

  if (!partLabelAdded) {
    if (origLabelSet.has(task.partLabel)) {
      warnings.push(
        `依頼したパート [${task.partLabel}] は既存パートと衝突しています (proposal 側で別パートを追加してください)`,
      );
    } else {
      warnings.push(`依頼したパート [${task.partLabel}] が proposal に追加されていません`);
    }
  }
  if (!existingPartsPreserved) {
    warnings.push(
      `既存パート ${mutatedExistingPartLabels.map((l) => `[${l}]`).join(', ')} が変更されています (addPart は既存パートを保つ前提です)`,
    );
  }

  return {
    kind: 'addPart',
    partLabelAdded,
    existingPartsPreserved,
    mutatedExistingPartLabels,
    warnings,
  };
}

function checkFixSectionTask(
  task: Extract<HamoringSuggestTask, { kind: 'fixSection' }>,
  originalHideSource: string,
  proposalMatrix: HideMatrix,
): HamoringSuggestTaskCheck {
  const warnings: string[] = [];
  const leakedMeasures = computeLeakedMeasures(
    originalHideSource,
    proposalMatrix,
    task.fromMeasure,
    task.toMeasure,
    warnings,
  );
  const outsideRangeUntouched = leakedMeasures.length === 0;
  if (!outsideRangeUntouched) {
    warnings.push(
      `指定範囲 [${task.fromMeasure}〜${task.toMeasure}] 外で変更が検出されました (小節 ${leakedMeasures.join(', ')})`,
    );
  }
  return {
    kind: 'fixSection',
    outsideRangeUntouched,
    leakedMeasures,
    warnings,
  };
}

function checkReharmonizeTask(
  task: Extract<HamoringSuggestTask, { kind: 'reharmonize' }>,
  originalHideSource: string,
  proposalMatrix: HideMatrix,
): HamoringSuggestTaskCheck {
  const warnings: string[] = [];
  const leakedMeasures = computeLeakedMeasures(
    originalHideSource,
    proposalMatrix,
    task.fromMeasure,
    task.toMeasure,
    warnings,
  );
  const outsideRangeUntouched = leakedMeasures.length === 0;
  if (!outsideRangeUntouched) {
    warnings.push(
      `指定範囲 [${task.fromMeasure}〜${task.toMeasure}] 外で変更が検出されました (小節 ${leakedMeasures.join(', ')})`,
    );
  }

  // メロディ保持 check: トップ声部の範囲内が byte-identical か
  const topPartPreservedInRange = checkTopPartPreservedInRange(
    originalHideSource,
    proposalMatrix,
    task.fromMeasure,
    task.toMeasure,
  );
  if (!topPartPreservedInRange) {
    warnings.push(
      `トップ声部 (メロディ) が指定範囲 [${task.fromMeasure}〜${task.toMeasure}] 内で変更されています — system prompt は「メロディは保つ」と指示しています`,
    );
  }

  return {
    kind: 'reharmonize',
    outsideRangeUntouched,
    leakedMeasures,
    topPartPreservedInRange,
    warnings,
  };
}

/**
 * 範囲外で proposal が元と異なる小節を 1-based で集める。
 * 元または proposal がパースできない場合は空配列を返し warnings に通知。
 */
function computeLeakedMeasures(
  originalHideSource: string,
  proposalMatrix: HideMatrix,
  fromMeasure: number,
  toMeasure: number,
  warnings: string[],
): number[] {
  let originalMatrix: HideMatrix | undefined;
  try {
    originalMatrix = analyzeMatrix(originalHideSource).matrix;
  } catch {
    warnings.push('元 .hide ソースのパースに失敗 — 範囲外 leak 判定はスキップしました');
    return [];
  }
  const fromIdx = fromMeasure - 1;
  const toIdx = toMeasure - 1;
  const leaked: number[] = [];
  const commonCount = Math.min(originalMatrix.measures.length, proposalMatrix.measures.length);
  for (let mi = 0; mi < commonCount; mi++) {
    if (mi >= fromIdx && mi <= toIdx) continue;
    const origMeasure = originalMatrix.measures[mi]!;
    const propMeasure = proposalMatrix.measures[mi]!;
    if (!measureCellsEqual(origMeasure.cells, propMeasure.cells)) {
      leaked.push(mi + 1);
    }
  }
  return leaked;
}

/**
 * 同じ小節 (= 同じインデックス) について、両 measure の全パートの cells を比較。
 * 共通パートだけ pitches で比較し、片方にしか無いパートは差分とみなす。
 */
function measureCellsEqual(
  a: ReadonlyMap<string, { pitches: ReadonlyArray<{ step: string; octave: number; alter: number }> }>,
  b: ReadonlyMap<string, { pitches: ReadonlyArray<{ step: string; octave: number; alter: number }> }>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [label, cellA] of a) {
    const cellB = b.get(label);
    if (cellB === undefined) return false;
    if (!pitchesEqual(cellA.pitches, cellB.pitches)) return false;
  }
  return true;
}

function pitchesEqual(
  a: ReadonlyArray<{ step: string; octave: number; alter: number }>,
  b: ReadonlyArray<{ step: string; octave: number; alter: number }>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const pa = a[i]!;
    const pb = b[i]!;
    if (pa.step !== pb.step || pa.octave !== pb.octave || pa.alter !== pb.alter) {
      return false;
    }
  }
  return true;
}

/**
 * トップ声部 (= proposalMatrix.partLabels[0]) の `[fromMeasure, toMeasure]` 内
 * cells を pitches レベルで比較する。
 */
function checkTopPartPreservedInRange(
  originalHideSource: string,
  proposalMatrix: HideMatrix,
  fromMeasure: number,
  toMeasure: number,
): boolean {
  let originalMatrix: HideMatrix | undefined;
  try {
    originalMatrix = analyzeMatrix(originalHideSource).matrix;
  } catch {
    return true; // パース不能なら判定不能 = 偽陽性を避ける
  }
  if (originalMatrix.partLabels.length === 0 || proposalMatrix.partLabels.length === 0) {
    return true;
  }
  const topLabel = proposalMatrix.partLabels[0]!;
  // 元側でも同じラベルが top である必要はないが、まずは「両方に同じトップ
  // ラベルがある」シナリオを優先 check する
  if (!originalMatrix.partLabels.includes(topLabel)) {
    return true; // 元にトップ label が無いなら判定不能 = 偽陽性回避
  }

  const fromIdx = fromMeasure - 1;
  const toIdx = toMeasure - 1;
  const commonCount = Math.min(originalMatrix.measures.length, proposalMatrix.measures.length);
  for (let mi = fromIdx; mi <= toIdx && mi < commonCount; mi++) {
    if (mi < 0) continue;
    const origCell = originalMatrix.measures[mi]!.cells.get(topLabel);
    const propCell = proposalMatrix.measures[mi]!.cells.get(topLabel);
    if (origCell === undefined || propCell === undefined) {
      return false;
    }
    if (!pitchesEqual(origCell.pitches, propCell.pitches)) {
      return false;
    }
  }
  return true;
}

// ============================================================
// 内部: utilities
// ============================================================

function uniqueSorted(items: string[]): string[] {
  return Array.from(new Set(items)).sort();
}
