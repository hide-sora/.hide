/**
 * hideHamoringSuggestApply.test.ts — ハモリ提案 LLM 応答 apply layer 単体テスト
 *
 * テスト戦略:
 *   - apply layer は LLM 呼び出しを行わない pure parser なので、
 *     入力 (raw text + 元 .hide + 任意 task) → 出力 (構造化結果) の契約を確認する
 *   - 設計が hideLlmReviewApply と正反対なので、明示的に「あちらにあるが
 *     こちらには無い (UNRESOLVED)」「こちらにあるが あちらには無い (decline /
 *     代替案 / taskCheck)」の差分をカバーする
 *   - silent fill OK / 古典禁則を適用しない / 複数ブロック想定内 — をテストで
 *     反映する: 「複数ブロックは warning 不要」「parallel 5 度は issue ではなく
 *     observation」など
 *   - task-aware soft contract check は 5 種別すべてカバー
 *   - `buildHamoringSuggestPrompt` → mock 応答 → apply の round trip を 1 ケース入れる
 */

import { describe, it, expect } from 'vitest';
import {
  applyHamoringSuggestResponse,
  type HamoringSuggestApplyResult,
} from './hideHamoringSuggestApply';
import { buildHamoringSuggestPrompt } from './hideHamoringSuggest';

// barrel export からも import できるか smoke test
import { applyHamoringSuggestResponse as applyFromBarrel } from './index';

// ============================================================
// テストヘルパー
// ============================================================

/** v1.9 grid form の最小 .hide ソース (2 パート × 2 小節、TIME=4/4 DIV=32) */
const ORIGINAL_TWO_PART = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m |
[2]| G4m | A4m |`;

/** ORIGINAL_TWO_PART の [2] を変更 (parallelFifths は崩れる) */
const REVISED_TWO_PART = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m |
[2]| G4m | F4m |`;

/** 完全な並行 5 度 ([1] C→D / [2] F→G) */
const PARALLEL_FIFTHS_TWO_PART = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m |
[2]| F4m | G4m |`;

/** 1 パート × 1 小節 (差分テスト用、空 original 等) */
const SINGLE_PART_SINGLE_MEASURE = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m |`;

/** Markdown コードフェンスで包む */
function fenceHide(content: string): string {
  return '```hide\n' + content + '\n```';
}

/** 入力を簡潔に作るヘルパー */
function input(
  llmResponse: string,
  originalHideSource: string = ORIGINAL_TWO_PART,
): Parameters<typeof applyHamoringSuggestResponse>[0] {
  return { llmResponse, originalHideSource };
}

// ============================================================
// 基本構造
// ============================================================

describe('applyHamoringSuggestResponse — basic shape', () => {
  it('returns all expected top-level fields', () => {
    const apply = applyHamoringSuggestResponse(
      input('summary\n\n' + fenceHide(REVISED_TWO_PART)),
    );
    expect(apply).toHaveProperty('hideBlockFound');
    expect(apply).toHaveProperty('hideBlockCount');
    expect(apply).toHaveProperty('revisedHideSource');
    expect(apply).toHaveProperty('summaryText');
    expect(apply).toHaveProperty('declined');
    expect(apply).toHaveProperty('validation');
    expect(apply).toHaveProperty('delta');
    expect(apply).toHaveProperty('alternates');
    expect(apply).toHaveProperty('warnings');
    // taskCheck は input.task 省略時は undefined
    expect(apply.taskCheck).toBeUndefined();
  });

  it('extracts a single ```hide``` block exactly', () => {
    const apply = applyHamoringSuggestResponse(input(fenceHide(REVISED_TWO_PART)));
    expect(apply.hideBlockFound).toBe(true);
    expect(apply.hideBlockCount).toBe(1);
    expect(apply.revisedHideSource).toBe(REVISED_TWO_PART);
    expect(apply.declined).toBe(false);
  });

  it('alternates is always an array (empty when only primary exists)', () => {
    const apply = applyHamoringSuggestResponse(input(fenceHide(REVISED_TWO_PART)));
    expect(Array.isArray(apply.alternates)).toBe(true);
    expect(apply.alternates).toHaveLength(0);
  });
});

// ============================================================
// fenced block 抽出
// ============================================================

describe('applyHamoringSuggestResponse — fenced block extraction', () => {
  it('returns hideBlockFound=false and warns when no block is present', () => {
    const apply = applyHamoringSuggestResponse(
      input('そもそも何を提案すればいいか不明です'),
    );
    expect(apply.hideBlockFound).toBe(false);
    expect(apply.hideBlockCount).toBe(0);
    expect(apply.revisedHideSource).toBeUndefined();
    expect(apply.warnings.some((w) => /見つかりませんでした/.test(w))).toBe(true);
  });

  it('extracts a single block', () => {
    const apply = applyHamoringSuggestResponse(input(fenceHide(REVISED_TWO_PART)));
    expect(apply.hideBlockCount).toBe(1);
  });

  it('extracts multiple blocks WITHOUT warning (代替案 is expected)', () => {
    const llmResponse =
      '提案サマリ\n\n' +
      fenceHide(REVISED_TWO_PART) +
      '\n\n代替案 1\n\n' +
      fenceHide(PARALLEL_FIFTHS_TWO_PART);
    const apply = applyHamoringSuggestResponse(input(llmResponse));
    expect(apply.hideBlockCount).toBe(2);
    expect(apply.revisedHideSource).toBe(REVISED_TWO_PART);
    expect(apply.alternates).toHaveLength(1);
    // multiple ブロックは warning 対象ではない
    expect(apply.warnings.some((w) => /複数|2 個/.test(w))).toBe(false);
  });

  it('ignores fenced blocks with non-`hide` language tags', () => {
    const llmResponse =
      '```python\nprint("not hide")\n```\n\n' + fenceHide(REVISED_TWO_PART);
    const apply = applyHamoringSuggestResponse(input(llmResponse));
    expect(apply.hideBlockCount).toBe(1);
    expect(apply.revisedHideSource).toBe(REVISED_TWO_PART);
  });

  it('ignores plain ``` blocks with no language tag', () => {
    const llmResponse = '```\nplain code\n```\n\n' + fenceHide(REVISED_TWO_PART);
    const apply = applyHamoringSuggestResponse(input(llmResponse));
    expect(apply.hideBlockCount).toBe(1);
    expect(apply.revisedHideSource).toBe(REVISED_TWO_PART);
  });

  it('tolerates CRLF line endings', () => {
    const crlfBody = REVISED_TWO_PART.replace(/\n/g, '\r\n');
    const llmResponse = '```hide\r\n' + crlfBody + '\r\n```';
    const apply = applyHamoringSuggestResponse(input(llmResponse));
    expect(apply.hideBlockCount).toBe(1);
    expect(apply.revisedHideSource).toMatch(/\[1\]/);
  });
});

// ============================================================
// 代替案ラベル抽出
// ============================================================

describe('applyHamoringSuggestResponse — 代替案 label extraction', () => {
  it('extracts "代替案 1" label from preceding line', () => {
    const llmResponse =
      fenceHide(REVISED_TWO_PART) +
      '\n\n代替案 1\n\n' +
      fenceHide(PARALLEL_FIFTHS_TWO_PART);
    const apply = applyHamoringSuggestResponse(input(llmResponse));
    expect(apply.alternates[0]!.label).toBe('代替案 1');
  });

  it('extracts "代替案1" (no space) and normalizes to "代替案 1"', () => {
    const llmResponse =
      fenceHide(REVISED_TWO_PART) + '\n\n代替案1\n\n' + fenceHide(PARALLEL_FIFTHS_TWO_PART);
    const apply = applyHamoringSuggestResponse(input(llmResponse));
    expect(apply.alternates[0]!.label).toBe('代替案 1');
  });

  it('strips markdown bold from "**代替案 1**"', () => {
    const llmResponse =
      fenceHide(REVISED_TWO_PART) +
      '\n\n**代替案 1**\n\n' +
      fenceHide(PARALLEL_FIFTHS_TWO_PART);
    const apply = applyHamoringSuggestResponse(input(llmResponse));
    expect(apply.alternates[0]!.label).toBe('代替案 1');
  });

  it('returns undefined when preceding line does not mention 代替案', () => {
    const llmResponse =
      fenceHide(REVISED_TWO_PART) + '\n\n別案あり\n\n' + fenceHide(PARALLEL_FIFTHS_TWO_PART);
    const apply = applyHamoringSuggestResponse(input(llmResponse));
    expect(apply.alternates[0]!.label).toBeUndefined();
  });

  it('preserves order across multiple alternates', () => {
    const llmResponse =
      fenceHide(REVISED_TWO_PART) +
      '\n\n代替案 1\n\n' +
      fenceHide(PARALLEL_FIFTHS_TWO_PART) +
      '\n\n代替案 2\n\n' +
      fenceHide(SINGLE_PART_SINGLE_MEASURE);
    const apply = applyHamoringSuggestResponse(input(llmResponse));
    expect(apply.alternates).toHaveLength(2);
    expect(apply.alternates[0]!.index).toBe(1);
    expect(apply.alternates[0]!.label).toBe('代替案 1');
    expect(apply.alternates[1]!.index).toBe(2);
    expect(apply.alternates[1]!.label).toBe('代替案 2');
  });
});

// ============================================================
// summary text 抽出
// ============================================================

describe('applyHamoringSuggestResponse — summary extraction', () => {
  it('captures text before the first ```hide``` block as summaryText', () => {
    const llmResponse =
      'IIm-V-I を強化するために [2] を F4 に変更しました。\n\n' +
      fenceHide(REVISED_TWO_PART);
    const apply = applyHamoringSuggestResponse(input(llmResponse));
    expect(apply.summaryText).toMatch(/IIm-V-I/);
    expect(apply.summaryText).not.toMatch(/```/);
  });

  it('returns trimmed summaryText', () => {
    const llmResponse = '\n\n  summary  \n\n' + fenceHide(REVISED_TWO_PART);
    const apply = applyHamoringSuggestResponse(input(llmResponse));
    expect(apply.summaryText).toBe('summary');
  });

  it('returns empty summaryText when block has no prelude', () => {
    const apply = applyHamoringSuggestResponse(input(fenceHide(REVISED_TWO_PART)));
    expect(apply.summaryText).toBe('');
  });

  it('falls back to entire response (trimmed) when no fenced block', () => {
    const apply = applyHamoringSuggestResponse(
      input('  すみません、提案できません。  '),
    );
    expect(apply.summaryText).toBe('すみません、提案できません。');
  });
});

// ============================================================
// decline 検出
// ============================================================

describe('applyHamoringSuggestResponse — decline detection', () => {
  it('detects decline when no fence + non-empty summary', () => {
    const apply = applyHamoringSuggestResponse(
      input('提案できません — タスクが現状の編曲と矛盾しています'),
    );
    expect(apply.declined).toBe(true);
    expect(apply.hideBlockFound).toBe(false);
    expect(apply.revisedHideSource).toBeUndefined();
  });

  it('does NOT mark declined when no fence AND empty summary (junk response)', () => {
    const apply = applyHamoringSuggestResponse(input('   \n\n  '));
    expect(apply.declined).toBe(false);
    // 代わりに「shape 不明」warning が出る
    expect(apply.warnings.some((w) => /応答が空|shape/.test(w))).toBe(true);
  });

  it('does NOT mark declined when fence is present (even with summary)', () => {
    const apply = applyHamoringSuggestResponse(
      input('提案します:\n\n' + fenceHide(REVISED_TWO_PART)),
    );
    expect(apply.declined).toBe(false);
  });

  it('decline mode does not produce duplicate "no block" warning', () => {
    const apply = applyHamoringSuggestResponse(
      input('できません'),
    );
    // decline モードでは no-block warning は最初に 1 回だけ出る
    const noBlockWarnings = apply.warnings.filter((w) => /見つかりませんでした/.test(w));
    expect(noBlockWarnings.length).toBeLessThanOrEqual(1);
    // 「shape 不明」warning は decline モードでは出ない
    expect(apply.warnings.some((w) => /応答が空|shape/.test(w))).toBe(false);
  });
});

// ============================================================
// validation (primary)
// ============================================================

describe('applyHamoringSuggestResponse — primary validation', () => {
  it('parses a clean revised source: parsed=true, no issues', () => {
    const apply = applyHamoringSuggestResponse(input(fenceHide(REVISED_TWO_PART)));
    expect(apply.validation.parsed).toBe(true);
    expect(apply.validation.issues).toEqual([]);
    expect(apply.validation.issueKinds).toEqual([]);
    expect(apply.validation.parseError).toBeUndefined();
  });

  it('surfaces measureCountMismatch as issue', () => {
    const broken = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | E5m |
[2]| G4m | A4m |`;
    const apply = applyHamoringSuggestResponse(input(fenceHide(broken)));
    expect(apply.validation.parsed).toBe(true);
    expect(apply.validation.issueKinds).toContain('measureCountMismatch');
  });

  it('surfaces measureDurationMismatch as issue', () => {
    const wrongDur = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5l |
[2]| G4m |`;
    const apply = applyHamoringSuggestResponse(input(fenceHide(wrongDur)));
    expect(apply.validation.parsed).toBe(true);
    expect(apply.validation.issueKinds).toContain('measureDurationMismatch');
  });

  it('reports parsed=false with parseError when revised source is malformed', () => {
    const malformed = `[CLEF:WRONG TIME:4/4 KEY:0 DIV:32]
[1]| C5m |`;
    const apply = applyHamoringSuggestResponse(input(fenceHide(malformed)));
    expect(apply.validation.parsed).toBe(false);
    expect(apply.validation.parseError).toBeDefined();
    expect(apply.validation.issues).toEqual([]);
    expect(apply.validation.chordLabels).toBeUndefined();
    expect(apply.validation.voiceLeadingObservations).toBeUndefined();
  });

  it('reports parsed=false with explicit error when no block was found', () => {
    const apply = applyHamoringSuggestResponse(input('no block here'));
    expect(apply.validation.parsed).toBe(false);
    expect(apply.validation.parseError).toMatch(/no.*hide.*block/i);
  });

  it('issueKinds is sorted unique', () => {
    const both = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5l |
[2]| G4m | A4m |`;
    const apply = applyHamoringSuggestResponse(input(fenceHide(both)));
    const sorted = [...apply.validation.issueKinds].sort();
    expect(apply.validation.issueKinds).toEqual(sorted);
    const set = new Set(apply.validation.issueKinds);
    expect(set.size).toBe(apply.validation.issueKinds.length);
  });

  it('parallel fifths are NOT issues — they live in voiceLeadingObservations', () => {
    const apply = applyHamoringSuggestResponse(input(fenceHide(PARALLEL_FIFTHS_TWO_PART)));
    expect(apply.validation.parsed).toBe(true);
    // matrix の issues にはコード進行の禁則は載らない
    expect(apply.validation.issueKinds).not.toContain('parallelFifths');
    // 代わりに voiceLeadingObservations に observation として現れる
    expect(apply.validation.voiceLeadingObservations).toBeDefined();
    expect(
      apply.validation.voiceLeadingObservations!.some((o) => o.kind === 'parallelFifths'),
    ).toBe(true);
  });
});

// ============================================================
// validation (alternates)
// ============================================================

describe('applyHamoringSuggestResponse — alternates validation', () => {
  it('each alternate has its own validation', () => {
    const llmResponse =
      fenceHide(REVISED_TWO_PART) +
      '\n\n代替案 1\n\n' +
      fenceHide(PARALLEL_FIFTHS_TWO_PART);
    const apply = applyHamoringSuggestResponse(input(llmResponse));
    expect(apply.alternates).toHaveLength(1);
    expect(apply.alternates[0]!.validation.parsed).toBe(true);
    expect(apply.alternates[0]!.validation.voiceLeadingObservations).toBeDefined();
  });

  it('a parse error in the alternate does NOT affect primary validation', () => {
    const llmResponse =
      fenceHide(REVISED_TWO_PART) +
      '\n\n代替案 1\n\n' +
      fenceHide('[CLEF:WRONG TIME:4/4 KEY:0 DIV:32]\n[1]| C5m |');
    const apply = applyHamoringSuggestResponse(input(llmResponse));
    expect(apply.validation.parsed).toBe(true);
    expect(apply.alternates[0]!.validation.parsed).toBe(false);
    expect(apply.alternates[0]!.validation.parseError).toBeDefined();
  });

  it('alternate carries its own parallelFifths observation', () => {
    const llmResponse =
      fenceHide(REVISED_TWO_PART) +
      '\n\n代替案 1\n\n' +
      fenceHide(PARALLEL_FIFTHS_TWO_PART);
    const apply = applyHamoringSuggestResponse(input(llmResponse));
    // primary にはない
    expect(
      apply.validation.voiceLeadingObservations!.some((o) => o.kind === 'parallelFifths'),
    ).toBe(false);
    // alternate にはある
    expect(
      apply.alternates[0]!.validation.voiceLeadingObservations!.some(
        (o) => o.kind === 'parallelFifths',
      ),
    ).toBe(true);
  });
});

// ============================================================
// delta (primary)
// ============================================================

describe('applyHamoringSuggestResponse — primary delta', () => {
  it('reports unchanged=true and warns when proposal is byte-identical', () => {
    const apply = applyHamoringSuggestResponse(input(fenceHide(ORIGINAL_TWO_PART)));
    expect(apply.delta.unchanged).toBe(true);
    expect(apply.delta.addedLines).toEqual([]);
    expect(apply.delta.removedLines).toEqual([]);
    expect(apply.delta.changedParts).toEqual([]);
    expect(apply.warnings.some((w) => /バイト一致/.test(w))).toBe(true);
  });

  it('does NOT emit byte-identical warning when no block was found', () => {
    const apply = applyHamoringSuggestResponse(input('提案できません'));
    expect(apply.warnings.some((w) => /バイト一致/.test(w))).toBe(false);
  });

  it('reports added/removed lines when source differs', () => {
    const apply = applyHamoringSuggestResponse(input(fenceHide(REVISED_TWO_PART)));
    expect(apply.delta.unchanged).toBe(false);
    expect(apply.delta.removedLines).toContain('[2]| G4m | A4m |');
    expect(apply.delta.addedLines).toContain('[2]| G4m | F4m |');
    expect(apply.delta.removedLines).not.toContain('[1]| C5m | D5m |');
  });

  it('reports per-part changedParts', () => {
    const apply = applyHamoringSuggestResponse(input(fenceHide(REVISED_TWO_PART)));
    expect(apply.delta.changedParts).toHaveLength(1);
    const cp = apply.delta.changedParts[0]!;
    expect(cp.label).toBe('2');
    expect(cp.before).toBe('[2]| G4m | A4m |');
    expect(cp.after).toBe('[2]| G4m | F4m |');
  });

  it('detects newly added parts', () => {
    const original = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m |`;
    const revised = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m |
[2]| G4m |`;
    const apply = applyHamoringSuggestResponse(input(fenceHide(revised), original));
    const part2 = apply.delta.changedParts.find((p) => p.label === '2');
    expect(part2).toBeDefined();
    expect(part2!.before).toBeUndefined();
    expect(part2!.after).toBe('[2]| G4m |');
  });

  it('handles empty original hideSource', () => {
    const apply = applyHamoringSuggestResponse(input(fenceHide(SINGLE_PART_SINGLE_MEASURE), ''));
    expect(apply.delta.originalLineCount).toBe(0);
    expect(apply.delta.unchanged).toBe(false);
    expect(apply.delta.addedLines).toContain('[1]| C5m |');
  });
});

// ============================================================
// delta (alternates)
// ============================================================

describe('applyHamoringSuggestResponse — alternate deltas', () => {
  it('each alternate has its delta computed against the ORIGINAL (not primary)', () => {
    const llmResponse =
      fenceHide(REVISED_TWO_PART) +
      '\n\n代替案 1\n\n' +
      fenceHide(PARALLEL_FIFTHS_TWO_PART);
    const apply = applyHamoringSuggestResponse(input(llmResponse));
    // 代替案 vs 元 (REVISED ではなく ORIGINAL)
    // ORIGINAL: [1]| C5m | D5m | + [2]| G4m | A4m |
    // PARALLEL_FIFTHS: [1]| C5m | D5m | + [2]| F4m | G4m |
    expect(apply.alternates[0]!.delta.unchanged).toBe(false);
    expect(apply.alternates[0]!.delta.removedLines).toContain('[2]| G4m | A4m |');
    expect(apply.alternates[0]!.delta.addedLines).toContain('[2]| F4m | G4m |');
  });

  it('alternate equal to original yields unchanged=true', () => {
    const llmResponse =
      fenceHide(REVISED_TWO_PART) + '\n\n代替案 1\n\n' + fenceHide(ORIGINAL_TWO_PART);
    const apply = applyHamoringSuggestResponse(input(llmResponse));
    expect(apply.alternates[0]!.delta.unchanged).toBe(true);
  });
});

// ============================================================
// chord 再計算
// ============================================================

describe('applyHamoringSuggestResponse — chord recomputation', () => {
  it('populates chordLabels when parsed=true', () => {
    const apply = applyHamoringSuggestResponse(input(fenceHide(REVISED_TWO_PART)));
    expect(apply.validation.parsed).toBe(true);
    expect(apply.validation.chordLabels).toBeDefined();
    // 2 小節分の chord ラベル (null も許容)
    expect(apply.validation.chordLabels).toHaveLength(2);
  });

  it('chordLabels is undefined when parsed=false', () => {
    const apply = applyHamoringSuggestResponse(input('no block'));
    expect(apply.validation.parsed).toBe(false);
    expect(apply.validation.chordLabels).toBeUndefined();
  });
});

// ============================================================
// voice leading 再計算
// ============================================================

describe('applyHamoringSuggestResponse — voice leading recomputation', () => {
  it('returns empty observations for clean source', () => {
    const apply = applyHamoringSuggestResponse(input(fenceHide(REVISED_TWO_PART)));
    expect(apply.validation.voiceLeadingObservations).toBeDefined();
    expect(
      apply.validation.voiceLeadingObservations!.filter((o) => o.kind === 'parallelFifths'),
    ).toHaveLength(0);
  });

  it('detects parallelFifths as observation (not as issue)', () => {
    const apply = applyHamoringSuggestResponse(input(fenceHide(PARALLEL_FIFTHS_TWO_PART)));
    // observations に乗る
    expect(
      apply.validation.voiceLeadingObservations!.some((o) => o.kind === 'parallelFifths'),
    ).toBe(true);
    // issues に乗らない (古典禁則を適用しない)
    expect(apply.validation.issues).toEqual([]);
    expect(apply.validation.issueKinds).toEqual([]);
  });
});

// ============================================================
// task check: continue
// ============================================================

describe('applyHamoringSuggestResponse — task check (continue)', () => {
  /** continue task で「元の全ソース + 1 小節追加」を返す full mode */
  const fullModeProposal = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | E5m |
[2]| G4m | A4m | B4m |`;

  /** continue task で「追加分のみ」を返す snippet mode */
  const snippetProposal = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| E5m |
[2]| B4m |`;

  it('detects fullSourceMode when proposal starts with original', () => {
    const apply = applyHamoringSuggestResponse({
      llmResponse: fenceHide(fullModeProposal),
      originalHideSource: ORIGINAL_TWO_PART,
      task: { kind: 'continue', measuresToAdd: 1 },
    });
    expect(apply.taskCheck?.kind).toBe('continue');
    if (apply.taskCheck?.kind === 'continue') {
      expect(apply.taskCheck.fullSourceMode).toBe(true);
      expect(apply.taskCheck.snippetMode).toBe(false);
      expect(apply.taskCheck.measuresAdded).toBe(1);
      expect(apply.taskCheck.warnings).toEqual([]);
    }
  });

  it('detects snippetMode when proposal does not start with original', () => {
    const apply = applyHamoringSuggestResponse({
      llmResponse: fenceHide(snippetProposal),
      originalHideSource: ORIGINAL_TWO_PART,
      task: { kind: 'continue', measuresToAdd: 1 },
    });
    expect(apply.taskCheck?.kind).toBe('continue');
    if (apply.taskCheck?.kind === 'continue') {
      expect(apply.taskCheck.snippetMode).toBe(true);
      expect(apply.taskCheck.fullSourceMode).toBe(false);
      expect(apply.taskCheck.measuresAdded).toBe(1);
    }
  });

  it('warns when measuresAdded < requested', () => {
    const apply = applyHamoringSuggestResponse({
      llmResponse: fenceHide(snippetProposal), // 1 小節追加
      originalHideSource: ORIGINAL_TWO_PART,
      task: { kind: 'continue', measuresToAdd: 4 },
    });
    if (apply.taskCheck?.kind === 'continue') {
      expect(apply.taskCheck.warnings.some((w) => /少ない/.test(w))).toBe(true);
    }
    // top-level warnings にも mirror される
    expect(apply.warnings.some((w) => /\[task=continue\].*少ない/.test(w))).toBe(true);
  });

  it('omits taskCheck entirely when no task is provided', () => {
    const apply = applyHamoringSuggestResponse({
      llmResponse: fenceHide(fullModeProposal),
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.taskCheck).toBeUndefined();
  });
});

// ============================================================
// task check: addPart
// ============================================================

describe('applyHamoringSuggestResponse — task check (addPart)', () => {
  /** [3] パートが追加された */
  const addedPartProposal = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m |
[2]| G4m | A4m |
[3]| E4m | F4m |`;

  /** [3] が追加されたが [2] が変更されてしまった */
  const addedPartButMutated = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m |
[2]| G4m | F4m |
[3]| E4m | F4m |`;

  /** [3] が追加されていない (依頼違反) */
  const noAddedPart = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m |
[2]| G4m | A4m |`;

  it('confirms partLabelAdded=true and existingPartsPreserved=true on clean addPart', () => {
    const apply = applyHamoringSuggestResponse({
      llmResponse: fenceHide(addedPartProposal),
      originalHideSource: ORIGINAL_TWO_PART,
      task: { kind: 'addPart', partLabel: '3' },
    });
    expect(apply.taskCheck?.kind).toBe('addPart');
    if (apply.taskCheck?.kind === 'addPart') {
      expect(apply.taskCheck.partLabelAdded).toBe(true);
      expect(apply.taskCheck.existingPartsPreserved).toBe(true);
      expect(apply.taskCheck.mutatedExistingPartLabels).toEqual([]);
      expect(apply.taskCheck.warnings).toEqual([]);
    }
  });

  it('detects mutated existing parts and warns', () => {
    const apply = applyHamoringSuggestResponse({
      llmResponse: fenceHide(addedPartButMutated),
      originalHideSource: ORIGINAL_TWO_PART,
      task: { kind: 'addPart', partLabel: '3' },
    });
    if (apply.taskCheck?.kind === 'addPart') {
      expect(apply.taskCheck.partLabelAdded).toBe(true);
      expect(apply.taskCheck.existingPartsPreserved).toBe(false);
      expect(apply.taskCheck.mutatedExistingPartLabels).toContain('2');
      expect(apply.taskCheck.warnings.some((w) => /既存パート/.test(w))).toBe(true);
    }
  });

  it('warns when requested partLabel is not added', () => {
    const apply = applyHamoringSuggestResponse({
      llmResponse: fenceHide(noAddedPart),
      originalHideSource: ORIGINAL_TWO_PART,
      task: { kind: 'addPart', partLabel: '3' },
    });
    if (apply.taskCheck?.kind === 'addPart') {
      expect(apply.taskCheck.partLabelAdded).toBe(false);
      expect(apply.taskCheck.warnings.some((w) => /追加されていません/.test(w))).toBe(true);
    }
  });

  it('warns when requested partLabel collides with an existing part', () => {
    const apply = applyHamoringSuggestResponse({
      llmResponse: fenceHide(ORIGINAL_TWO_PART),
      originalHideSource: ORIGINAL_TWO_PART,
      task: { kind: 'addPart', partLabel: '2' }, // 既に存在
    });
    if (apply.taskCheck?.kind === 'addPart') {
      expect(apply.taskCheck.partLabelAdded).toBe(false);
      expect(apply.taskCheck.warnings.some((w) => /衝突/.test(w))).toBe(true);
    }
  });
});

// ============================================================
// task check: fixSection
// ============================================================

describe('applyHamoringSuggestResponse — task check (fixSection)', () => {
  /** 4 小節 original (fixSection / reharmonize テスト用) */
  const FOUR_MEASURE = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | E5m | F5m |
[2]| G4m | A4m | B4m | C5m |`;

  it('passes when changes are inside the requested range', () => {
    const proposal = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | E5m | F5m | F5m |
[2]| G4m | A4m | B4m | C5m |`;
    const apply = applyHamoringSuggestResponse({
      llmResponse: fenceHide(proposal),
      originalHideSource: FOUR_MEASURE,
      task: { kind: 'fixSection', fromMeasure: 2, toMeasure: 3 },
    });
    if (apply.taskCheck?.kind === 'fixSection') {
      expect(apply.taskCheck.outsideRangeUntouched).toBe(true);
      expect(apply.taskCheck.leakedMeasures).toEqual([]);
      expect(apply.taskCheck.warnings).toEqual([]);
    }
  });

  it('detects leakedMeasures when changes happen outside the range', () => {
    // 小節 1 と 2 を変更しているが、依頼は 3〜4
    const proposal = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| E5m | F5m | E5m | F5m |
[2]| G4m | A4m | B4m | C5m |`;
    const apply = applyHamoringSuggestResponse({
      llmResponse: fenceHide(proposal),
      originalHideSource: FOUR_MEASURE,
      task: { kind: 'fixSection', fromMeasure: 3, toMeasure: 4 },
    });
    if (apply.taskCheck?.kind === 'fixSection') {
      expect(apply.taskCheck.outsideRangeUntouched).toBe(false);
      expect(apply.taskCheck.leakedMeasures).toEqual([1, 2]);
      expect(apply.taskCheck.warnings.some((w) => /範囲.*外/.test(w))).toBe(true);
    }
  });

  it('runs even when proposal has matrix issues (soft check)', () => {
    // measureCount mismatch を含む proposal
    const proposal = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | E5m | F5m | G5m |
[2]| G4m | A4m | B4m | C5m |`;
    const apply = applyHamoringSuggestResponse({
      llmResponse: fenceHide(proposal),
      originalHideSource: FOUR_MEASURE,
      task: { kind: 'fixSection', fromMeasure: 2, toMeasure: 3 },
    });
    expect(apply.validation.parsed).toBe(true);
    expect(apply.validation.issueKinds).toContain('measureCountMismatch');
    // taskCheck は走る (parsed=true なので)
    expect(apply.taskCheck?.kind).toBe('fixSection');
  });
});

// ============================================================
// task check: reharmonize
// ============================================================

describe('applyHamoringSuggestResponse — task check (reharmonize)', () => {
  /** トップ声部 [1] がメロディ / 4 小節 */
  const FOUR_MEASURE_REHARMONIZE = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | E5m | F5m |
[2]| G4m | A4m | B4m | C5m |`;

  it('passes when only the lower voice changes inside the range (melody preserved)', () => {
    const proposal = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | E5m | F5m |
[2]| G4m | F4m | A4m | C5m |`;
    const apply = applyHamoringSuggestResponse({
      llmResponse: fenceHide(proposal),
      originalHideSource: FOUR_MEASURE_REHARMONIZE,
      task: { kind: 'reharmonize', fromMeasure: 2, toMeasure: 3 },
    });
    if (apply.taskCheck?.kind === 'reharmonize') {
      expect(apply.taskCheck.outsideRangeUntouched).toBe(true);
      expect(apply.taskCheck.leakedMeasures).toEqual([]);
      expect(apply.taskCheck.topPartPreservedInRange).toBe(true);
      expect(apply.taskCheck.warnings).toEqual([]);
    }
  });

  it('detects melody change inside the range and warns', () => {
    const proposal = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | F5m | G5m | F5m |
[2]| G4m | A4m | B4m | C5m |`;
    const apply = applyHamoringSuggestResponse({
      llmResponse: fenceHide(proposal),
      originalHideSource: FOUR_MEASURE_REHARMONIZE,
      task: { kind: 'reharmonize', fromMeasure: 2, toMeasure: 3 },
    });
    if (apply.taskCheck?.kind === 'reharmonize') {
      expect(apply.taskCheck.topPartPreservedInRange).toBe(false);
      expect(apply.taskCheck.warnings.some((w) => /メロディ/.test(w))).toBe(true);
    }
  });

  it('detects out-of-range leak in reharmonize', () => {
    const proposal = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | E5m | F5m |
[2]| F4m | A4m | B4m | E4m |`;
    const apply = applyHamoringSuggestResponse({
      llmResponse: fenceHide(proposal),
      originalHideSource: FOUR_MEASURE_REHARMONIZE,
      task: { kind: 'reharmonize', fromMeasure: 2, toMeasure: 3 },
    });
    if (apply.taskCheck?.kind === 'reharmonize') {
      expect(apply.taskCheck.outsideRangeUntouched).toBe(false);
      expect(apply.taskCheck.leakedMeasures).toEqual(expect.arrayContaining([1, 4]));
    }
  });
});

// ============================================================
// task check: freeform
// ============================================================

describe('applyHamoringSuggestResponse — task check (freeform)', () => {
  it('returns a placeholder freeform check (no semantic contract)', () => {
    const apply = applyHamoringSuggestResponse({
      llmResponse: fenceHide(REVISED_TWO_PART),
      originalHideSource: ORIGINAL_TWO_PART,
      task: { kind: 'freeform', userQuery: 'もっとジャズっぽくして' },
    });
    expect(apply.taskCheck?.kind).toBe('freeform');
    if (apply.taskCheck?.kind === 'freeform') {
      expect(apply.taskCheck.warnings).toEqual([]);
    }
  });
});

// ============================================================
// 統合: 実 LLM 応答風の入力
// ============================================================

describe('applyHamoringSuggestResponse — realistic LLM responses', () => {
  it('handles a typical full response (summary + primary + 2 alternates)', () => {
    const llmResponse = `[2] のメロディラインをよりリッチにする提案です。

主案では F4 → E4 へ進行させて C メジャースケール内に収め、代替案ではより動的なラインを試しています。

${fenceHide(REVISED_TWO_PART)}

**代替案 1**

並行 5 度を活かしたパワーコード風アレンジ。

${fenceHide(PARALLEL_FIFTHS_TWO_PART)}

**代替案 2**

シンプルに [2] を 1 オクターブ下げる案。

${fenceHide('[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]\n[1]| C5m | D5m |\n[2]| G3m | A3m |')}`;

    const apply = applyHamoringSuggestResponse(input(llmResponse));

    expect(apply.hideBlockCount).toBe(3);
    expect(apply.revisedHideSource).toBe(REVISED_TWO_PART);
    expect(apply.alternates).toHaveLength(2);
    expect(apply.alternates[0]!.label).toBe('代替案 1');
    expect(apply.alternates[1]!.label).toBe('代替案 2');
    expect(apply.summaryText).toMatch(/メロディラインをよりリッチに/);
    expect(apply.declined).toBe(false);
    expect(apply.validation.parsed).toBe(true);
    expect(apply.alternates[0]!.validation.parsed).toBe(true);
    expect(apply.alternates[1]!.validation.parsed).toBe(true);
  });

  it('handles a decline response (no fence + explanation)', () => {
    const llmResponse =
      '提案できません — 現状のソースは matrix mode で 0 小節しかなく、追加すべき場所が分かりません。先に少なくとも 1 小節を追加してから再度依頼してください。';
    const apply = applyHamoringSuggestResponse(input(llmResponse));

    expect(apply.declined).toBe(true);
    expect(apply.hideBlockFound).toBe(false);
    expect(apply.revisedHideSource).toBeUndefined();
    expect(apply.summaryText).toMatch(/提案できません/);
    expect(apply.validation.parsed).toBe(false);
  });

  it('handles a partially-broken alternate (primary good, alternate parse error)', () => {
    const llmResponse =
      '主案 OK、代替案は実験的:\n\n' +
      fenceHide(REVISED_TWO_PART) +
      '\n\n代替案 1\n\n' +
      fenceHide('[CLEF:WRONG TIME:4/4]\n[1]| C5m |');

    const apply = applyHamoringSuggestResponse(input(llmResponse));
    expect(apply.validation.parsed).toBe(true);
    expect(apply.alternates[0]!.validation.parsed).toBe(false);
    expect(apply.alternates[0]!.validation.parseError).toBeDefined();
  });

  it('round trip: buildHamoringSuggestPrompt → mock response → apply', () => {
    // 1. prompt を組み立てる (実際は使わないが、build → apply の互換性確認)
    const prompt = buildHamoringSuggestPrompt({
      hideSource: ORIGINAL_TWO_PART,
      task: { kind: 'addPart', partLabel: '3' },
    });
    expect(prompt.systemPrompt).toContain('アカペラ');

    // 2. mock 応答 (LLM が返しそうなもの)
    const mockResponse =
      '[3] にアルトラインを追加しました:\n\n' +
      fenceHide(`[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m |
[2]| G4m | A4m |
[3]| E4m | F4m |`);

    // 3. apply で解析 (task を渡して taskCheck も走らせる)
    const apply = applyHamoringSuggestResponse({
      llmResponse: mockResponse,
      originalHideSource: ORIGINAL_TWO_PART,
      task: { kind: 'addPart', partLabel: '3' },
    });

    expect(apply.hideBlockFound).toBe(true);
    expect(apply.validation.parsed).toBe(true);
    expect(apply.taskCheck?.kind).toBe('addPart');
    if (apply.taskCheck?.kind === 'addPart') {
      expect(apply.taskCheck.partLabelAdded).toBe(true);
      expect(apply.taskCheck.existingPartsPreserved).toBe(true);
    }
  });
});

// ============================================================
// 契約不変量
// ============================================================

describe('applyHamoringSuggestResponse — contractual invariants', () => {
  it('hideBlockCount === 0 ⇒ revisedHideSource === undefined', () => {
    const apply = applyHamoringSuggestResponse(input('提案できません'));
    expect(apply.hideBlockCount).toBe(0);
    expect(apply.revisedHideSource).toBeUndefined();
  });

  it('alternates.length === hideBlockCount - 1 (when blocks > 0)', () => {
    const llmResponse =
      fenceHide(REVISED_TWO_PART) +
      '\n\n代替案 1\n\n' +
      fenceHide(PARALLEL_FIFTHS_TWO_PART) +
      '\n\n代替案 2\n\n' +
      fenceHide(SINGLE_PART_SINGLE_MEASURE);
    const apply = applyHamoringSuggestResponse(input(llmResponse));
    expect(apply.hideBlockCount).toBe(3);
    expect(apply.alternates.length).toBe(apply.hideBlockCount - 1);
  });

  it('parsed=true ⇒ chordLabels and voiceLeadingObservations are both present', () => {
    const apply = applyHamoringSuggestResponse(input(fenceHide(REVISED_TWO_PART)));
    expect(apply.validation.parsed).toBe(true);
    expect(apply.validation.chordLabels).toBeDefined();
    expect(apply.validation.voiceLeadingObservations).toBeDefined();
  });

  it('input.task omitted ⇒ taskCheck is undefined', () => {
    const apply = applyHamoringSuggestResponse(input(fenceHide(REVISED_TWO_PART)));
    expect(apply.taskCheck).toBeUndefined();
  });
});

// ============================================================
// barrel export 互換性
// ============================================================

describe('applyHamoringSuggestResponse — barrel export', () => {
  it('is reachable through ./index', () => {
    const apply = applyFromBarrel(input(fenceHide(REVISED_TWO_PART)));
    const _typed: HamoringSuggestApplyResult = apply;
    expect(_typed.hideBlockFound).toBe(true);
  });
});
