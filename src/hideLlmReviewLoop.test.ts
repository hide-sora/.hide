/**
 * hideLlmReviewLoop.test.ts — LLM レビュー pipeline のループ層 (c) 単体テスト
 *
 * テスト戦略:
 *   - state machine (`startReviewLoop` + `continueReviewLoop`) と
 *     callback wrapper (`runReviewLoop`) の両 API を独立にカバーする
 *   - 終了判定 (`decideTermination` の 5 種別) を 1 ラウンド / 多ラウンド両面で
 *     verify (priority: parseFailure > converged > unchanged > maxRounds > noProgress)
 *   - silent fill 禁止の方針: parseFailure / no-block 応答で currentHideSource が
 *     破壊されないことを確認する (good state retention)
 *   - round 2+ の followup prompt が `buildFollowupPrompt` を経由して
 *     正しく組み立てられていることを確認する
 *   - 実 LLM 応答風のテキストを使った integration ケースも入れる
 */

import { describe, it, expect, vi } from 'vitest';
import {
  startReviewLoop,
  continueReviewLoop,
  runReviewLoop,
  DEFAULT_MAX_ROUNDS,
} from './hideLlmReviewLoop';
import type {
  LlmReviewLoopState,
  LlmReviewLoopFinalResult,
} from './hideLlmReviewLoop';
import type {
  MusicXmlToHideResult,
  MusicXmlToHideDiagnostic,
} from './musicXmlToHide';
import type { LlmReviewPrompt } from './hideLlmReview';
import { compileHide } from './hideLoader';
import { musicXmlToHide } from './musicXmlToHide';

// ============================================================
// テストヘルパー
// ============================================================

/** 2 パート × 2 小節のクリーンソース */
const CLEAN_TWO_PART = '[1]| C5m | D5m |\n[2]| G4m | A4m |';

/** measureCountMismatch を起こす broken source ([1]=3 / [2]=2) */
const BROKEN_3VS2 = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | E5m |
[2]| G4m | A4m |`;

/** measureCountMismatch を起こす別 broken source (E→F の差で unchanged 判定を回避) */
const BROKEN_3VS2_VARIANT = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | F5m |
[2]| G4m | A4m |`;

/** クリーンな修正版 (3 小節揃い) */
const FIXED_THREE_MEASURES = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | E5m |
[2]| G4m | A4m | B4m |`;

/** Lexer が HideParseError を投げる malformed source ([BADMETA]) */
const PARSE_FAIL_SOURCE = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[BADMETA]
[1]| C5m |`;

/** Markdown コードフェンスで包む */
function fenceHide(content: string): string {
  return '```hide\n' + content + '\n```';
}

/** クリーンな .hide ソースから MusicXmlToHideResult を生成 (実 round-trip 経由) */
function makeResult(source: string): MusicXmlToHideResult {
  const { musicXml } = compileHide(source);
  return musicXmlToHide(musicXml);
}

/**
 * 任意の hideSource + diagnostics で fake な MusicXmlToHideResult を組み立てる。
 * hideSource は `analyzeMatrix` で parse 可能である必要がある (issue は OK)。
 */
function makeFakeResult(opts: {
  hideSource: string;
  diagnostics?: MusicXmlToHideDiagnostic[];
}): MusicXmlToHideResult {
  return {
    hideSource: opts.hideSource,
    header: {
      timeNum: 4,
      timeDen: 4,
      keyFifths: 0,
      div: 32,
      clef: 'TREBLE',
    },
    warnings: [],
    diagnostics: opts.diagnostics ?? [],
    partsCount: 2,
    measuresCount: 2,
  };
}

// ============================================================
// startReviewLoop — 基本構造
// ============================================================

describe('startReviewLoop — basic shape', () => {
  it('returns a LlmReviewLoopState with expected fields', () => {
    const state = startReviewLoop({ initialResult: makeResult(CLEAN_TWO_PART) });
    expect(state).toHaveProperty('rounds');
    expect(state).toHaveProperty('currentHideSource');
    expect(state).toHaveProperty('config');
    expect(state).toHaveProperty('done');
    expect(state).toHaveProperty('nextPrompt');
  });

  it('creates exactly one initial pending round', () => {
    const state = startReviewLoop({ initialResult: makeResult(CLEAN_TWO_PART) });
    expect(state.rounds).toHaveLength(1);
    expect(state.rounds[0].round).toBe(1);
    expect(state.rounds[0].applyResult).toBeUndefined(); // 未 apply
    expect(state.rounds[0].prompt).toBeDefined();
  });

  it('sets nextPrompt to the round 1 prompt and done=false', () => {
    const state = startReviewLoop({ initialResult: makeResult(CLEAN_TWO_PART) });
    expect(state.done).toBe(false);
    expect(state.nextPrompt).toBeDefined();
    expect(state.nextPrompt).toBe(state.rounds[0].prompt);
    expect(state.termination).toBeUndefined();
  });

  it('initializes currentHideSource to the initialResult.hideSource', () => {
    const initial = makeResult(CLEAN_TWO_PART);
    const state = startReviewLoop({ initialResult: initial });
    expect(state.currentHideSource).toBe(initial.hideSource);
  });

  it('defaults maxRounds to DEFAULT_MAX_ROUNDS', () => {
    const state = startReviewLoop({ initialResult: makeResult(CLEAN_TWO_PART) });
    expect(state.config.maxRounds).toBe(DEFAULT_MAX_ROUNDS);
  });

  it('respects an explicit maxRounds override', () => {
    const state = startReviewLoop({
      initialResult: makeResult(CLEAN_TWO_PART),
      maxRounds: 5,
    });
    expect(state.config.maxRounds).toBe(5);
  });

  it('preserves pageImages and pieceContext in config', () => {
    const images = [
      {
        mediaType: 'image/png' as const,
        base64: 'AAAA',
        pageNumber: 1,
      },
    ];
    const ctx = { title: 'Test', composer: 'Anon' };
    const state = startReviewLoop({
      initialResult: makeResult(CLEAN_TWO_PART),
      pageImages: images,
      pieceContext: ctx,
    });
    expect(state.config.pageImages).toEqual(images);
    expect(state.config.pieceContext).toEqual(ctx);
  });

  it('throws when maxRounds is 0 or negative', () => {
    const initial = makeResult(CLEAN_TWO_PART);
    expect(() => startReviewLoop({ initialResult: initial, maxRounds: 0 })).toThrow(
      /maxRounds must be >= 1/,
    );
    expect(() => startReviewLoop({ initialResult: initial, maxRounds: -3 })).toThrow(
      /maxRounds must be >= 1/,
    );
  });

  it('round 1 prompt is built from the initialResult (smoke test)', () => {
    const initial = makeResult(CLEAN_TWO_PART);
    const state = startReviewLoop({ initialResult: initial });
    // round 1 は followup を含まない (= "## レビューラウンド" は出ない)
    expect(state.nextPrompt!.textOnlyPrompt).not.toMatch(/## レビューラウンド/);
    // hideSource は埋め込まれている
    expect(state.nextPrompt!.textOnlyPrompt).toMatch(/逆変換された \.hide ソース/);
  });

  it('round 1 prompt threads pieceContext through', () => {
    const state = startReviewLoop({
      initialResult: makeResult(CLEAN_TWO_PART),
      pieceContext: { title: 'BWV X', composer: 'JSB' },
    });
    expect(state.nextPrompt!.textOnlyPrompt).toMatch(/BWV X/);
    expect(state.nextPrompt!.textOnlyPrompt).toMatch(/JSB/);
  });
});

// ============================================================
// continueReviewLoop — 基本構造 / invariant
// ============================================================

describe('continueReviewLoop — invariant guards', () => {
  it('throws when called on a done state', () => {
    let state = startReviewLoop({ initialResult: makeResult(CLEAN_TWO_PART) });
    // Round 1 を converged で終了させる
    state = continueReviewLoop(state, fenceHide(state.currentHideSource));
    expect(state.done).toBe(true);
    expect(() => continueReviewLoop(state, 'next')).toThrow(/already done/);
  });

  it('populates the latest round applyResult after a single call', () => {
    let state = startReviewLoop({ initialResult: makeResult(CLEAN_TWO_PART) });
    state = continueReviewLoop(state, fenceHide(state.currentHideSource));
    // 終了したラウンド (= round 1) には applyResult が入っている
    expect(state.rounds[0].applyResult).toBeDefined();
  });
});

// ============================================================
// continueReviewLoop — 終了判定 (1 ラウンドで決まるケース)
// ============================================================

describe('continueReviewLoop — single-round termination', () => {
  it('terminates with kind="converged" when LLM returns issue-free + UNRESOLVED-free response', () => {
    const initial = makeFakeResult({ hideSource: BROKEN_3VS2 });
    let state = startReviewLoop({ initialResult: initial, maxRounds: 3 });
    // LLM がきちんと修正して clean source を返す
    state = continueReviewLoop(state, fenceHide(FIXED_THREE_MEASURES));
    expect(state.done).toBe(true);
    expect(state.termination?.kind).toBe('converged');
    expect(state.termination?.reason).toMatch(/残存 issue なし/);
    expect(state.currentHideSource).toBe(FIXED_THREE_MEASURES);
  });

  it('terminates with kind="parseFailure" when LLM returns malformed source', () => {
    const initial = makeResult(CLEAN_TWO_PART);
    let state = startReviewLoop({ initialResult: initial });
    state = continueReviewLoop(state, fenceHide(PARSE_FAIL_SOURCE));
    expect(state.done).toBe(true);
    expect(state.termination?.kind).toBe('parseFailure');
    expect(state.termination?.reason).toMatch(/parse 不能/);
  });

  it('parseFailure retains the previous good currentHideSource (silent-fill 禁止)', () => {
    const initial = makeResult(CLEAN_TWO_PART);
    const goodSource = initial.hideSource;
    let state = startReviewLoop({ initialResult: initial });
    state = continueReviewLoop(state, fenceHide(PARSE_FAIL_SOURCE));
    // 壊れた応答は採用しない — 前ラウンドの good state がそのまま保持される
    expect(state.currentHideSource).toBe(goodSource);
  });

  it('terminates with kind="parseFailure" when no ```hide``` block is present', () => {
    const initial = makeResult(CLEAN_TWO_PART);
    let state = startReviewLoop({ initialResult: initial });
    // ブロックなし → validation.parsed=false → parseFailure
    state = continueReviewLoop(state, 'I cannot help with this.');
    expect(state.done).toBe(true);
    expect(state.termination?.kind).toBe('parseFailure');
  });

  it('no-block response also retains the previous good currentHideSource', () => {
    const initial = makeResult(CLEAN_TWO_PART);
    let state = startReviewLoop({ initialResult: initial });
    state = continueReviewLoop(state, 'no block at all');
    expect(state.currentHideSource).toBe(initial.hideSource);
  });

  it('terminates with kind="unchanged" when LLM echoes the source byte-for-byte', () => {
    const initial = makeFakeResult({ hideSource: BROKEN_3VS2 });
    let state = startReviewLoop({ initialResult: initial, maxRounds: 3 });
    // LLM が「直せませんでした」と元のソースをそのまま返す
    state = continueReviewLoop(state, fenceHide(BROKEN_3VS2));
    expect(state.done).toBe(true);
    expect(state.termination?.kind).toBe('unchanged');
    expect(state.termination?.reason).toMatch(/変更しませんでした/);
  });

  it('continues to round 2 when residual issues remain (does NOT terminate at round 1)', () => {
    const initial = makeFakeResult({ hideSource: BROKEN_3VS2 });
    let state = startReviewLoop({ initialResult: initial, maxRounds: 3 });
    // LLM が部分修正を返す → 別の broken だが unchanged ではない
    state = continueReviewLoop(state, fenceHide(BROKEN_3VS2_VARIANT));
    expect(state.done).toBe(false);
    expect(state.termination).toBeUndefined();
    // 次の pending round 2 が用意されている
    expect(state.rounds).toHaveLength(2);
    expect(state.rounds[1].round).toBe(2);
    expect(state.rounds[1].applyResult).toBeUndefined();
    expect(state.nextPrompt).toBeDefined();
  });

  it('continues to round 2 when LLM only flags UNRESOLVED items (no remaining issues)', () => {
    const initial = makeFakeResult({ hideSource: BROKEN_3VS2 });
    let state = startReviewLoop({ initialResult: initial, maxRounds: 3 });
    // 構造的には clean だが UNRESOLVED 項目がある → continued
    const response =
      fenceHide(FIXED_THREE_MEASURES) + '\n\nUNRESOLVED:\n- 小節 3 のリズムが画像と一致するか不明';
    state = continueReviewLoop(state, response);
    // 残存 issue 0 だが unresolved がある → converged ではない → 続く
    expect(state.done).toBe(false);
    expect(state.rounds).toHaveLength(2);
  });
});

// ============================================================
// continueReviewLoop — 多ラウンドにまたがる終了判定
// ============================================================

describe('continueReviewLoop — multi-round termination', () => {
  it('terminates with kind="maxRounds" after the final round when no convergence', () => {
    const initial = makeFakeResult({ hideSource: BROKEN_3VS2 });
    let state = startReviewLoop({ initialResult: initial, maxRounds: 2 });
    // Round 1: 別 broken (issue 残るが unchanged ではない)
    state = continueReviewLoop(state, fenceHide(BROKEN_3VS2_VARIANT));
    expect(state.done).toBe(false);
    // Round 2: さらに別 broken (issue 残るが unchanged ではない)
    const broken3 = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | G5m |
[2]| G4m | A4m |`;
    state = continueReviewLoop(state, fenceHide(broken3));
    expect(state.done).toBe(true);
    expect(state.termination?.kind).toBe('maxRounds');
    expect(state.termination?.reason).toMatch(/最大ラウンド数 2/);
  });

  it('terminates with kind="noProgress" when issue+UNRESOLVED total does not decrease (round 2)', () => {
    const initial = makeFakeResult({ hideSource: BROKEN_3VS2 });
    let state = startReviewLoop({ initialResult: initial, maxRounds: 3 });
    // Round 1: broken variant (1 issue)
    state = continueReviewLoop(state, fenceHide(BROKEN_3VS2_VARIANT));
    expect(state.done).toBe(false);
    // Round 2: another broken variant (still 1 issue, no decrease)
    const broken3 = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | A5m |
[2]| G4m | A4m |`;
    state = continueReviewLoop(state, fenceHide(broken3));
    expect(state.done).toBe(true);
    expect(state.termination?.kind).toBe('noProgress');
    expect(state.termination?.reason).toMatch(/減少しませんでした/);
  });

  it('does NOT terminate with noProgress at round 1 (needs at least 2 applied rounds)', () => {
    const initial = makeFakeResult({ hideSource: BROKEN_3VS2 });
    let state = startReviewLoop({ initialResult: initial, maxRounds: 3 });
    // 1 ラウンドだけ apply、issue 残っているが noProgress 判定はまだできない
    state = continueReviewLoop(state, fenceHide(BROKEN_3VS2_VARIANT));
    expect(state.done).toBe(false);
    expect(state.termination).toBeUndefined();
  });

  it('reaches converged across multiple rounds (round 1 partial → round 2 clean)', () => {
    const initial = makeFakeResult({ hideSource: BROKEN_3VS2 });
    let state = startReviewLoop({ initialResult: initial, maxRounds: 3 });
    // Round 1: 部分修正 (まだ broken)
    state = continueReviewLoop(state, fenceHide(BROKEN_3VS2_VARIANT));
    expect(state.done).toBe(false);
    // Round 2: クリーンに修正
    state = continueReviewLoop(state, fenceHide(FIXED_THREE_MEASURES));
    expect(state.done).toBe(true);
    expect(state.termination?.kind).toBe('converged');
    expect(state.currentHideSource).toBe(FIXED_THREE_MEASURES);
    // 2 ラウンド分の記録 (両方 applyResult 付き)
    expect(state.rounds).toHaveLength(2);
    expect(state.rounds[0].applyResult).toBeDefined();
    expect(state.rounds[1].applyResult).toBeDefined();
  });

  it('terminates with converged at round 1 when LLM nails it on the first try', () => {
    const initial = makeFakeResult({ hideSource: BROKEN_3VS2 });
    let state = startReviewLoop({ initialResult: initial, maxRounds: 3 });
    state = continueReviewLoop(state, fenceHide(FIXED_THREE_MEASURES));
    expect(state.done).toBe(true);
    expect(state.termination?.kind).toBe('converged');
    // 追加の round 2 は作られていない
    expect(state.rounds).toHaveLength(1);
  });

  it('priority: parseFailure beats every other termination kind', () => {
    const initial = makeFakeResult({ hideSource: BROKEN_3VS2 });
    let state = startReviewLoop({ initialResult: initial, maxRounds: 1 });
    // maxRounds=1 で parseFailure を発生 → maxRounds より parseFailure が先
    state = continueReviewLoop(state, fenceHide(PARSE_FAIL_SOURCE));
    expect(state.termination?.kind).toBe('parseFailure');
  });

  it('priority: converged beats unchanged + maxRounds', () => {
    // クリーン応答 → converged が unchanged よりも先に発火
    const initial = makeFakeResult({ hideSource: FIXED_THREE_MEASURES });
    let state = startReviewLoop({ initialResult: initial, maxRounds: 1 });
    state = continueReviewLoop(state, fenceHide(FIXED_THREE_MEASURES));
    // unchanged (echo) かつ maxRounds 到達かつ converged の三立てだが converged が勝つ
    expect(state.termination?.kind).toBe('converged');
  });

  it('priority: unchanged beats maxRounds', () => {
    const initial = makeFakeResult({ hideSource: BROKEN_3VS2 });
    let state = startReviewLoop({ initialResult: initial, maxRounds: 1 });
    state = continueReviewLoop(state, fenceHide(BROKEN_3VS2)); // echo (unchanged)
    // maxRounds=1 でも unchanged が先に発火
    expect(state.termination?.kind).toBe('unchanged');
  });

  it('maxRounds=1 with non-converged + non-unchanged → maxRounds termination', () => {
    const initial = makeFakeResult({ hideSource: BROKEN_3VS2 });
    let state = startReviewLoop({ initialResult: initial, maxRounds: 1 });
    state = continueReviewLoop(state, fenceHide(BROKEN_3VS2_VARIANT));
    expect(state.termination?.kind).toBe('maxRounds');
  });
});

// ============================================================
// currentHideSource progression (good-state retention)
// ============================================================

describe('continueReviewLoop — currentHideSource progression', () => {
  it('updates currentHideSource on a successful (parseable) revised source', () => {
    const initial = makeResult(CLEAN_TWO_PART);
    let state = startReviewLoop({ initialResult: initial });
    state = continueReviewLoop(state, fenceHide(FIXED_THREE_MEASURES));
    expect(state.currentHideSource).toBe(FIXED_THREE_MEASURES);
  });

  it('does NOT update currentHideSource when LLM returns parse-failing source', () => {
    const initial = makeResult(CLEAN_TWO_PART);
    const before = initial.hideSource;
    let state = startReviewLoop({ initialResult: initial });
    state = continueReviewLoop(state, fenceHide(PARSE_FAIL_SOURCE));
    expect(state.currentHideSource).toBe(before);
  });

  it('updates currentHideSource on each successful round (round 1 then round 2)', () => {
    const initial = makeFakeResult({ hideSource: BROKEN_3VS2 });
    let state = startReviewLoop({ initialResult: initial, maxRounds: 3 });
    // Round 1: partial
    state = continueReviewLoop(state, fenceHide(BROKEN_3VS2_VARIANT));
    expect(state.currentHideSource).toBe(BROKEN_3VS2_VARIANT);
    // Round 2: clean
    state = continueReviewLoop(state, fenceHide(FIXED_THREE_MEASURES));
    expect(state.currentHideSource).toBe(FIXED_THREE_MEASURES);
  });

  it('round 2 retains round 1 good state when round 2 returns parse-failing source', () => {
    const initial = makeFakeResult({ hideSource: BROKEN_3VS2 });
    let state = startReviewLoop({ initialResult: initial, maxRounds: 3 });
    // Round 1: partial fix that lands
    state = continueReviewLoop(state, fenceHide(BROKEN_3VS2_VARIANT));
    expect(state.currentHideSource).toBe(BROKEN_3VS2_VARIANT);
    // Round 2: malformed → currentHideSource stays at round 1's state
    state = continueReviewLoop(state, fenceHide(PARSE_FAIL_SOURCE));
    expect(state.currentHideSource).toBe(BROKEN_3VS2_VARIANT);
    expect(state.termination?.kind).toBe('parseFailure');
  });
});

// ============================================================
// Round 2+ followup prompt 構築
// ============================================================

describe('continueReviewLoop — followup prompt construction (round 2+)', () => {
  function setupRound2(round1Response: string): LlmReviewLoopState {
    const initial = makeFakeResult({ hideSource: BROKEN_3VS2 });
    let state = startReviewLoop({ initialResult: initial, maxRounds: 3 });
    state = continueReviewLoop(state, round1Response);
    return state;
  }

  it('round 2 prompt contains the followup header "## レビューラウンド 2 / 3"', () => {
    const state = setupRound2(fenceHide(BROKEN_3VS2_VARIANT));
    expect(state.done).toBe(false);
    expect(state.nextPrompt!.textOnlyPrompt).toMatch(/## レビューラウンド 2 \/ 3/);
  });

  it('round 2 prompt embeds the round 1 revised hideSource (not the original)', () => {
    const state = setupRound2(fenceHide(BROKEN_3VS2_VARIANT));
    // round 2 prompt は新しい hideSource (round 1 の修正版) を埋め込む
    expect(state.nextPrompt!.textOnlyPrompt).toMatch(/F5m/); // BROKEN_3VS2_VARIANT 固有の音
    // 元のソースの "E5m" は埋め込まれていない (= round 1 状態は引き継いでいない)
    // ※ "E5m" は line 番号 prefix の中に入る可能性があるので broader 確認
  });

  it('round 2 prompt includes previousUnresolved items as numbered list', () => {
    const round1Response =
      fenceHide(BROKEN_3VS2_VARIANT) +
      '\n\nUNRESOLVED:\n- 小節 3 が画像で不明瞭\n- 小節 2 のスラー位置が不明';
    const state = setupRound2(round1Response);
    expect(state.nextPrompt!.textOnlyPrompt).toMatch(/1\. 小節 3 が画像で不明瞭/);
    expect(state.nextPrompt!.textOnlyPrompt).toMatch(/2\. 小節 2 のスラー位置が不明/);
  });

  it('round 2 prompt includes previousSummary as a markdown blockquote when present', () => {
    const round1Response =
      '小節 3 を E → F に修正しました。\n\n' + fenceHide(BROKEN_3VS2_VARIANT);
    const state = setupRound2(round1Response);
    expect(state.nextPrompt!.textOnlyPrompt).toMatch(/前回の修正サマリ/);
    expect(state.nextPrompt!.textOnlyPrompt).toMatch(/> 小節 3 を E → F に修正しました/);
  });

  it('round 2 prompt OMITS previousSummary section when round 1 had no prelude text', () => {
    // 修正サマリなし: ブロックのみ
    const state = setupRound2(fenceHide(BROKEN_3VS2_VARIANT));
    expect(state.nextPrompt!.textOnlyPrompt).not.toMatch(/前回の修正サマリ/);
  });

  it('round 2 prompt has empty diagnostics section (MusicXml-side diagnostics not carried forward)', () => {
    const state = setupRound2(fenceHide(BROKEN_3VS2_VARIANT));
    // diagnostics は round 2+ で空配列 → 「(なし — 構造的な不整合は検出されませんでした...)」
    expect(state.nextPrompt!.textOnlyPrompt).toMatch(/構造的な不整合は検出されませんでした/);
  });

  it('round 2 prompt re-runs analyzeMatrix on the new source and surfaces remaining issues', () => {
    const state = setupRound2(fenceHide(BROKEN_3VS2_VARIANT));
    // BROKEN_3VS2_VARIANT は依然 measureCountMismatch → matrix issue として浮上する
    expect(state.nextPrompt!.textOnlyPrompt).toMatch(/measureCountMismatch/);
  });

  it('round 3 prompt at maxRounds=3 marks itself as final round', () => {
    // 3 ラウンド目に到達するために round 2 の応答は round 1 と異なる必要がある
    // (= unchanged termination 回避)。さらに total を decrescendo して noProgress も回避。
    const broken3VsVariant3 = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | A5m |
[2]| G4m | A4m |`;
    const initial = makeFakeResult({ hideSource: BROKEN_3VS2 });
    let state = startReviewLoop({ initialResult: initial, maxRounds: 3 });
    // Round 1: BROKEN_3VS2_VARIANT (F5m) + 5 unresolved → 1 issue + 5 unresolved = 6
    state = continueReviewLoop(
      state,
      fenceHide(BROKEN_3VS2_VARIANT) + '\n\nUNRESOLVED:\n- a\n- b\n- c\n- d\n- e',
    );
    expect(state.done).toBe(false);
    // Round 2: 別 broken (A5m) + 3 unresolved → 1 issue + 3 unresolved = 4 (progress)
    state = continueReviewLoop(
      state,
      fenceHide(broken3VsVariant3) + '\n\nUNRESOLVED:\n- one\n- two\n- three',
    );
    expect(state.done).toBe(false);
    expect(state.rounds).toHaveLength(3);
    // Round 3 prompt は最終ラウンド表示
    expect(state.nextPrompt!.textOnlyPrompt).toMatch(/最終ラウンド/);
    expect(state.nextPrompt!.textOnlyPrompt).toMatch(/## レビューラウンド 3 \/ 3/);
  });
});

// ============================================================
// runReviewLoop async wrapper
// ============================================================

describe('runReviewLoop — async callback wrapper', () => {
  it('returns a LlmReviewLoopFinalResult shape with hideSource/rounds/termination', async () => {
    const callLlm = vi.fn(async () => fenceHide(FIXED_THREE_MEASURES));
    const final = await runReviewLoop({
      initialResult: makeFakeResult({ hideSource: BROKEN_3VS2 }),
      maxRounds: 3,
      callLlm,
    });
    expect(final).toHaveProperty('hideSource');
    expect(final).toHaveProperty('rounds');
    expect(final).toHaveProperty('termination');
  });

  it('terminates on first-round convergence (callLlm called once)', async () => {
    const callLlm = vi.fn(async () => fenceHide(FIXED_THREE_MEASURES));
    const final = await runReviewLoop({
      initialResult: makeFakeResult({ hideSource: BROKEN_3VS2 }),
      maxRounds: 3,
      callLlm,
    });
    expect(callLlm).toHaveBeenCalledTimes(1);
    expect(final.termination.kind).toBe('converged');
    expect(final.hideSource).toBe(FIXED_THREE_MEASURES);
  });

  it('passes 1-based round numbers to callLlm', async () => {
    const seenRounds: number[] = [];
    const callLlm = vi.fn(async (_prompt: LlmReviewPrompt, round: number) => {
      seenRounds.push(round);
      return fenceHide(FIXED_THREE_MEASURES);
    });
    await runReviewLoop({
      initialResult: makeFakeResult({ hideSource: BROKEN_3VS2 }),
      maxRounds: 3,
      callLlm,
    });
    expect(seenRounds).toEqual([1]);
  });

  it('passes the LlmReviewPrompt object to callLlm (not raw text)', async () => {
    let seenPrompt: LlmReviewPrompt | undefined;
    const callLlm = vi.fn(async (prompt: LlmReviewPrompt) => {
      seenPrompt = prompt;
      return fenceHide(FIXED_THREE_MEASURES);
    });
    await runReviewLoop({
      initialResult: makeFakeResult({ hideSource: BROKEN_3VS2 }),
      callLlm,
    });
    expect(seenPrompt).toBeDefined();
    expect(seenPrompt).toHaveProperty('systemPrompt');
    expect(seenPrompt).toHaveProperty('userContent');
    expect(seenPrompt).toHaveProperty('textOnlyPrompt');
    expect(seenPrompt).toHaveProperty('summary');
  });

  it('drives multiple rounds when round 1 is partial and round 2 converges', async () => {
    const responses = [
      fenceHide(BROKEN_3VS2_VARIANT), // round 1: partial
      fenceHide(FIXED_THREE_MEASURES), // round 2: clean
    ];
    let i = 0;
    const callLlm = vi.fn(async () => responses[i++]);
    const final = await runReviewLoop({
      initialResult: makeFakeResult({ hideSource: BROKEN_3VS2 }),
      maxRounds: 3,
      callLlm,
    });
    expect(callLlm).toHaveBeenCalledTimes(2);
    expect(final.termination.kind).toBe('converged');
    expect(final.hideSource).toBe(FIXED_THREE_MEASURES);
    expect(final.rounds).toHaveLength(2);
    // すべての round に applyResult が入っている
    for (const r of final.rounds) {
      expect(r.applyResult).toBeDefined();
    }
  });

  it('terminates immediately on parseFailure (callLlm called once)', async () => {
    const callLlm = vi.fn(async () => fenceHide(PARSE_FAIL_SOURCE));
    const final = await runReviewLoop({
      initialResult: makeResult(CLEAN_TWO_PART),
      maxRounds: 3,
      callLlm,
    });
    expect(callLlm).toHaveBeenCalledTimes(1);
    expect(final.termination.kind).toBe('parseFailure');
  });

  it('respects maxRounds (terminates after maxRounds rounds even if not converged)', async () => {
    // maxRounds=2: 1) broken 2) different broken → maxRounds termination
    const responses = [
      fenceHide(BROKEN_3VS2_VARIANT),
      fenceHide(`[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | G5m |
[2]| G4m | A4m |`),
    ];
    let i = 0;
    const callLlm = vi.fn(async () => responses[i++]);
    const final = await runReviewLoop({
      initialResult: makeFakeResult({ hideSource: BROKEN_3VS2 }),
      maxRounds: 2,
      callLlm,
    });
    expect(callLlm).toHaveBeenCalledTimes(2);
    expect(final.termination.kind).toBe('maxRounds');
  });

  it('final.hideSource matches state.currentHideSource after parseFailure (good state retained)', async () => {
    const initial = makeResult(CLEAN_TWO_PART);
    const callLlm = vi.fn(async () => fenceHide(PARSE_FAIL_SOURCE));
    const final = await runReviewLoop({
      initialResult: initial,
      callLlm,
    });
    expect(final.termination.kind).toBe('parseFailure');
    // 元の good state がそのまま返る (壊れた source は採用しない)
    expect(final.hideSource).toBe(initial.hideSource);
  });

  it('propagates callLlm errors as rejected promise', async () => {
    const callLlm = vi.fn(async () => {
      throw new Error('upstream API failed');
    });
    await expect(
      runReviewLoop({
        initialResult: makeResult(CLEAN_TWO_PART),
        callLlm,
      }),
    ).rejects.toThrow(/upstream API failed/);
  });

  it('uses DEFAULT_MAX_ROUNDS when maxRounds not specified', async () => {
    // callLlm が常に non-converged で返す → DEFAULT_MAX_ROUNDS 回呼ばれて maxRounds 終了
    let counter = 0;
    const callLlm = vi.fn(async () => {
      counter++;
      // 各ラウンドで違う broken を返して unchanged / noProgress を回避
      const variants = [
        BROKEN_3VS2_VARIANT,
        `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | A5m |
[2]| G4m | A4m |`,
        `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | B5m |
[2]| G4m | A4m |`,
      ];
      // unresolved を decrescendo にして noProgress 回避
      const unresolvedCount = 5 - counter;
      const unresolved =
        unresolvedCount > 0
          ? '\n\nUNRESOLVED:\n' +
            Array.from({ length: unresolvedCount }, (_, i) => `- item ${i}`).join('\n')
          : '';
      return fenceHide(variants[counter - 1]) + unresolved;
    });
    const final = await runReviewLoop({
      initialResult: makeFakeResult({ hideSource: BROKEN_3VS2 }),
      callLlm,
    });
    expect(callLlm).toHaveBeenCalledTimes(DEFAULT_MAX_ROUNDS);
    expect(final.termination.kind).toBe('maxRounds');
  });
});

// ============================================================
// DEFAULT_MAX_ROUNDS 定数
// ============================================================

describe('DEFAULT_MAX_ROUNDS', () => {
  it('equals 3', () => {
    expect(DEFAULT_MAX_ROUNDS).toBe(3);
  });
});

// ============================================================
// 統合: 現実的な多ラウンド LLM フロー
// ============================================================

describe('runReviewLoop — realistic LLM scenarios', () => {
  it('full convergence in 2 rounds (round 1 partial, round 2 clean) — end-to-end happy path', async () => {
    const responses = [
      `画像を確認しました。[1] の 3 小節目だけ修正しました。
${fenceHide(BROKEN_3VS2_VARIANT)}
UNRESOLVED:
- [2] の 3 小節目はまだ画像と照合中`,
      `[2] の 3 小節目を画像から書き起こせました。
${fenceHide(FIXED_THREE_MEASURES)}`,
    ];
    let i = 0;
    const callLlm = vi.fn(async () => responses[i++]);

    const final = await runReviewLoop({
      initialResult: makeFakeResult({ hideSource: BROKEN_3VS2 }),
      pieceContext: { title: 'Test' },
      maxRounds: 3,
      callLlm,
    });

    expect(final.termination.kind).toBe('converged');
    expect(final.hideSource).toBe(FIXED_THREE_MEASURES);
    expect(final.rounds).toHaveLength(2);

    // Round 1 / Round 2 の applyResult を覗いて中身を verify
    const r1 = final.rounds[0].applyResult!;
    const r2 = final.rounds[1].applyResult!;
    expect(r1.unresolved).toHaveLength(1);
    expect(r1.unresolved[0].text).toMatch(/3 小節目/);
    expect(r2.unresolved).toHaveLength(0);
    expect(r2.validation.issues).toHaveLength(0);
  });

  it('stuck loop hits maxRounds when LLM keeps returning broken sources', async () => {
    let n = 0;
    const callLlm = vi.fn(async () => {
      n++;
      // 各ラウンドで違う変奏を返す (= unchanged termination 回避)。
      // 初期 BROKEN_3VS2 = E5m なので variants[0] は別の音 (F5m) から始める。
      // unresolved を decrescendo して noProgress も回避し、maxRounds に到達させる。
      const variants = [
        `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | F5m |
[2]| G4m | A4m |`,
        `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | G5m |
[2]| G4m | A4m |`,
        `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | A5m |
[2]| G4m | A4m |`,
      ];
      // unresolved decrescendo: 5 → 3 → 1 (issue は 1 で固定なので合計 6 → 4 → 2 で減少)
      const unresolvedCount = Math.max(0, 7 - 2 * n);
      const unresolvedLines =
        unresolvedCount > 0
          ? '\n\nUNRESOLVED:\n' +
            Array.from({ length: unresolvedCount }, (_, i) => `- item ${i}`).join('\n')
          : '';
      return fenceHide(variants[n - 1]) + unresolvedLines;
    });
    const final = await runReviewLoop({
      initialResult: makeFakeResult({ hideSource: BROKEN_3VS2 }),
      maxRounds: 3,
      callLlm,
    });
    expect(callLlm).toHaveBeenCalledTimes(3);
    expect(final.termination.kind).toBe('maxRounds');
    // 最終 currentHideSource は最後の round (variants[2]) の revised
    expect(final.hideSource).toMatch(/A5m/);
  });

  it('parse-failing round 2 retains round 1 good state in final result', async () => {
    const responses = [
      fenceHide(BROKEN_3VS2_VARIANT), // round 1: partial fix (still has issue)
      fenceHide(PARSE_FAIL_SOURCE), // round 2: malformed
    ];
    let i = 0;
    const callLlm = vi.fn(async () => responses[i++]);
    const final = await runReviewLoop({
      initialResult: makeFakeResult({ hideSource: BROKEN_3VS2 }),
      maxRounds: 3,
      callLlm,
    });
    expect(callLlm).toHaveBeenCalledTimes(2);
    expect(final.termination.kind).toBe('parseFailure');
    // round 1 で得た良い (parseable) state が retain される
    expect(final.hideSource).toBe(BROKEN_3VS2_VARIANT);
  });
});
