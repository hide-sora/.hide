/**
 * hideHamoringSuggest.test.ts — ハモリ提案 prompt builder の単体テスト
 *
 * テスト戦略:
 *   - prompt builder は LLM 呼び出しを行わない pure function なので、
 *     入力 → 出力の構造的な性質をひたすら確認する
 *   - 「5 種別のタスクごとに正しいセクションが組まれる」「voice leading
 *     observation が caution として framing されている」「ポップジャンル前提の
 *     system prompt 内容」など contractual properties を中心に検証
 *   - hideLlmReview とは正反対の前提 (silent fill OK / 古典禁則を適用しない /
 *     画像不要) が system prompt に明示されているかも確認
 *   - validation エラー (negative measure / empty string 等) は throw
 */

import { describe, it, expect } from 'vitest';
import { buildHamoringSuggestPrompt } from './hideHamoringSuggest';
import type {
  HamoringSuggestInput,
  HamoringSuggestTask,
} from './hideHamoringSuggest';

// ============================================================
// テストヘルパー
// ============================================================

/** 4 小節 × 2 パートの「クリーン」な編曲 (voice leading caution が出にくい) */
const CLEAN_TWO_PART = '[1]| C5m | E5m | G5m | C5m |\n[2]| C4m | C4m | C4m | C4m |';

/** 平行 5 度を含む 2 小節 × 2 パート (caution が浮上する) */
const PARALLEL_FIFTHS = '[1]| C5m | D5m |\n[2]| F4m | G4m |';

function buildContinue(measuresToAdd: number, styleHint?: string): HamoringSuggestTask {
  return styleHint !== undefined
    ? { kind: 'continue', measuresToAdd, styleHint }
    : { kind: 'continue', measuresToAdd };
}

function input(
  hideSource: string,
  task: HamoringSuggestTask,
  pieceContext?: HamoringSuggestInput['pieceContext'],
): HamoringSuggestInput {
  return pieceContext !== undefined
    ? { hideSource, task, pieceContext }
    : { hideSource, task };
}

// ============================================================
// 基本構造
// ============================================================

describe('buildHamoringSuggestPrompt — basic shape', () => {
  it('returns systemPrompt / userContent / textOnlyPrompt / summary', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, buildContinue(2)),
    );
    expect(typeof prompt.systemPrompt).toBe('string');
    expect(Array.isArray(prompt.userContent)).toBe(true);
    expect(typeof prompt.textOnlyPrompt).toBe('string');
    expect(prompt.summary).toBeDefined();
  });

  it('userContent is text-only (no image blocks)', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, buildContinue(2)),
    );
    expect(prompt.userContent.length).toBeGreaterThan(0);
    expect(prompt.userContent.every((b) => b.type === 'text')).toBe(true);
  });

  it('summary fields reflect input counts', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, buildContinue(4)),
    );
    expect(prompt.summary.measureCount).toBe(4);
    expect(prompt.summary.partCount).toBe(2);
    expect(prompt.summary.taskKind).toBe('continue');
    // CLEAN_TWO_PART は 2 行
    expect(prompt.summary.hideSourceLineCount).toBe(2);
    // chord 分類できた数 (2 パートのみだと dyad ばかりで null になる)
    expect(typeof prompt.summary.chordLabelCount).toBe('number');
    expect(prompt.summary.voiceLeadingObservationCount).toBeGreaterThanOrEqual(0);
  });

  it('hideSourceLineCount is 0 for empty source', () => {
    // 空 source は parser が default の [1] パートを 1 つ挿入するので
    // partCount は 1。ただし measure は 0 個 (barline がないため)
    const prompt = buildHamoringSuggestPrompt({
      hideSource: '',
      task: { kind: 'freeform', userQuery: '何か提案して' },
    });
    expect(prompt.summary.hideSourceLineCount).toBe(0);
    expect(prompt.summary.measureCount).toBe(0);
  });

  it('summary.voiceLeadingObservationCount picks up parallel fifths', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(PARALLEL_FIFTHS, buildContinue(1)),
    );
    expect(prompt.summary.voiceLeadingObservationCount).toBeGreaterThan(0);
  });
});

// ============================================================
// system prompt の必須内容 (ポップジャンル前提)
// ============================================================

describe('buildHamoringSuggestPrompt — system prompt content', () => {
  const { systemPrompt } = buildHamoringSuggestPrompt(
    input(CLEAN_TWO_PART, buildContinue(1)),
  );

  it('declares the target genre as pop / contemporary a-cappella, NOT classical', () => {
    expect(systemPrompt).toMatch(/ポップ\/現代アカペラ/);
  });

  it('explicitly waives classical 禁則 (parallel 5/8, voice crossing, large leap)', () => {
    expect(systemPrompt).toMatch(/古典和声の禁則/);
    expect(systemPrompt).toMatch(/適用しません/);
    expect(systemPrompt).toMatch(/平行 5 度/);
  });

  it('declares this is a generative task, NOT an OMR review (silent fill OK)', () => {
    expect(systemPrompt).toMatch(/生成タスク/);
    expect(systemPrompt).toMatch(/OMR レビューではありません/);
  });

  it('frames voice leading observations as caution, not 禁則', () => {
    expect(systemPrompt).toMatch(/voice leading observations/);
    expect(systemPrompt).toMatch(/禁則ではありません/);
  });

  it('contains a minimal .hide cheatsheet (header / pitch / length / chord / parts)', () => {
    expect(systemPrompt).toMatch(/CLEF:TREBLE TIME/);
    expect(systemPrompt).toMatch(/h=32分/);
    expect(systemPrompt).toMatch(/和音/);
    expect(systemPrompt).toMatch(/\[P\]/);
    // 連符記法の例
    expect(systemPrompt).toMatch(/8\(C4iD4iE4i\)/);
    // タイ
    expect(systemPrompt).toMatch(/C4l\+ C4l/);
  });

  it('specifies output format (proposal summary → ```hide``` block → optional alternates)', () => {
    expect(systemPrompt).toMatch(/提案サマリ/);
    expect(systemPrompt).toMatch(/```hide/);
    expect(systemPrompt).toMatch(/代替案/);
  });

  it('does NOT mention silent-fill prohibition (key contrast with hideLlmReview)', () => {
    // hideLlmReview とは逆向きのレイヤーなので「silent fill しない」は書いてないこと
    expect(systemPrompt).not.toMatch(/silent fill.*厳禁/);
    expect(systemPrompt).not.toMatch(/推測で埋めないこと/);
  });

  it('does NOT declare image as source-of-truth (key contrast with hideLlmReview)', () => {
    expect(systemPrompt).not.toMatch(/source-of-truth/);
    expect(systemPrompt).not.toMatch(/これが正解/);
  });
});

// ============================================================
// hideSource section (line numbering)
// ============================================================

describe('buildHamoringSuggestPrompt — hideSource line numbering', () => {
  it('emits the hideSource inside a fenced ```hide``` block', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, buildContinue(1)),
    );
    expect(prompt.textOnlyPrompt).toMatch(/```hide\n[\s\S]*?\n```/);
    expect(prompt.textOnlyPrompt).toMatch(/C5m/);
  });

  it('prefixes each line with a right-aligned line number', () => {
    const hideSource = 'header\nline2\nline3';
    const prompt = buildHamoringSuggestPrompt({
      hideSource,
      task: { kind: 'freeform', userQuery: 'x' },
    });
    expect(prompt.textOnlyPrompt).toMatch(/1 \| header/);
    expect(prompt.textOnlyPrompt).toMatch(/2 \| line2/);
    expect(prompt.textOnlyPrompt).toMatch(/3 \| line3/);
  });

  it('pads numbers when source has 10+ lines', () => {
    const hideSource = Array.from({ length: 12 }, (_, i) => `L${i + 1}`).join('\n');
    const prompt = buildHamoringSuggestPrompt({
      hideSource,
      task: { kind: 'freeform', userQuery: 'x' },
    });
    expect(prompt.textOnlyPrompt).toMatch(/ 1 \| L1\n/);
    expect(prompt.textOnlyPrompt).toMatch(/12 \| L12/);
  });

  it('section header is "現状の .hide ソース" (NOT "逆変換された .hide ソース")', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, buildContinue(1)),
    );
    expect(prompt.textOnlyPrompt).toMatch(/現状の \.hide ソース/);
    expect(prompt.textOnlyPrompt).not.toMatch(/逆変換された/);
  });
});

// ============================================================
// chord progression section
// ============================================================

describe('buildHamoringSuggestPrompt — chord progression section', () => {
  it('emits a markdown table with header row', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, buildContinue(1)),
    );
    expect(prompt.textOnlyPrompt).toMatch(/## コード進行/);
    expect(prompt.textOnlyPrompt).toMatch(/\| 小節 \| コード \| 補足 \|/);
    expect(prompt.textOnlyPrompt).toMatch(/\|------\|--------\|------\|/);
  });

  it('lists each measure with 1-based numbering', () => {
    // 3 パートで triad が組めるようにする (Cmaj triad → C/E/G の最低音はバスに)
    const triadSource =
      '[1]| G4m | A4m |\n[2]| E4m | F4m |\n[3]| C4m | D4m |';
    const prompt = buildHamoringSuggestPrompt(
      input(triadSource, buildContinue(1)),
    );
    // 1 行目と 2 行目の小節番号
    expect(prompt.textOnlyPrompt).toMatch(/\| 1 \|/);
    expect(prompt.textOnlyPrompt).toMatch(/\| 2 \|/);
  });

  it('classifies a recognizable triad and emits the symbol', () => {
    // C major triad (C/E/G) を 3 パートで宣言 → "Cmaj" として認識
    const triadSource = '[1]| G4m |\n[2]| E4m |\n[3]| C4m |';
    const prompt = buildHamoringSuggestPrompt(
      input(triadSource, { kind: 'freeform', userQuery: 'x' }),
    );
    expect(prompt.textOnlyPrompt).toMatch(/Cmaj/);
    expect(prompt.summary.chordLabelCount).toBe(1);
  });

  it('emits "(分類不能)" for measures that do not match a known chord template', () => {
    // 2 パート dyad (C5+G4) は分類不能 (= dyad → null)
    const prompt = buildHamoringSuggestPrompt(
      input('[1]| C5m |\n[2]| G4m |', buildContinue(1)),
    );
    expect(prompt.textOnlyPrompt).toMatch(/分類不能/);
    expect(prompt.summary.chordLabelCount).toBe(0);
  });

  it('emits the empty-matrix message when input has no measures', () => {
    const prompt = buildHamoringSuggestPrompt({
      hideSource: '',
      task: { kind: 'freeform', userQuery: 'x' },
    });
    expect(prompt.textOnlyPrompt).toMatch(/## コード進行/);
    expect(prompt.textOnlyPrompt).toMatch(/小節がありません/);
  });
});

// ============================================================
// voice leading observations section
// ============================================================

describe('buildHamoringSuggestPrompt — voice leading observations', () => {
  it('emits "no caution found" when there are no observations', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, buildContinue(1)),
    );
    expect(prompt.textOnlyPrompt).toMatch(/voice leading observations/);
    expect(prompt.textOnlyPrompt).toMatch(/検出されませんでした/);
  });

  it('lists parallel fifths with caution framing (NOT 禁則)', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(PARALLEL_FIFTHS, buildContinue(1)),
    );
    expect(prompt.textOnlyPrompt).toMatch(/parallelFifths/);
    // caution framing
    expect(prompt.textOnlyPrompt).toMatch(/古典和声でなら避けられる動き/);
    expect(prompt.textOnlyPrompt).toMatch(/ポップ\/現代アカペラでは禁則ではありません/);
  });

  it('numbers observations 1, 2, 3, ...', () => {
    // 平行 5 度 + 平行 8 度 を同時発生させる (3 パート構成)
    // [1] C5→D5 (+2), [2] F4→G4 (+2) (P5 並行), [3] C4→D4 (+2) (P8 with [1])
    // 期待: parallel5 (1-2) と parallel8 (1-3)、両方
    const source = '[1]| C5m | D5m |\n[2]| F4m | G4m |\n[3]| C4m | D4m |';
    const prompt = buildHamoringSuggestPrompt(
      input(source, buildContinue(1)),
    );
    expect(prompt.textOnlyPrompt).toMatch(/1\. \[/);
    expect(prompt.textOnlyPrompt).toMatch(/2\. \[/);
    expect(prompt.summary.voiceLeadingObservationCount).toBeGreaterThanOrEqual(2);
  });

  it('emits the pop-not-classical reminder even when there are no observations', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, buildContinue(1)),
    );
    // empty branch でも「ポップ的に何か追加してはいけないという意味ではない」と書いてある
    expect(prompt.textOnlyPrompt).toMatch(/ポップ的に何か追加してはいけないという意味ではありません/);
  });
});

// ============================================================
// task formatting (5 種別)
// ============================================================

describe('buildHamoringSuggestPrompt — task: continue', () => {
  it('formats with measuresToAdd', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, { kind: 'continue', measuresToAdd: 4 }),
    );
    expect(prompt.textOnlyPrompt).toMatch(/種別.*continue/);
    expect(prompt.textOnlyPrompt).toMatch(/4 小節/);
  });

  it('includes styleHint when supplied', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, {
        kind: 'continue',
        measuresToAdd: 2,
        styleHint: 'サビに向かって盛り上がる',
      }),
    );
    expect(prompt.textOnlyPrompt).toMatch(/サビに向かって盛り上がる/);
    expect(prompt.textOnlyPrompt).toMatch(/スタイル指示/);
  });

  it('omits styleHint subsection when blank', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, { kind: 'continue', measuresToAdd: 2, styleHint: '   ' }),
    );
    expect(prompt.textOnlyPrompt).not.toMatch(/スタイル指示/);
  });
});

describe('buildHamoringSuggestPrompt — task: addPart', () => {
  it('formats with partLabel', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, { kind: 'addPart', partLabel: '3' }),
    );
    expect(prompt.textOnlyPrompt).toMatch(/種別.*addPart/);
    expect(prompt.textOnlyPrompt).toMatch(/\[3\]/);
  });

  it('includes voiceDescription when supplied', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, {
        kind: 'addPart',
        partLabel: '3',
        voiceDescription: 'alto descant',
      }),
    );
    expect(prompt.textOnlyPrompt).toMatch(/alto descant/);
    expect(prompt.textOnlyPrompt).toMatch(/声部の希望/);
  });

  it('instructs to return entire arrangement (not just new part)', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, { kind: 'addPart', partLabel: 'P' }),
    );
    expect(prompt.textOnlyPrompt).toMatch(/編曲全体/);
  });
});

describe('buildHamoringSuggestPrompt — task: fixSection', () => {
  it('formats with from/to measure range', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, { kind: 'fixSection', fromMeasure: 2, toMeasure: 3 }),
    );
    expect(prompt.textOnlyPrompt).toMatch(/種別.*fixSection/);
    expect(prompt.textOnlyPrompt).toMatch(/小節 2.*3/);
  });

  it('includes goal when supplied', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, {
        kind: 'fixSection',
        fromMeasure: 1,
        toMeasure: 2,
        goal: '盛り上がり不足',
      }),
    );
    expect(prompt.textOnlyPrompt).toMatch(/盛り上がり不足/);
    expect(prompt.textOnlyPrompt).toMatch(/修正の目的/);
  });

  it('allows fromMeasure === toMeasure (single-measure fix)', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, { kind: 'fixSection', fromMeasure: 2, toMeasure: 2 }),
    );
    expect(prompt.textOnlyPrompt).toMatch(/小節 2.*2/);
  });
});

describe('buildHamoringSuggestPrompt — task: reharmonize', () => {
  it('formats with from/to measure range', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, { kind: 'reharmonize', fromMeasure: 1, toMeasure: 4 }),
    );
    expect(prompt.textOnlyPrompt).toMatch(/種別.*reharmonize/);
    expect(prompt.textOnlyPrompt).toMatch(/小節 1.*4/);
  });

  it('includes constraints when supplied', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, {
        kind: 'reharmonize',
        fromMeasure: 1,
        toMeasure: 4,
        constraints: 'II-V-I を含める',
      }),
    );
    expect(prompt.textOnlyPrompt).toMatch(/II-V-I を含める/);
    expect(prompt.textOnlyPrompt).toMatch(/制約/);
  });

  it('mentions melody preservation in instructions', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, { kind: 'reharmonize', fromMeasure: 1, toMeasure: 2 }),
    );
    expect(prompt.textOnlyPrompt).toMatch(/メロディ.*保ち/);
  });
});

describe('buildHamoringSuggestPrompt — task: freeform', () => {
  it('formats with the user query as a blockquote', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, { kind: 'freeform', userQuery: 'もっとジャジーに' }),
    );
    expect(prompt.textOnlyPrompt).toMatch(/種別.*freeform/);
    expect(prompt.textOnlyPrompt).toMatch(/> もっとジャジーに/);
  });

  it('quotes a multi-line query line by line', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, {
        kind: 'freeform',
        userQuery: '1 行目\n2 行目\n3 行目',
      }),
    );
    expect(prompt.textOnlyPrompt).toMatch(/> 1 行目/);
    expect(prompt.textOnlyPrompt).toMatch(/> 2 行目/);
    expect(prompt.textOnlyPrompt).toMatch(/> 3 行目/);
  });
});

// ============================================================
// piece context
// ============================================================

describe('buildHamoringSuggestPrompt — piece context', () => {
  it('omits the section when no pieceContext is given', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, buildContinue(1)),
    );
    expect(prompt.textOnlyPrompt).not.toMatch(/楽曲情報/);
  });

  it('omits the section when pieceContext is given but all fields empty', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, buildContinue(1), {}),
    );
    expect(prompt.textOnlyPrompt).not.toMatch(/楽曲情報/);
  });

  it('includes title / composer / notes when supplied', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, buildContinue(1), {
        title: '紅蓮華',
        composer: 'LiSA',
        notes: 'Aメロ',
      }),
    );
    expect(prompt.textOnlyPrompt).toMatch(/楽曲情報/);
    expect(prompt.textOnlyPrompt).toMatch(/紅蓮華/);
    expect(prompt.textOnlyPrompt).toMatch(/LiSA/);
    expect(prompt.textOnlyPrompt).toMatch(/Aメロ/);
  });
});

// ============================================================
// instruction footer
// ============================================================

describe('buildHamoringSuggestPrompt — instruction footer', () => {
  it('reminds the LLM that classical 禁則 is not applied', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, buildContinue(1)),
    );
    expect(prompt.textOnlyPrompt).toMatch(/## 指示/);
    expect(prompt.textOnlyPrompt).toMatch(/古典和声の禁則は適用せず/);
  });

  it('references the system-prompt output format', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, buildContinue(1)),
    );
    expect(prompt.textOnlyPrompt).toMatch(/出力フォーマット/);
  });
});

// ============================================================
// section ordering
// ============================================================

describe('buildHamoringSuggestPrompt — section ordering', () => {
  it('orders pieceContext → hideSource → chord → voice leading → task → instruction', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(CLEAN_TWO_PART, buildContinue(1), { title: '曲名' }),
    );
    const text = prompt.textOnlyPrompt;
    const idxPiece = text.indexOf('## 楽曲情報');
    const idxHide = text.indexOf('## 現状の .hide ソース');
    const idxChord = text.indexOf('## コード進行');
    const idxVl = text.indexOf('## voice leading observations');
    const idxTask = text.indexOf('## タスク');
    const idxInstr = text.indexOf('## 指示');
    expect(idxPiece).toBeGreaterThanOrEqual(0);
    expect(idxHide).toBeGreaterThan(idxPiece);
    expect(idxChord).toBeGreaterThan(idxHide);
    expect(idxVl).toBeGreaterThan(idxChord);
    expect(idxTask).toBeGreaterThan(idxVl);
    expect(idxInstr).toBeGreaterThan(idxTask);
  });
});

// ============================================================
// textOnlyPrompt vs userContent consistency
// ============================================================

describe('buildHamoringSuggestPrompt — textOnlyPrompt mirrors userContent', () => {
  it('textOnlyPrompt is the join of all userContent text blocks', () => {
    const prompt = buildHamoringSuggestPrompt(
      input(PARALLEL_FIFTHS, { kind: 'addPart', partLabel: '3' }),
    );
    const joined = prompt.userContent
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n\n');
    expect(prompt.textOnlyPrompt).toBe(joined);
  });
});

// ============================================================
// validation errors
// ============================================================

describe('buildHamoringSuggestPrompt — task validation', () => {
  it('throws when continue.measuresToAdd is 0', () => {
    expect(() =>
      buildHamoringSuggestPrompt(
        input(CLEAN_TWO_PART, { kind: 'continue', measuresToAdd: 0 }),
      ),
    ).toThrow(/measuresToAdd/);
  });

  it('throws when continue.measuresToAdd is negative', () => {
    expect(() =>
      buildHamoringSuggestPrompt(
        input(CLEAN_TWO_PART, { kind: 'continue', measuresToAdd: -3 }),
      ),
    ).toThrow(/measuresToAdd/);
  });

  it('throws when continue.measuresToAdd is non-integer', () => {
    expect(() =>
      buildHamoringSuggestPrompt(
        input(CLEAN_TWO_PART, { kind: 'continue', measuresToAdd: 1.5 }),
      ),
    ).toThrow(/measuresToAdd/);
  });

  it('throws when addPart.partLabel is empty string', () => {
    expect(() =>
      buildHamoringSuggestPrompt(
        input(CLEAN_TWO_PART, { kind: 'addPart', partLabel: '' }),
      ),
    ).toThrow(/partLabel/);
  });

  it('throws when addPart.partLabel is whitespace-only', () => {
    expect(() =>
      buildHamoringSuggestPrompt(
        input(CLEAN_TWO_PART, { kind: 'addPart', partLabel: '   ' }),
      ),
    ).toThrow(/partLabel/);
  });

  it('throws when fixSection.fromMeasure is 0 (must be 1-based)', () => {
    expect(() =>
      buildHamoringSuggestPrompt(
        input(CLEAN_TWO_PART, { kind: 'fixSection', fromMeasure: 0, toMeasure: 2 }),
      ),
    ).toThrow(/fromMeasure/);
  });

  it('throws when fixSection.fromMeasure > toMeasure', () => {
    expect(() =>
      buildHamoringSuggestPrompt(
        input(CLEAN_TWO_PART, { kind: 'fixSection', fromMeasure: 4, toMeasure: 2 }),
      ),
    ).toThrow(/fromMeasure.*toMeasure/);
  });

  it('throws when reharmonize.toMeasure is negative', () => {
    expect(() =>
      buildHamoringSuggestPrompt(
        input(CLEAN_TWO_PART, { kind: 'reharmonize', fromMeasure: 1, toMeasure: -1 }),
      ),
    ).toThrow(/toMeasure/);
  });

  it('throws when reharmonize.fromMeasure is non-integer', () => {
    expect(() =>
      buildHamoringSuggestPrompt(
        input(CLEAN_TWO_PART, { kind: 'reharmonize', fromMeasure: 1.5, toMeasure: 2 }),
      ),
    ).toThrow(/fromMeasure/);
  });

  it('throws when freeform.userQuery is empty', () => {
    expect(() =>
      buildHamoringSuggestPrompt(
        input(CLEAN_TWO_PART, { kind: 'freeform', userQuery: '' }),
      ),
    ).toThrow(/userQuery/);
  });

  it('throws when freeform.userQuery is whitespace-only', () => {
    expect(() =>
      buildHamoringSuggestPrompt(
        input(CLEAN_TWO_PART, { kind: 'freeform', userQuery: '\n\t  ' }),
      ),
    ).toThrow(/userQuery/);
  });

  it('does NOT throw for fromMeasure === toMeasure', () => {
    expect(() =>
      buildHamoringSuggestPrompt(
        input(CLEAN_TWO_PART, { kind: 'fixSection', fromMeasure: 2, toMeasure: 2 }),
      ),
    ).not.toThrow();
  });
});

// ============================================================
// regression: 5 種別すべてが summary.taskKind を正しくセット
// ============================================================

describe('buildHamoringSuggestPrompt — taskKind in summary', () => {
  it.each<HamoringSuggestTask>([
    { kind: 'continue', measuresToAdd: 1 },
    { kind: 'addPart', partLabel: '3' },
    { kind: 'fixSection', fromMeasure: 1, toMeasure: 1 },
    { kind: 'reharmonize', fromMeasure: 1, toMeasure: 1 },
    { kind: 'freeform', userQuery: 'x' },
  ])('threads $kind into summary.taskKind', (task) => {
    const prompt = buildHamoringSuggestPrompt(input(CLEAN_TWO_PART, task));
    expect(prompt.summary.taskKind).toBe(task.kind);
  });
});
