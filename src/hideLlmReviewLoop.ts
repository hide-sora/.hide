/**
 * hideLlmReviewLoop.ts — v1.9 LLM レビュー pipeline 用ループ層 (c 部分)
 *
 * `hideLlmReview.ts` (= a 部分: prompt builder) と `hideLlmReviewApply.ts`
 * (= b 部分: response parser) を組み合わせて、**1 ラウンドで収束しない場合の
 * 反復レビュー戦略** を実装する。
 *
 * 設計:
 *   - **状態機械** として実装する (`startReviewLoop` + `continueReviewLoop`)。
 *     pure function chain なので consumer は「次の prompt を取り出して LLM に
 *     投げ、応答を戻す」という同期 / 非同期どちらでも回せる。
 *   - 同じ機能を **callback 風 wrapper** (`runReviewLoop`) でも提供する。
 *     async LLM 呼び出しを 1 関数で済ませたい consumer 向け。
 *   - apply 層と prompt 層は import するが、**LLM 呼び出しは行わない** —
 *     これも全層を貫く原則 (apply 層も prompt 層もそうだった)。
 *
 * ループ終了条件 (decideTermination):
 *   1. **parseFailure** — apply 結果が parsed=false。新ソースが無いor壊れた
 *      ので即停止。`currentHideSource` は前ラウンドの good state を保持する。
 *   2. **converged** — 残存 issue 0 件 + UNRESOLVED 0 件。clean に終了。
 *   3. **unchanged** — LLM がソースを 1 文字も変更しなかった。これ以上
 *      ループしても結果は変わらないので即停止。
 *   4. **maxRounds** — 上限ラウンド数に到達。
 *   5. **noProgress** — round >= 2 で「issue + UNRESOLVED 合計」が
 *      前ラウンドから減っていない。回帰している場合も含む。
 *
 *   優先順位は parseFailure > converged > unchanged > maxRounds > noProgress。
 *
 * Round 2+ の prompt 構築:
 *   - hideSource = LLM が前回返した修正版
 *   - diagnostics = `[]` (= MusicXml-side diagnostics は元 XML に紐付くので
 *     2 周目以降は持ち越さない)
 *   - matrixIssues = `analyzeMatrix(newSource).issues` (= 構造的な残存問題)
 *   - followup = { round, maxRounds, previousUnresolved, previousSummary }
 *
 *   prompt builder の `followup` field がこれを受け取って、
 *   "## レビューラウンド N / M" セクションを user content に挿入する。
 *
 * スコープ外:
 *   - LLM 呼び出しそのもの (= consumer 側 / `runReviewLoop` の callback)
 *   - 「応答の summaryText に書かれた fix 内容」と diagnostics の自動マッチング
 *     (apply layer と同じ理由で諦めている)
 */

import type {
  LlmReviewPrompt,
  LlmReviewImage,
  LlmReviewPieceContext,
} from './hideLlmReview';
import {
  buildLlmReviewPrompt,
  buildLlmReviewPromptFromResult,
} from './hideLlmReview';
import type { LlmReviewApplyResult } from './hideLlmReviewApply';
import { applyLlmReviewResponse } from './hideLlmReviewApply';
import type { MusicXmlToHideResult } from './musicXmlToHide';
import { analyzeMatrix } from './hideMatrix';

// ============================================================
// 公開定数
// ============================================================

/** デフォルトの上限ラウンド数 */
export const DEFAULT_MAX_ROUNDS = 3;

// ============================================================
// 公開型
// ============================================================

/** ループ初期化入力 */
export interface LlmReviewLoopInput {
  /** 初回 reverse-conversion result */
  initialResult: MusicXmlToHideResult;
  /** ページ画像 (全ラウンドで同じものを使う) */
  pageImages?: LlmReviewImage[];
  /** 楽曲メタデータ (全ラウンドで同じ) */
  pieceContext?: LlmReviewPieceContext;
  /** 上限ラウンド数。デフォルト: {@link DEFAULT_MAX_ROUNDS} */
  maxRounds?: number;
}

/** 1 ラウンド分の記録 */
export interface LlmReviewLoopRound {
  /** 1-based ラウンド番号 */
  round: number;
  /** このラウンドで LLM に投げた prompt */
  prompt: LlmReviewPrompt;
  /**
   * LLM 応答を `applyLlmReviewResponse` に通した結果。
   * まだ応答をもらっていないラウンド (= 末尾の pending round) では undefined。
   */
  applyResult?: LlmReviewApplyResult;
}

/** ループ終了理由 (discriminated union) */
export type LlmReviewLoopTermination =
  /** 残存 issue 0 件 + UNRESOLVED 0 件 */
  | { kind: 'converged'; reason: string }
  /** 上限ラウンド数到達 */
  | { kind: 'maxRounds'; reason: string }
  /** issue + UNRESOLVED 合計が減らなかった */
  | { kind: 'noProgress'; reason: string }
  /** LLM がソースを変更しなかった */
  | { kind: 'unchanged'; reason: string }
  /** LLM 応答の .hide ソースが parse 不能 */
  | { kind: 'parseFailure'; reason: string };

/**
 * ループ状態。`startReviewLoop` で生成し、`continueReviewLoop` で進める。
 *
 * `done=true` になるまでは `nextPrompt` が必ず set されている (consumer は
 * これを LLM に投げる)。`done=true` になると `nextPrompt = undefined` で
 * `termination` が set される。
 */
export interface LlmReviewLoopState {
  /** これまでの全ラウンド (古い順)。最後の要素は applyResult が undefined の場合あり (pending) */
  rounds: LlmReviewLoopRound[];
  /**
   * 「現時点で採用している」 .hide ソース。
   * 各ラウンドが parse 可能な revisedHideSource を返したらそれに更新、
   * 失敗ラウンドでは前のまま据え置く (good-state retention)。
   */
  currentHideSource: string;
  /** 設定スナップショット (continueReviewLoop が次ラウンドを組むのに必要) */
  config: {
    maxRounds: number;
    pageImages?: LlmReviewImage[];
    pieceContext?: LlmReviewPieceContext;
  };
  /** ループが終了したか */
  done: boolean;
  /** done=true のときに set される終了理由 */
  termination?: LlmReviewLoopTermination;
  /**
   * 次に LLM に投げる prompt。
   * done=false の間は必ず set される (consumer はこれを使う)。
   * done=true では undefined。
   */
  nextPrompt?: LlmReviewPrompt;
}

/** `runReviewLoop` の入力 (state machine 入力 + LLM 呼び出し callback) */
export interface RunReviewLoopInput extends LlmReviewLoopInput {
  /**
   * Prompt を受け取って LLM 応答テキストを返す関数。
   * consumer が任意の provider (Anthropic / OpenAI / OSS) に対応させる。
   * `round` パラメータは 1-based のラウンド番号 (ロギング用)。
   */
  callLlm: (prompt: LlmReviewPrompt, round: number) => Promise<string>;
}

/** `runReviewLoop` の最終結果 */
export interface LlmReviewLoopFinalResult {
  /** 最終的に採用された .hide ソース (= state.currentHideSource) */
  hideSource: string;
  /** 全ラウンドの記録 (古い順、すべて applyResult 付き) */
  rounds: LlmReviewLoopRound[];
  /** 終了理由 */
  termination: LlmReviewLoopTermination;
}

// ============================================================
// 公開API: state machine
// ============================================================

/**
 * 新しいレビューループを開始する。
 *
 * 戻り値の `nextPrompt` を LLM に投げて、応答を `continueReviewLoop` に渡す。
 *
 * @example
 *   const result = musicXmlToHide(xml);
 *   let state = startReviewLoop({
 *     initialResult: result,
 *     pageImages: [{ mediaType: 'image/png', base64: pngB64, pageNumber: 1 }],
 *     pieceContext: { title: 'BWV 269' },
 *     maxRounds: 3,
 *   });
 *   while (!state.done) {
 *     const response = await myLlmCall(state.nextPrompt!);
 *     state = continueReviewLoop(state, response);
 *   }
 *   console.log('final:', state.currentHideSource, state.termination);
 */
export function startReviewLoop(input: LlmReviewLoopInput): LlmReviewLoopState {
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;
  if (maxRounds < 1) {
    throw new Error(`startReviewLoop: maxRounds must be >= 1 (got ${maxRounds})`);
  }

  const initialPrompt = buildLlmReviewPromptFromResult(
    input.initialResult,
    input.pageImages,
    input.pieceContext,
  );
  const round1: LlmReviewLoopRound = {
    round: 1,
    prompt: initialPrompt,
  };

  return {
    rounds: [round1],
    currentHideSource: input.initialResult.hideSource,
    config: {
      maxRounds,
      pageImages: input.pageImages,
      pieceContext: input.pieceContext,
    },
    done: false,
    nextPrompt: initialPrompt,
  };
}

/**
 * LLM 応答を受けて、次の状態に進める。
 *
 * 動作:
 *   1. 末尾の pending round に `applyLlmReviewResponse` の結果を埋める
 *   2. revised source が parse 可能なら `currentHideSource` を更新
 *      (parse 不能 / no-block のときは前ラウンドの good state を据え置き)
 *   3. 終了判定 (`decideTermination`)
 *      - 終了 → `done=true`、`nextPrompt=undefined`、`termination` set
 *      - 継続 → 次ラウンド prompt を組み立てて pending round として append
 */
export function continueReviewLoop(
  state: LlmReviewLoopState,
  llmResponse: string,
): LlmReviewLoopState {
  if (state.done) {
    throw new Error('continueReviewLoop: state is already done');
  }
  if (state.rounds.length === 0) {
    throw new Error('continueReviewLoop: state has no rounds (corrupt state)');
  }
  const latestRound = state.rounds[state.rounds.length - 1];
  if (latestRound.applyResult !== undefined) {
    throw new Error(
      'continueReviewLoop: latest round already has an applyResult — feed this state into a new continueReviewLoop call only once',
    );
  }

  // 1. apply
  const applyResult = applyLlmReviewResponse({
    llmResponse,
    originalHideSource: state.currentHideSource,
  });

  // 2. update the latest round in place (immutable copy)
  const updatedRound: LlmReviewLoopRound = {
    ...latestRound,
    applyResult,
  };
  const updatedRounds: LlmReviewLoopRound[] = [
    ...state.rounds.slice(0, -1),
    updatedRound,
  ];

  // 3. update currentHideSource
  //    parse 可能 + revisedHideSource あり のときだけ採用。
  //    壊れた応答は捨てて前ラウンドの good state を保持する。
  const newHideSource =
    applyResult.validation.parsed && applyResult.revisedHideSource !== undefined
      ? applyResult.revisedHideSource
      : state.currentHideSource;

  // 4. termination 判定
  const termination = decideTermination(
    updatedRounds,
    applyResult,
    state.config.maxRounds,
  );

  if (termination !== undefined) {
    return {
      rounds: updatedRounds,
      currentHideSource: newHideSource,
      config: state.config,
      done: true,
      termination,
      nextPrompt: undefined,
    };
  }

  // 5. 継続: 次ラウンド prompt を構築
  const nextRoundNumber = updatedRounds.length + 1;
  const nextPrompt = buildFollowupPrompt({
    hideSource: newHideSource,
    pageImages: state.config.pageImages,
    pieceContext: state.config.pieceContext,
    round: nextRoundNumber,
    maxRounds: state.config.maxRounds,
    previousApplyResult: applyResult,
  });

  const nextRound: LlmReviewLoopRound = {
    round: nextRoundNumber,
    prompt: nextPrompt,
  };

  return {
    rounds: [...updatedRounds, nextRound],
    currentHideSource: newHideSource,
    config: state.config,
    done: false,
    nextPrompt,
  };
}

// ============================================================
// 公開API: callback wrapper
// ============================================================

/**
 * LLM 呼び出し callback を渡してループを最後まで回す convenience wrapper。
 *
 * 内部的には `startReviewLoop` + `continueReviewLoop` を回しているだけ。
 * 細かい状態を観察したい場合は state machine を直接使うこと。
 *
 * @example
 *   const final = await runReviewLoop({
 *     initialResult: musicXmlToHide(xml),
 *     pageImages: [...],
 *     pieceContext: { title: 'BWV X' },
 *     maxRounds: 3,
 *     callLlm: async (prompt, round) => {
 *       const msg = await anthropic.messages.create({
 *         model: 'claude-opus-4-6',
 *         system: prompt.systemPrompt,
 *         messages: [{ role: 'user', content: prompt.userContent }],
 *         max_tokens: 4096,
 *       });
 *       return msg.content
 *         .filter(b => b.type === 'text')
 *         .map(b => b.text).join('\n');
 *     },
 *   });
 *   console.log(final.hideSource, final.termination);
 */
export async function runReviewLoop(
  input: RunReviewLoopInput,
): Promise<LlmReviewLoopFinalResult> {
  let state = startReviewLoop(input);
  while (!state.done) {
    if (!state.nextPrompt) {
      throw new Error(
        'runReviewLoop: state is not done but has no nextPrompt (invariant violation)',
      );
    }
    const round = state.rounds.length;
    const response = await input.callLlm(state.nextPrompt, round);
    state = continueReviewLoop(state, response);
  }
  if (!state.termination) {
    throw new Error(
      'runReviewLoop: state.done is true but state.termination is undefined (invariant violation)',
    );
  }
  return {
    hideSource: state.currentHideSource,
    rounds: state.rounds,
    termination: state.termination,
  };
}

// ============================================================
// 内部: 終了判定
// ============================================================

function decideTermination(
  rounds: LlmReviewLoopRound[],
  latest: LlmReviewApplyResult,
  maxRounds: number,
): LlmReviewLoopTermination | undefined {
  // 1. parseFailure: LLM 応答の hideSource が壊れている / そもそも無い
  if (!latest.validation.parsed) {
    return {
      kind: 'parseFailure',
      reason: `LLM 応答の .hide ソースが parse 不能: ${latest.validation.parseError ?? '(no error message)'}`,
    };
  }

  // 2. converged: 残存 issue 0 + UNRESOLVED 0
  if (
    latest.validation.issues.length === 0 &&
    latest.unresolved.length === 0
  ) {
    return {
      kind: 'converged',
      reason: '残存 issue なし、UNRESOLVED なし',
    };
  }

  // 3. unchanged: LLM がソースを変更しなかった (これ以上ループしても結果は変わらない)
  if (latest.delta.unchanged) {
    return {
      kind: 'unchanged',
      reason:
        'LLM が .hide ソースを変更しませんでした (further iteration では収束しません)',
    };
  }

  // 4. maxRounds: 上限到達
  if (rounds.length >= maxRounds) {
    return {
      kind: 'maxRounds',
      reason: `最大ラウンド数 ${maxRounds} に到達`,
    };
  }

  // 5. noProgress: round >= 2 で issue + UNRESOLVED 合計が減らなかった
  if (rounds.length >= 2) {
    const prev = rounds[rounds.length - 2].applyResult;
    if (prev !== undefined && prev.validation.parsed) {
      const prevTotal =
        prev.validation.issues.length + prev.unresolved.length;
      const currTotal =
        latest.validation.issues.length + latest.unresolved.length;
      if (currTotal >= prevTotal) {
        return {
          kind: 'noProgress',
          reason: `issue + UNRESOLVED 合計が ${prevTotal} → ${currTotal} と減少しませんでした`,
        };
      }
    }
  }

  // 継続
  return undefined;
}

// ============================================================
// 内部: follow-up prompt 構築
// ============================================================

interface BuildFollowupInput {
  hideSource: string;
  pageImages?: LlmReviewImage[];
  pieceContext?: LlmReviewPieceContext;
  round: number;
  maxRounds: number;
  previousApplyResult: LlmReviewApplyResult;
}

function buildFollowupPrompt(input: BuildFollowupInput): LlmReviewPrompt {
  // 新しいソースに対して matrix issue を再計算
  // (元の MusicXml diagnostics は引き継がない — XML には紐付かなくなったため)
  const matrixIssues = analyzeMatrix(input.hideSource).issues;

  return buildLlmReviewPrompt({
    hideSource: input.hideSource,
    diagnostics: [],
    matrixIssues,
    pageImages: input.pageImages,
    pieceContext: input.pieceContext,
    followup: {
      round: input.round,
      maxRounds: input.maxRounds,
      previousUnresolved: input.previousApplyResult.unresolved.map(u => u.text),
      previousSummary:
        input.previousApplyResult.summaryText !== ''
          ? input.previousApplyResult.summaryText
          : undefined,
    },
  });
}
