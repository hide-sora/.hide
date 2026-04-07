/**
 * hideLlmReview.test.ts — LLM レビュー pipeline の prompt builder 単体テスト
 *
 * テスト戦略:
 *   - prompt builder は LLM 呼び出しを行わない pure function なので、
 *     入力 → 出力の構造的な性質をひたすら確認する
 *   - 「diagnostic kind ごとに人間可読な sentence が出る」「画像が
 *     content block の先頭に配置される」「textOnlyPrompt が userContent と
 *     一致する」など contractual properties を中心に検証
 *   - silent fill 禁止という設計を system prompt に書いている確認も含む
 */

import { describe, it, expect } from 'vitest';
import { compileHide } from './hideLoader';
import { musicXmlToHide } from './musicXmlToHide';
import { analyzeMatrix } from './hideMatrix';
import {
  buildLlmReviewPrompt,
  buildLlmReviewPromptFromResult,
} from './hideLlmReview';
import type { LlmReviewImage } from './hideLlmReview';
import type { MusicXmlToHideDiagnostic } from './musicXmlToHide';

// ============================================================
// テストヘルパー
// ============================================================

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';

function makeImage(overrides: Partial<LlmReviewImage> = {}): LlmReviewImage {
  return {
    base64: TINY_PNG_BASE64,
    mediaType: 'image/png',
    ...overrides,
  };
}

// ============================================================
// 基本構造
// ============================================================

describe('buildLlmReviewPrompt — basic shape', () => {
  it('returns systemPrompt / userContent / textOnlyPrompt / summary', () => {
    const prompt = buildLlmReviewPrompt({
      hideSource: '[1]| C5m |',
      diagnostics: [],
    });
    expect(typeof prompt.systemPrompt).toBe('string');
    expect(Array.isArray(prompt.userContent)).toBe(true);
    expect(typeof prompt.textOnlyPrompt).toBe('string');
    expect(prompt.summary).toBeDefined();
  });

  it('summary fields reflect input counts', () => {
    const diagnostics: MusicXmlToHideDiagnostic[] = [
      { kind: 'tupletDetected', partIndex: 0, measureIndex: 0 },
      { kind: 'multipleAttributes', partIndex: 0 },
    ];
    const prompt = buildLlmReviewPrompt({
      hideSource: 'L1\nL2\nL3',
      diagnostics,
      pageImages: [makeImage(), makeImage()],
    });
    expect(prompt.summary.diagnosticCount).toBe(2);
    expect(prompt.summary.matrixIssueCount).toBe(0);
    expect(prompt.summary.imageCount).toBe(2);
    expect(prompt.summary.hideSourceLineCount).toBe(3);
    expect(prompt.summary.diagnosticKinds).toEqual(['multipleAttributes', 'tupletDetected']);
    expect(prompt.summary.matrixIssueKinds).toEqual([]);
  });

  it('hideSourceLineCount is 0 for empty source', () => {
    const prompt = buildLlmReviewPrompt({ hideSource: '', diagnostics: [] });
    expect(prompt.summary.hideSourceLineCount).toBe(0);
  });
});

// ============================================================
// system prompt の必須内容
// ============================================================

describe('buildLlmReviewPrompt — system prompt content', () => {
  it('mentions silent-fill prohibition (核となる設計思想)', () => {
    const { systemPrompt } = buildLlmReviewPrompt({ hideSource: '', diagnostics: [] });
    // "silent fill" の禁止が明示されているか
    expect(systemPrompt).toMatch(/silent fill/);
    // "推測で埋めない" 系の言い回しがあるか
    expect(systemPrompt).toMatch(/推測で埋めない/);
  });

  it('declares the image as source-of-truth', () => {
    const { systemPrompt } = buildLlmReviewPrompt({ hideSource: '', diagnostics: [] });
    expect(systemPrompt).toMatch(/source-of-truth/);
    expect(systemPrompt).toMatch(/これが正解/);
  });

  it('contains a minimal .hide cheatsheet (header / pitch / length / chord / parts)', () => {
    const { systemPrompt } = buildLlmReviewPrompt({ hideSource: '', diagnostics: [] });
    expect(systemPrompt).toMatch(/CLEF:TREBLE TIME/);
    expect(systemPrompt).toMatch(/h=32分/);
    expect(systemPrompt).toMatch(/和音/);
    expect(systemPrompt).toMatch(/\[P\]/);
    // 連符記法の例
    expect(systemPrompt).toMatch(/8\(C4iD4iE4i\)/);
  });

  it('specifies output format (summary → ```hide``` block → UNRESOLVED)', () => {
    const { systemPrompt } = buildLlmReviewPrompt({ hideSource: '', diagnostics: [] });
    expect(systemPrompt).toMatch(/修正サマリ/);
    expect(systemPrompt).toMatch(/```hide/);
    expect(systemPrompt).toMatch(/UNRESOLVED/);
  });
});

// ============================================================
// hideSource section (line numbers)
// ============================================================

describe('buildLlmReviewPrompt — hideSource line numbering', () => {
  it('emits the hideSource inside a fenced ```hide``` block', () => {
    const prompt = buildLlmReviewPrompt({
      hideSource: '[1]| C5m |',
      diagnostics: [],
    });
    expect(prompt.textOnlyPrompt).toMatch(/```hide\n[\s\S]*?\n```/);
    expect(prompt.textOnlyPrompt).toMatch(/C5m/);
  });

  it('prefixes each line with a right-aligned line number', () => {
    const hideSource = 'header\nline2\nline3';
    const prompt = buildLlmReviewPrompt({ hideSource, diagnostics: [] });
    expect(prompt.textOnlyPrompt).toMatch(/1 \| header/);
    expect(prompt.textOnlyPrompt).toMatch(/2 \| line2/);
    expect(prompt.textOnlyPrompt).toMatch(/3 \| line3/);
  });

  it('pads numbers when source has 10+ lines', () => {
    const hideSource = Array.from({ length: 12 }, (_, i) => `L${i + 1}`).join('\n');
    const prompt = buildLlmReviewPrompt({ hideSource, diagnostics: [] });
    // 行 1 は ' 1 | L1' (前置スペース 1 個)、行 12 は '12 | L12'
    expect(prompt.textOnlyPrompt).toMatch(/ 1 \| L1\n/);
    expect(prompt.textOnlyPrompt).toMatch(/12 \| L12/);
  });
});

// ============================================================
// diagnostic formatting (各 kind)
// ============================================================

describe('buildLlmReviewPrompt — diagnostic formatting (each kind)', () => {
  it('emits "no issues" message when diagnostics is empty', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '[1]| C5m |',
      diagnostics: [],
    });
    expect(textOnlyPrompt).toMatch(/逆変換 diagnostics/);
    expect(textOnlyPrompt).toMatch(/構造的な不整合は検出されませんでした/);
  });

  it('formats partMeasureCountMismatch with location and remediation hint', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '',
      diagnostics: [
        { kind: 'partMeasureCountMismatch', partIndex: 1, partLabel: '2', got: 2, expected: 3 },
      ],
    });
    expect(textOnlyPrompt).toMatch(/partMeasureCountMismatch/);
    expect(textOnlyPrompt).toMatch(/\[2\]/);
    expect(textOnlyPrompt).toMatch(/2\/3/);
    expect(textOnlyPrompt).toMatch(/silent fill はせず/);
  });

  it('formats multipleAttributes with [M] / [K] hint', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '',
      diagnostics: [{ kind: 'multipleAttributes', partIndex: 0 }],
    });
    expect(textOnlyPrompt).toMatch(/multipleAttributes/);
    expect(textOnlyPrompt).toMatch(/\[M3\/4\]/);
    expect(textOnlyPrompt).toMatch(/\[K\+2\]/);
  });

  it('formats multipleVoices with voice list', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '',
      diagnostics: [{ kind: 'multipleVoices', partIndex: 0, measureIndex: 2, voices: [1, 2] }],
    });
    expect(textOnlyPrompt).toMatch(/multipleVoices/);
    expect(textOnlyPrompt).toMatch(/小節 3/); // 0-based → 1-based
    expect(textOnlyPrompt).toMatch(/1,2/);
  });

  it('formats tupletDetected with tuplet syntax hint', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '',
      diagnostics: [{ kind: 'tupletDetected', partIndex: 0, measureIndex: 0 }],
    });
    expect(textOnlyPrompt).toMatch(/tupletDetected/);
    expect(textOnlyPrompt).toMatch(/8\(C4iD4iE4i\)/);
  });

  it('formats nonStandardDuration with the actual unit count', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '',
      diagnostics: [{ kind: 'nonStandardDuration', partIndex: 0, measureIndex: 0, durationUnits: 7 }],
    });
    expect(textOnlyPrompt).toMatch(/nonStandardDuration/);
    expect(textOnlyPrompt).toMatch(/7u/);
    expect(textOnlyPrompt).toMatch(/付点/);
  });

  it('numbers diagnostics 1, 2, 3, ...', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '',
      diagnostics: [
        { kind: 'tupletDetected', partIndex: 0, measureIndex: 0 },
        { kind: 'tupletDetected', partIndex: 0, measureIndex: 1 },
        { kind: 'multipleAttributes', partIndex: 0 },
      ],
    });
    expect(textOnlyPrompt).toMatch(/1\. \[tupletDetected\]/);
    expect(textOnlyPrompt).toMatch(/2\. \[tupletDetected\]/);
    expect(textOnlyPrompt).toMatch(/3\. \[multipleAttributes\]/);
  });
});

// ============================================================
// matrix issues (optional input)
// ============================================================

describe('buildLlmReviewPrompt — matrix issues', () => {
  it('omits the matrix issues section when matrixIssues is undefined', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '[1]| C5m |',
      diagnostics: [],
    });
    expect(textOnlyPrompt).not.toMatch(/strict 検証層/);
  });

  it('omits the matrix issues section when matrixIssues is empty array', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '[1]| C5m |',
      diagnostics: [],
      matrixIssues: [],
    });
    expect(textOnlyPrompt).not.toMatch(/strict 検証層/);
  });

  it('includes the matrix issues section with kind, location, message', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '',
      diagnostics: [],
      matrixIssues: [
        {
          kind: 'measureCountMismatch',
          message: 'パート [2] の小節数は 2、最大は 3',
          partLabel: '2',
        },
        {
          kind: 'measureDurationMismatch',
          message: '小節 1: パート [1] の duration は 16u',
          measureIndex: 0,
          partLabel: '1',
        },
      ],
    });
    expect(textOnlyPrompt).toMatch(/strict 検証層/);
    expect(textOnlyPrompt).toMatch(/measureCountMismatch/);
    expect(textOnlyPrompt).toMatch(/measureDurationMismatch/);
    expect(textOnlyPrompt).toMatch(/小節 1/);
    expect(textOnlyPrompt).toMatch(/パート \[2\]/);
  });
});

// ============================================================
// 画像 (multimodal content blocks)
// ============================================================

describe('buildLlmReviewPrompt — image content blocks', () => {
  it('omits image blocks when no images are supplied', () => {
    const { userContent, summary } = buildLlmReviewPrompt({
      hideSource: '[1]| C5m |',
      diagnostics: [],
    });
    expect(summary.imageCount).toBe(0);
    expect(userContent.every(b => b.type === 'text')).toBe(true);
  });

  it('places images before all text sections', () => {
    const { userContent } = buildLlmReviewPrompt({
      hideSource: '[1]| C5m |',
      diagnostics: [],
      pageImages: [makeImage({ pageNumber: 1 })],
    });
    // userContent[0]: caption "(page 1)"
    // userContent[1]: image
    // userContent[2..]: text sections
    const firstImageIdx = userContent.findIndex(b => b.type === 'image');
    const firstHideSourceTextIdx = userContent.findIndex(
      b => b.type === 'text' && /逆変換された \.hide ソース/.test(b.text),
    );
    expect(firstImageIdx).toBeGreaterThanOrEqual(0);
    expect(firstHideSourceTextIdx).toBeGreaterThan(firstImageIdx);
  });

  it('emits image blocks in Anthropic wire format (source.media_type / base64)', () => {
    const { userContent } = buildLlmReviewPrompt({
      hideSource: '',
      diagnostics: [],
      pageImages: [makeImage({ mediaType: 'image/jpeg', base64: 'AAAA' })],
    });
    const imgBlock = userContent.find(b => b.type === 'image');
    expect(imgBlock).toBeDefined();
    if (imgBlock && imgBlock.type === 'image') {
      expect(imgBlock.source.type).toBe('base64');
      expect(imgBlock.source.media_type).toBe('image/jpeg');
      expect(imgBlock.source.data).toBe('AAAA');
    }
  });

  it('emits a caption text block before each image when pageNumber/label is set', () => {
    const { userContent } = buildLlmReviewPrompt({
      hideSource: '',
      diagnostics: [],
      pageImages: [
        makeImage({ pageNumber: 1, label: 'system 1' }),
        makeImage({ pageNumber: 2 }),
      ],
    });
    const captionTexts = userContent
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text);
    expect(captionTexts.some(t => t.includes('page 1') && t.includes('system 1'))).toBe(true);
    expect(captionTexts.some(t => t === '(page 2)')).toBe(true);
  });

  it('emits no caption when image has no pageNumber/label', () => {
    const { userContent } = buildLlmReviewPrompt({
      hideSource: '',
      diagnostics: [],
      pageImages: [makeImage()],
    });
    // 最初の block は text caption ではなく直接 image
    expect(userContent[0].type).toBe('image');
  });

  it('preserves multi-page ordering', () => {
    const images: LlmReviewImage[] = [
      makeImage({ pageNumber: 1, base64: 'AAA' }),
      makeImage({ pageNumber: 2, base64: 'BBB' }),
      makeImage({ pageNumber: 3, base64: 'CCC' }),
    ];
    const { userContent } = buildLlmReviewPrompt({
      hideSource: '',
      diagnostics: [],
      pageImages: images,
    });
    const imageBlocks = userContent.filter(b => b.type === 'image');
    expect(imageBlocks).toHaveLength(3);
    if (
      imageBlocks[0].type === 'image' &&
      imageBlocks[1].type === 'image' &&
      imageBlocks[2].type === 'image'
    ) {
      expect(imageBlocks[0].source.data).toBe('AAA');
      expect(imageBlocks[1].source.data).toBe('BBB');
      expect(imageBlocks[2].source.data).toBe('CCC');
    }
  });
});

// ============================================================
// follow-up context (round 2+)
// ============================================================

describe('buildLlmReviewPrompt — followup context (round 2+)', () => {
  it('omits the followup section when input.followup is undefined', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '[1]| C5m |',
      diagnostics: [],
    });
    expect(textOnlyPrompt).not.toMatch(/レビューラウンド/);
  });

  it('renders round X / Y header when followup is supplied', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '[1]| C5m |',
      diagnostics: [],
      followup: {
        round: 2,
        maxRounds: 3,
        previousUnresolved: ['小節 5 が画像で欠けている'],
      },
    });
    expect(textOnlyPrompt).toMatch(/レビューラウンド 2 \/ 3/);
    expect(textOnlyPrompt).toMatch(/round 1/);
  });

  it('lists previous UNRESOLVED items as a numbered list', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '[1]| C5m |',
      diagnostics: [],
      followup: {
        round: 2,
        maxRounds: 3,
        previousUnresolved: ['item A', 'item B', 'item C'],
      },
    });
    expect(textOnlyPrompt).toMatch(/1\. item A/);
    expect(textOnlyPrompt).toMatch(/2\. item B/);
    expect(textOnlyPrompt).toMatch(/3\. item C/);
  });

  it('shows "(前回 UNRESOLVED 項目はありませんでした)" when previousUnresolved is empty', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '[1]| C5m |',
      diagnostics: [],
      followup: {
        round: 2,
        maxRounds: 3,
        previousUnresolved: [],
      },
    });
    expect(textOnlyPrompt).toMatch(/前回 UNRESOLVED 項目はありませんでした/);
  });

  it('quotes previousSummary as markdown blockquote', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '[1]| C5m |',
      diagnostics: [],
      followup: {
        round: 2,
        maxRounds: 3,
        previousUnresolved: [],
        previousSummary: '小節 2 を修正\n根拠: 画像と照合',
      },
    });
    expect(textOnlyPrompt).toMatch(/> 小節 2 を修正/);
    expect(textOnlyPrompt).toMatch(/> 根拠: 画像と照合/);
  });

  it('omits the previousSummary subsection when not provided', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '[1]| C5m |',
      diagnostics: [],
      followup: {
        round: 2,
        maxRounds: 3,
        previousUnresolved: ['x'],
      },
    });
    expect(textOnlyPrompt).not.toMatch(/前回の修正サマリ/);
  });

  it('marks the final round explicitly when round === maxRounds', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '[1]| C5m |',
      diagnostics: [],
      followup: {
        round: 3,
        maxRounds: 3,
        previousUnresolved: [],
      },
    });
    expect(textOnlyPrompt).toMatch(/最終ラウンド/);
  });

  it('does NOT mark final round when round < maxRounds', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '[1]| C5m |',
      diagnostics: [],
      followup: {
        round: 2,
        maxRounds: 3,
        previousUnresolved: [],
      },
    });
    expect(textOnlyPrompt).not.toMatch(/最終ラウンド/);
  });

  it('places followup section AFTER pieceContext but BEFORE hideSource', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '[1]| C5m |',
      diagnostics: [],
      pieceContext: { title: 'BWV X' },
      followup: {
        round: 2,
        maxRounds: 3,
        previousUnresolved: ['x'],
      },
    });
    const idxPiece = textOnlyPrompt.indexOf('## 楽曲情報');
    const idxFollowup = textOnlyPrompt.indexOf('## レビューラウンド');
    const idxHide = textOnlyPrompt.indexOf('## 逆変換された .hide ソース');
    expect(idxPiece).toBeGreaterThanOrEqual(0);
    expect(idxFollowup).toBeGreaterThan(idxPiece);
    expect(idxHide).toBeGreaterThan(idxFollowup);
  });
});

// ============================================================
// piece context
// ============================================================

describe('buildLlmReviewPrompt — piece context', () => {
  it('omits the section when no pieceContext is given', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '',
      diagnostics: [],
    });
    expect(textOnlyPrompt).not.toMatch(/楽曲情報/);
  });

  it('includes title / composer / notes when supplied', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '',
      diagnostics: [],
      pieceContext: {
        title: 'BWV 269',
        composer: 'J.S. Bach',
        notes: 'ピックアップ小節あり',
      },
    });
    expect(textOnlyPrompt).toMatch(/楽曲情報/);
    expect(textOnlyPrompt).toMatch(/BWV 269/);
    expect(textOnlyPrompt).toMatch(/J\.S\. Bach/);
    expect(textOnlyPrompt).toMatch(/ピックアップ小節あり/);
  });

  it('omits the section when pieceContext is given but all fields are empty', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '',
      diagnostics: [],
      pieceContext: {},
    });
    expect(textOnlyPrompt).not.toMatch(/楽曲情報/);
  });
});

// ============================================================
// instruction footer
// ============================================================

describe('buildLlmReviewPrompt — instruction footer', () => {
  it('mentions image count when images are attached', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '',
      diagnostics: [],
      pageImages: [makeImage(), makeImage()],
    });
    expect(textOnlyPrompt).toMatch(/2 枚の楽譜画像/);
  });

  it('says "no images attached" when no images', () => {
    const { textOnlyPrompt } = buildLlmReviewPrompt({
      hideSource: '',
      diagnostics: [],
    });
    expect(textOnlyPrompt).toMatch(/楽譜画像は添付されていません/);
  });
});

// ============================================================
// textOnlyPrompt vs userContent consistency
// ============================================================

describe('buildLlmReviewPrompt — textOnlyPrompt mirrors userContent text', () => {
  it('textOnlyPrompt is the concatenation of all text sections (excluding image captions)', () => {
    const prompt = buildLlmReviewPrompt({
      hideSource: '[1]| C5m |',
      diagnostics: [{ kind: 'tupletDetected', partIndex: 0, measureIndex: 0 }],
      pageImages: [makeImage({ pageNumber: 1 })],
    });
    // すべてのセクションが textOnlyPrompt に含まれる
    expect(prompt.textOnlyPrompt).toMatch(/逆変換された \.hide ソース/);
    expect(prompt.textOnlyPrompt).toMatch(/逆変換 diagnostics/);
    expect(prompt.textOnlyPrompt).toMatch(/指示/);
    // image caption は textOnlyPrompt には入らない (画像非対応 LLM 向けに
    // 純テキストでも意味が通るため)
    expect(prompt.textOnlyPrompt).not.toMatch(/\(page 1\)/);
  });
});

// ============================================================
// buildLlmReviewPromptFromResult convenience helper
// ============================================================

describe('buildLlmReviewPromptFromResult — convenience integration', () => {
  it('round-trips a clean piece and surfaces zero diagnostics + zero matrix issues', () => {
    const original = '[1]| C5m | D5m |\n[2]| G4m | A4m |';
    const { musicXml } = compileHide(original);
    const result = musicXmlToHide(musicXml);
    const prompt = buildLlmReviewPromptFromResult(result);
    expect(prompt.summary.diagnosticCount).toBe(0);
    expect(prompt.summary.matrixIssueCount).toBe(0);
    expect(prompt.textOnlyPrompt).toMatch(/構造的な不整合は検出されませんでした/);
  });

  it('surfaces both reverse-converter diagnostics AND matrix issues for a short part', () => {
    // パート 1 = 3 小節 / パート 2 = 2 小節 (silent padding 廃止後)
    const xml = `<?xml version="1.0"?>
<score-partwise>
  <part-list>
    <score-part id="P1"/><score-part id="P2"/>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>8</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>32</duration><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>32</duration><type>whole</type></note>
    </measure>
    <measure number="3">
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>32</duration><type>whole</type></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>8</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>32</duration><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>32</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;
    const result = musicXmlToHide(xml);
    const prompt = buildLlmReviewPromptFromResult(result, [
      makeImage({ pageNumber: 1 }),
    ]);
    // reverse converter 由来の diagnostic
    expect(prompt.summary.diagnosticKinds).toContain('partMeasureCountMismatch');
    // matrix mode 由来の issue (両者とも同じ事象を検出)
    expect(prompt.summary.matrixIssueKinds).toContain('measureCountMismatch');
    // 1 枚画像
    expect(prompt.summary.imageCount).toBe(1);
    // 両セクションがプロンプトに入っている
    expect(prompt.textOnlyPrompt).toMatch(/partMeasureCountMismatch/);
    expect(prompt.textOnlyPrompt).toMatch(/measureCountMismatch/);
  });

  it('threads pieceContext through to the prompt', () => {
    const original = '[1]| C5m |';
    const { musicXml } = compileHide(original);
    const result = musicXmlToHide(musicXml);
    const prompt = buildLlmReviewPromptFromResult(result, undefined, {
      title: 'Test Piece',
      composer: 'Anon',
    });
    expect(prompt.textOnlyPrompt).toMatch(/Test Piece/);
    expect(prompt.textOnlyPrompt).toMatch(/Anon/);
  });
});

// ============================================================
// regression: 全 diagnostic kind を 1 つの prompt に詰め込んでも壊れない
// ============================================================

describe('buildLlmReviewPrompt — exhaustive diagnostic coverage', () => {
  it('handles all five diagnostic kinds in a single prompt without throwing', () => {
    const all: MusicXmlToHideDiagnostic[] = [
      { kind: 'partMeasureCountMismatch', partIndex: 0, partLabel: '1', got: 1, expected: 2 },
      { kind: 'multipleAttributes', partIndex: 0 },
      { kind: 'multipleVoices', partIndex: 0, measureIndex: 0, voices: [1, 2] },
      { kind: 'tupletDetected', partIndex: 0, measureIndex: 1 },
      { kind: 'nonStandardDuration', partIndex: 0, measureIndex: 2, durationUnits: 5 },
    ];
    const prompt = buildLlmReviewPrompt({
      hideSource: '[1]| C5m |',
      diagnostics: all,
    });
    expect(prompt.summary.diagnosticCount).toBe(5);
    expect(prompt.summary.diagnosticKinds).toHaveLength(5);
    // 各 kind sentence が含まれる
    for (const d of all) {
      expect(prompt.textOnlyPrompt).toMatch(new RegExp(d.kind));
    }
  });
});

// ============================================================
// 結果が clean な round-trip でも prompt は組める
// ============================================================

describe('buildLlmReviewPrompt — empty inputs are valid', () => {
  it('handles a hideSource with no diagnostics, no images, no context', () => {
    const prompt = buildLlmReviewPrompt({ hideSource: '[1]| C5m |', diagnostics: [] });
    expect(prompt.userContent.length).toBeGreaterThan(0);
    expect(prompt.summary.diagnosticCount).toBe(0);
    expect(prompt.summary.imageCount).toBe(0);
  });

  it('round-trip integration: clean source produces a usable prompt', () => {
    const original = '[1]| C5m | B4m | C5m |\n[2]| G4m | G4m | G4m |';
    const { musicXml } = compileHide(original);
    const { hideSource, diagnostics } = musicXmlToHide(musicXml);
    const prompt = buildLlmReviewPrompt({
      hideSource,
      diagnostics,
      matrixIssues: analyzeMatrix(hideSource).issues,
    });
    expect(prompt.summary.diagnosticCount).toBe(0);
    expect(prompt.textOnlyPrompt).toMatch(/逆変換された \.hide ソース/);
    expect(prompt.textOnlyPrompt).toMatch(/C5m/);
  });
});
