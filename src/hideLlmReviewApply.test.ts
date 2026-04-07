/**
 * hideLlmReviewApply.test.ts — LLM レビュー pipeline の apply layer 単体テスト
 *
 * テスト戦略:
 *   - apply layer は LLM 呼び出しを行わない pure parser なので、
 *     入力 (raw text) → 出力 (構造化結果) の契約をひたすら確認する
 *   - フェンス抽出 / summary 抽出 / UNRESOLVED 抽出 / validation /
 *     delta 計算 をそれぞれ独立にカバーする
 *   - silent fill 禁止という設計を反映: 「LLM 応答を再検証して残存 issue を
 *     surface する」「未変更時に warning が出る」を確認
 *   - 実 LLM 応答風のテキストを使った integration ケースも入れる
 */

import { describe, it, expect } from 'vitest';
import { applyLlmReviewResponse } from './hideLlmReviewApply';

// ============================================================
// テストヘルパー
// ============================================================

/** v1.9 grid form の最小 .hide ソース (2 パート × 2 小節、TIME=4/4 DIV=32) */
const ORIGINAL_TWO_PART = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m |
[2]| G4m | A4m |`;

/** ORIGINAL_TWO_PART の [2] を変更したもの */
const REVISED_TWO_PART = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m |
[2]| G4m | F4m |`;

/** Markdown コードフェンスで包む */
function fenceHide(content: string): string {
  return '```hide\n' + content + '\n```';
}

// ============================================================
// 基本構造
// ============================================================

describe('applyLlmReviewResponse — basic shape', () => {
  it('returns all expected fields', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: '修正サマリ\n\n' + fenceHide(REVISED_TWO_PART),
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply).toHaveProperty('hideBlockFound');
    expect(apply).toHaveProperty('hideBlockCount');
    expect(apply).toHaveProperty('revisedHideSource');
    expect(apply).toHaveProperty('summaryText');
    expect(apply).toHaveProperty('unresolved');
    expect(apply).toHaveProperty('validation');
    expect(apply).toHaveProperty('delta');
    expect(apply).toHaveProperty('warnings');
  });

  it('extracts a single ```hide``` block exactly', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: fenceHide(REVISED_TWO_PART),
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.hideBlockFound).toBe(true);
    expect(apply.hideBlockCount).toBe(1);
    expect(apply.revisedHideSource).toBe(REVISED_TWO_PART);
    expect(apply.warnings).toHaveLength(0);
  });
});

// ============================================================
// fenced block 抽出
// ============================================================

describe('applyLlmReviewResponse — fenced block extraction', () => {
  it('returns hideBlockFound=false and warns when no block is present', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: 'I have no idea what to do with this.',
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.hideBlockFound).toBe(false);
    expect(apply.hideBlockCount).toBe(0);
    expect(apply.revisedHideSource).toBeUndefined();
    expect(apply.warnings.some(w => /見つかりませんでした/.test(w))).toBe(true);
  });

  it('takes the first block and warns when multiple ```hide``` blocks are present', () => {
    const llmResponse =
      '## Attempt A\n' +
      fenceHide('[1]| C5m |') +
      '\n\n## Attempt B\n' +
      fenceHide('[1]| D5m |');
    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: '[1]| C5m |',
    });
    expect(apply.hideBlockCount).toBe(2);
    expect(apply.revisedHideSource).toBe('[1]| C5m |');
    expect(apply.warnings.some(w => /2 個/.test(w))).toBe(true);
  });

  it('ignores fenced blocks with non-`hide` language tags', () => {
    const llmResponse =
      '```python\nprint("not hide")\n```\n\n' + fenceHide(REVISED_TWO_PART);
    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.hideBlockCount).toBe(1);
    expect(apply.revisedHideSource).toBe(REVISED_TWO_PART);
  });

  it('ignores plain ``` blocks with no language tag', () => {
    const llmResponse = '```\nplain code\n```\n\n' + fenceHide(REVISED_TWO_PART);
    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.hideBlockCount).toBe(1);
    expect(apply.revisedHideSource).toBe(REVISED_TWO_PART);
  });

  it('tolerates whitespace around the language tag', () => {
    const llmResponse = '```  hide  \n' + REVISED_TWO_PART + '\n```';
    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.hideBlockCount).toBe(1);
    expect(apply.revisedHideSource).toBe(REVISED_TWO_PART);
  });

  it('tolerates CRLF line endings', () => {
    // Construct a CRLF response from scratch (avoid double-replacement bugs)
    const crlfBody = REVISED_TWO_PART.replace(/\n/g, '\r\n');
    const llmResponse = '```hide\r\n' + crlfBody + '\r\n```';
    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.hideBlockCount).toBe(1);
    // Note: 内容自体は CRLF のままになる (ライン splitter は CRLF/LF 両対応)
    expect(apply.revisedHideSource).toMatch(/\[1\]/);
  });
});

// ============================================================
// summary text 抽出
// ============================================================

describe('applyLlmReviewResponse — summary extraction', () => {
  it('captures text before the ```hide``` block as summaryText', () => {
    const llmResponse =
      '小節 2 の和音を修正しました。\n根拠: 画像と照合\n\n' + fenceHide(REVISED_TWO_PART);
    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.summaryText).toMatch(/小節 2 の和音を修正しました/);
    expect(apply.summaryText).toMatch(/画像と照合/);
    // ```hide``` 以降は summary に入らない
    expect(apply.summaryText).not.toMatch(/```/);
  });

  it('returns trimmed summaryText (no leading/trailing whitespace)', () => {
    const llmResponse = '\n\n  summary  \n\n' + fenceHide(REVISED_TWO_PART);
    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.summaryText).toBe('summary');
  });

  it('returns empty summaryText when block has no prelude', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: fenceHide(REVISED_TWO_PART),
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.summaryText).toBe('');
  });

  it('falls back to entire response when no fenced block (minus UNRESOLVED)', () => {
    const llmResponse = 'I cannot fix this.\n\nUNRESOLVED:\n- everything';
    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.summaryText).toBe('I cannot fix this.');
  });

  it('returns the whole text as summary when no block and no UNRESOLVED', () => {
    const llmResponse = 'just some commentary, no block';
    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.summaryText).toBe('just some commentary, no block');
  });
});

// ============================================================
// UNRESOLVED 抽出
// ============================================================

describe('applyLlmReviewResponse — UNRESOLVED extraction', () => {
  it('extracts bullet items after the ```hide``` block', () => {
    const llmResponse =
      fenceHide(REVISED_TWO_PART) +
      '\n\nUNRESOLVED:\n- 小節 5 が画像で欠けている\n- 小節 7 の音価が不明';
    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.unresolved).toHaveLength(2);
    expect(apply.unresolved[0].text).toBe('小節 5 が画像で欠けている');
    expect(apply.unresolved[0].index).toBe(1);
    expect(apply.unresolved[1].text).toBe('小節 7 の音価が不明');
    expect(apply.unresolved[1].index).toBe(2);
  });

  it('returns empty array when no UNRESOLVED section is present', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: fenceHide(REVISED_TWO_PART),
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.unresolved).toEqual([]);
  });

  it('strips `* ` bullet prefix', () => {
    const llmResponse =
      fenceHide(REVISED_TWO_PART) + '\n\nUNRESOLVED:\n* item one\n* item two';
    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.unresolved.map(u => u.text)).toEqual(['item one', 'item two']);
  });

  it('strips `+ ` bullet prefix', () => {
    const llmResponse =
      fenceHide(REVISED_TWO_PART) + '\n\nUNRESOLVED:\n+ item one';
    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.unresolved.map(u => u.text)).toEqual(['item one']);
  });

  it('strips numbered prefixes (`1. ` and `1) `)', () => {
    const llmResponse =
      fenceHide(REVISED_TWO_PART) +
      '\n\nUNRESOLVED:\n1. item one\n2) item two';
    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.unresolved.map(u => u.text)).toEqual(['item one', 'item two']);
  });

  it('captures inline content on the UNRESOLVED header line', () => {
    const llmResponse =
      fenceHide(REVISED_TWO_PART) + '\n\nUNRESOLVED: 全体的に画像が不鮮明';
    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.unresolved).toHaveLength(1);
    expect(apply.unresolved[0].text).toBe('全体的に画像が不鮮明');
  });

  it('captures inline content + subsequent bullets', () => {
    const llmResponse =
      fenceHide(REVISED_TWO_PART) +
      '\n\nUNRESOLVED: 全体的に画像が不鮮明\n- 小節 5\n- 小節 7';
    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.unresolved.map(u => u.text)).toEqual([
      '全体的に画像が不鮮明',
      '小節 5',
      '小節 7',
    ]);
  });

  it('matches case-insensitively (Unresolved / UNRESOLVED)', () => {
    const llmResponse =
      fenceHide(REVISED_TWO_PART) + '\n\nUnresolved:\n- one';
    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.unresolved.map(u => u.text)).toEqual(['one']);
  });

  it('does NOT extract UNRESOLVED text that appears INSIDE the ```hide``` block', () => {
    // hide ソース内のコメントに UNRESOLVED と書いてあるが、
    // apply 層は block 内を検索範囲から除外するので拾わない
    const llmResponse =
      '```hide\n' +
      '[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32] ; UNRESOLVED: this is inside\n' +
      '[1]| C5m |\n' +
      '```';
    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: '[1]| C5m |',
    });
    expect(apply.unresolved).toEqual([]);
  });

  it('still finds UNRESOLVED when no ```hide``` block was extracted', () => {
    const llmResponse =
      'I cannot help.\n\nUNRESOLVED:\n- nothing in image\n- everything is broken';
    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.unresolved.map(u => u.text)).toEqual([
      'nothing in image',
      'everything is broken',
    ]);
  });

  it('stops extraction at the next markdown heading', () => {
    const llmResponse =
      fenceHide(REVISED_TWO_PART) +
      '\n\nUNRESOLVED:\n- one\n- two\n\n## next section\n- not an unresolved item';
    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.unresolved.map(u => u.text)).toEqual(['one', 'two']);
  });
});

// ============================================================
// validation (analyzeMatrix で再パース)
// ============================================================

describe('applyLlmReviewResponse — validation', () => {
  it('reports parsed=true and zero issues for a clean revised source', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: fenceHide(REVISED_TWO_PART),
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.validation.parsed).toBe(true);
    expect(apply.validation.issues).toEqual([]);
    expect(apply.validation.issueKinds).toEqual([]);
    expect(apply.validation.parseError).toBeUndefined();
  });

  it('surfaces matrix issues when revised source has measure count mismatch', () => {
    // [1] = 3 小節 / [2] = 2 小節 → measureCountMismatch
    const broken = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | E5m |
[2]| G4m | A4m |`;
    const apply = applyLlmReviewResponse({
      llmResponse: fenceHide(broken),
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.validation.parsed).toBe(true);
    expect(apply.validation.issueKinds).toContain('measureCountMismatch');
    expect(apply.validation.issues.length).toBeGreaterThan(0);
  });

  it('surfaces measureDurationMismatch when a cell has wrong duration', () => {
    // 4/4 では 32u 期待だが [1] 1 小節目は 16u (l = 2分) しか入っていない
    const wrongDur = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5l |
[2]| G4m |`;
    const apply = applyLlmReviewResponse({
      llmResponse: fenceHide(wrongDur),
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.validation.parsed).toBe(true);
    expect(apply.validation.issueKinds).toContain('measureDurationMismatch');
  });

  it('reports parsed=false with parseError when revised source is malformed', () => {
    // 不正メタコマンド (lexer が HideParseError を投げる種別)
    const malformed = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[BADMETA]
[1]| C5m |`;
    const apply = applyLlmReviewResponse({
      llmResponse: fenceHide(malformed),
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.validation.parsed).toBe(false);
    expect(apply.validation.parseError).toBeDefined();
    expect(apply.validation.issues).toEqual([]);
  });

  it('reports parsed=false with explicit error when no block was found', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: 'no block here',
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.validation.parsed).toBe(false);
    expect(apply.validation.parseError).toMatch(/no.*hide.*block/i);
  });

  it('issueKinds is sorted unique', () => {
    // 複数 issue 発生: 小節数違い + duration 違い
    const both = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5l |
[2]| G4m | A4m |`;
    const apply = applyLlmReviewResponse({
      llmResponse: fenceHide(both),
      originalHideSource: ORIGINAL_TWO_PART,
    });
    const sorted = [...apply.validation.issueKinds].sort();
    expect(apply.validation.issueKinds).toEqual(sorted);
    // unique
    const set = new Set(apply.validation.issueKinds);
    expect(set.size).toBe(apply.validation.issueKinds.length);
  });
});

// ============================================================
// delta 計算
// ============================================================

describe('applyLlmReviewResponse — delta computation', () => {
  it('reports unchanged=true when revised source is byte-identical', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: fenceHide(ORIGINAL_TWO_PART),
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.delta.unchanged).toBe(true);
    expect(apply.delta.addedLines).toEqual([]);
    expect(apply.delta.removedLines).toEqual([]);
    expect(apply.delta.changedParts).toEqual([]);
  });

  it('warns when revised source equals original (LLM made no changes)', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: fenceHide(ORIGINAL_TWO_PART),
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.warnings.some(w => /変更を加えなかった/.test(w))).toBe(true);
  });

  it('does NOT warn-unchanged when no block was found (avoid double-warning)', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: 'no block',
      originalHideSource: ORIGINAL_TWO_PART,
    });
    // unchanged-warning は ブロックがあった場合のみ
    expect(apply.warnings.some(w => /変更を加えなかった/.test(w))).toBe(false);
    // 代わりに「ブロックが見つかりません」warning は出る
    expect(apply.warnings.some(w => /見つかりませんでした/.test(w))).toBe(true);
  });

  it('reports added/removed lines when source differs', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: fenceHide(REVISED_TWO_PART),
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.delta.unchanged).toBe(false);
    // [2]| G4m | A4m | が消え、[2]| G4m | F4m | が追加
    expect(apply.delta.removedLines).toContain('[2]| G4m | A4m |');
    expect(apply.delta.addedLines).toContain('[2]| G4m | F4m |');
    // [1] とヘッダーは変わっていないので含まれない
    expect(apply.delta.removedLines).not.toContain('[1]| C5m | D5m |');
    expect(apply.delta.addedLines).not.toContain('[1]| C5m | D5m |');
  });

  it('reports per-part changes via changedParts', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: fenceHide(REVISED_TWO_PART),
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.delta.changedParts).toHaveLength(1);
    const cp = apply.delta.changedParts[0];
    expect(cp.label).toBe('2');
    expect(cp.before).toBe('[2]| G4m | A4m |');
    expect(cp.after).toBe('[2]| G4m | F4m |');
  });

  it('detects newly added parts (label only in revised)', () => {
    const original = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m |`;
    const revised = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m |
[2]| G4m |`;
    const apply = applyLlmReviewResponse({
      llmResponse: fenceHide(revised),
      originalHideSource: original,
    });
    const part2 = apply.delta.changedParts.find(p => p.label === '2');
    expect(part2).toBeDefined();
    expect(part2!.before).toBeUndefined();
    expect(part2!.after).toBe('[2]| G4m |');
  });

  it('detects deleted parts (label only in original)', () => {
    const original = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m |
[2]| G4m |`;
    const revised = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m |`;
    const apply = applyLlmReviewResponse({
      llmResponse: fenceHide(revised),
      originalHideSource: original,
    });
    const part2 = apply.delta.changedParts.find(p => p.label === '2');
    expect(part2).toBeDefined();
    expect(part2!.before).toBe('[2]| G4m |');
    expect(part2!.after).toBeUndefined();
  });

  it('reports correct line counts', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: fenceHide(REVISED_TWO_PART),
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.delta.originalLineCount).toBe(3); // header + 2 part lines
    expect(apply.delta.revisedLineCount).toBe(3);
  });

  it('handles missing block: all original lines as removed, no added', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: 'no block at all',
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.delta.unchanged).toBe(false);
    expect(apply.delta.addedLines).toEqual([]);
    expect(apply.delta.removedLines.length).toBe(3); // all original lines
    expect(apply.delta.revisedLineCount).toBe(0);
    // changedParts: 元の 2 パートが消えた扱い
    expect(apply.delta.changedParts.map(p => p.label).sort()).toEqual(['1', '2']);
    for (const cp of apply.delta.changedParts) {
      expect(cp.after).toBeUndefined();
    }
  });

  it('handles empty original hideSource gracefully', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: fenceHide('[1]| C5m |'),
      originalHideSource: '',
    });
    expect(apply.delta.originalLineCount).toBe(0);
    expect(apply.delta.unchanged).toBe(false);
    expect(apply.delta.addedLines).toContain('[1]| C5m |');
  });
});

// ============================================================
// 統合: 実 LLM 応答風の入力
// ============================================================

describe('applyLlmReviewResponse — realistic LLM responses', () => {
  it('handles a typical full response (summary + block + UNRESOLVED)', () => {
    const llmResponse = `画像と照合した結果、以下を修正しました:
- 小節 2 の [2] の音を A4 → F4 に変更 (画像では明らかに F4)
- 他の小節は画像と一致しているので変更なし

${fenceHide(REVISED_TWO_PART)}

UNRESOLVED:
- 小節 1 のスラーは画像で確認できなかった`;

    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });

    // 構造: ブロック 1 個、変更あり、UNRESOLVED 1 件
    expect(apply.hideBlockFound).toBe(true);
    expect(apply.hideBlockCount).toBe(1);
    expect(apply.revisedHideSource).toBe(REVISED_TWO_PART);

    // summary に修正の根拠が入っている
    expect(apply.summaryText).toMatch(/A4 → F4/);
    expect(apply.summaryText).toMatch(/画像と照合/);

    // unresolved
    expect(apply.unresolved).toHaveLength(1);
    expect(apply.unresolved[0].text).toMatch(/スラー/);

    // validation: clean
    expect(apply.validation.parsed).toBe(true);
    expect(apply.validation.issues).toEqual([]);

    // delta: [2] パートが変わった
    expect(apply.delta.unchanged).toBe(false);
    expect(apply.delta.changedParts.map(p => p.label)).toEqual(['2']);

    // warnings: なし (ブロック 1 個 + 変更あり + clean)
    expect(apply.warnings).toEqual([]);
  });

  it('handles a "I cannot fix anything" response gracefully', () => {
    const llmResponse = `画像が不鮮明で何も判別できませんでした。元のソースをそのまま残します。

${fenceHide(ORIGINAL_TWO_PART)}

UNRESOLVED:
- 全体的に画像が不鮮明で照合不可`;

    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });

    expect(apply.hideBlockFound).toBe(true);
    expect(apply.delta.unchanged).toBe(true);
    // unchanged-warning が出る
    expect(apply.warnings.some(w => /変更を加えなかった/.test(w))).toBe(true);
    // unresolved 1 件
    expect(apply.unresolved).toHaveLength(1);
    expect(apply.unresolved[0].text).toMatch(/不鮮明/);
    // validation は clean
    expect(apply.validation.parsed).toBe(true);
  });

  it('surfaces residual issues from a partially-fixed response (loop trigger)', () => {
    // LLM が「[2] の小節を 1 つ追加し忘れた」状態 → measureCountMismatch
    const partiallyFixed = `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
[1]| C5m | D5m | E5m |
[2]| G4m | A4m |`;
    const llmResponse =
      '部分的に修正:\n\n' +
      fenceHide(partiallyFixed) +
      '\n\nUNRESOLVED:\n- [2] の 3 小節目が画像で読めない';

    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });

    // 構造はパースできる
    expect(apply.validation.parsed).toBe(true);
    // が、measureCountMismatch が残っている → 次ラウンドの呼び出し側で
    // 「ループするか諦めるか」を判定するためのシグナルになる
    expect(apply.validation.issueKinds).toContain('measureCountMismatch');
    // UNRESOLVED にも対応する記述がある
    expect(apply.unresolved[0].text).toMatch(/3 小節目/);
  });

  it('handles a response with parse-failing revised source (fatal LLM corruption)', () => {
    // LLM が壊れたヘッダーを返した状況: CLEF 値が未知 → HideParseError
    const llmResponse =
      'ここに修正があります\n\n' +
      fenceHide('[CLEF:WRONG TIME:4/4 KEY:0 DIV:32]\n[1]| C5m |');

    const apply = applyLlmReviewResponse({
      llmResponse,
      originalHideSource: ORIGINAL_TWO_PART,
    });

    expect(apply.hideBlockFound).toBe(true);
    expect(apply.validation.parsed).toBe(false);
    expect(apply.validation.parseError).toBeDefined();
    expect(apply.validation.issues).toEqual([]); // パース失敗時は issues も空
    // delta は計算される (raw text レベル)
    expect(apply.delta.unchanged).toBe(false);
  });
});

// ============================================================
// regression: 全フィールドの contractual properties
// ============================================================

describe('applyLlmReviewResponse — contractual invariants', () => {
  it('hideBlockCount === 0 implies hideBlockFound === false', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: 'no block',
      originalHideSource: '',
    });
    expect(apply.hideBlockCount).toBe(0);
    expect(apply.hideBlockFound).toBe(false);
    expect(apply.revisedHideSource).toBeUndefined();
  });

  it('hideBlockCount > 0 implies hideBlockFound === true', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: fenceHide('[1]| C5m |'),
      originalHideSource: '',
    });
    expect(apply.hideBlockCount).toBeGreaterThan(0);
    expect(apply.hideBlockFound).toBe(true);
    expect(apply.revisedHideSource).toBeDefined();
  });

  it('validation.parsed === false when revisedHideSource is undefined', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: '',
      originalHideSource: '',
    });
    expect(apply.revisedHideSource).toBeUndefined();
    expect(apply.validation.parsed).toBe(false);
  });

  it('unresolved indices are 1-based and sequential', () => {
    const apply = applyLlmReviewResponse({
      llmResponse:
        fenceHide('[1]| C5m |') + '\n\nUNRESOLVED:\n- a\n- b\n- c\n- d',
      originalHideSource: '[1]| C5m |',
    });
    expect(apply.unresolved.map(u => u.index)).toEqual([1, 2, 3, 4]);
  });

  it('delta.unchanged === true implies addedLines/removedLines/changedParts are all empty', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: fenceHide(ORIGINAL_TWO_PART),
      originalHideSource: ORIGINAL_TWO_PART,
    });
    expect(apply.delta.unchanged).toBe(true);
    expect(apply.delta.addedLines).toEqual([]);
    expect(apply.delta.removedLines).toEqual([]);
    expect(apply.delta.changedParts).toEqual([]);
  });

  it('all top-level fields are always defined (no optional that becomes undefined)', () => {
    const apply = applyLlmReviewResponse({
      llmResponse: '',
      originalHideSource: '',
    });
    expect(apply.summaryText).toBeDefined();
    expect(Array.isArray(apply.unresolved)).toBe(true);
    expect(apply.validation).toBeDefined();
    expect(apply.delta).toBeDefined();
    expect(Array.isArray(apply.warnings)).toBe(true);
  });
});
