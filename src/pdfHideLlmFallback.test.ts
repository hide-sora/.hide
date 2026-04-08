/**
 * pdfHideLlmFallback.test.ts — Phase 4 LLM 補完レイヤーのユニットテスト
 *
 * カバー範囲:
 *  A. `buildPdfHideLlmFallbackPrompt`
 *     - 基本 shape (systemPrompt / userContent / textOnlyPrompt / summary)
 *     - 画像 first レイアウト (imageIntro text → image block → context → draft → cells → instructions)
 *     - image block の media_type が snake_case
 *     - lowConfidenceCells 0 件のとき「修正対象なし」が出る
 *     - context / additionalInstructions の有無
 *     - draft section が ```hide``` でラップされる
 *
 *  B. `applyPdfHideLlmFallbackResponse`
 *     - フェンスブロック抽出 (0/1/複数)
 *     - line-by-line の cell override 抽出 (`| <tokens> ;<word>:<cellId>`)
 *     - cellId 無しの行 (header / part switch / 高信頼セル) はスキップ
 *     - still-uncertain 系キーワードの検出
 *     - expectedCellIds フィルタ (未知 ID → warning、欠落 ID → warning)
 *     - 重複 cellId → warning + first-wins
 *     - UNRESOLVED section の抽出
 *     - tokens 部の前後 whitespace は trim される
 */

import { describe, it, expect } from 'vitest';
import {
  buildPdfHideLlmFallbackPrompt,
  applyPdfHideLlmFallbackResponse,
} from './pdfHideLlmFallback';
import type {
  PdfHideFallbackContentBlock,
  PdfHideFallbackImage,
  PdfHideLlmFallbackInput,
  PdfHideLowConfidenceCellRef,
} from './pdfHideLlmFallback';

// ============================================================
// ヘルパー
// ============================================================

function makeImage(
  overrides: Partial<PdfHideFallbackImage> = {},
): PdfHideFallbackImage {
  return {
    base64: 'BASE64_PAGE_IMAGE',
    mediaType: 'image/png',
    pageNumber: 1,
    ...overrides,
  };
}

function makeCellRef(
  overrides: Partial<PdfHideLowConfidenceCellRef> = {},
): PdfHideLowConfidenceCellRef {
  return {
    cellId: 'p0s0i0m1',
    partLabel: '1',
    globalMeasureIndex: 1,
    confidence: 'low',
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<PdfHideLlmFallbackInput> = {},
): PdfHideLlmFallbackInput {
  return {
    pageImage: makeImage(),
    draftHideSourceForPage:
      '[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]\n' +
      '[1]\n' +
      '| C4k C4k C4k C4k\n' +
      '| Rm ;low-confidence:p0s0i0m1 minConf=0.50\n',
    lowConfidenceCells: [makeCellRef()],
    ...overrides,
  };
}

/** content block 列から最初の image block を取り出す (なければ undefined) */
function findImageBlock(
  blocks: PdfHideFallbackContentBlock[],
): Extract<PdfHideFallbackContentBlock, { type: 'image' }> | undefined {
  return blocks.find((b) => b.type === 'image') as
    | Extract<PdfHideFallbackContentBlock, { type: 'image' }>
    | undefined;
}

/** content block 列を text のみ連結した文字列にする (debug / assertion 用) */
function concatText(blocks: PdfHideFallbackContentBlock[]): string {
  return blocks
    .map((b) => (b.type === 'text' ? b.text : '[IMAGE]'))
    .join('\n\n');
}

// ============================================================
// A. buildPdfHideLlmFallbackPrompt
// ============================================================

describe('buildPdfHideLlmFallbackPrompt', () => {
  describe('basic shape', () => {
    it('returns systemPrompt + userContent + textOnlyPrompt + summary', () => {
      const prompt = buildPdfHideLlmFallbackPrompt(makeInput());
      expect(typeof prompt.systemPrompt).toBe('string');
      expect(prompt.systemPrompt.length).toBeGreaterThan(0);
      expect(Array.isArray(prompt.userContent)).toBe(true);
      expect(prompt.userContent.length).toBeGreaterThan(0);
      expect(typeof prompt.textOnlyPrompt).toBe('string');
      expect(prompt.summary).toBeDefined();
    });

    it('summary counts lowConfidenceCells and reflects context / instructions flags', () => {
      const prompt = buildPdfHideLlmFallbackPrompt(
        makeInput({
          lowConfidenceCells: [
            makeCellRef({ cellId: 'p0s0i0m1' }),
            makeCellRef({ cellId: 'p0s0i0m2' }),
            makeCellRef({ cellId: 'p0s0i1m0' }),
          ],
          context: { clef: 'TREBLE', keyFifths: 0 },
          additionalInstructions: 'voice 1-2 だけ修正',
        }),
      );
      expect(prompt.summary.lowConfidenceCellCount).toBe(3);
      expect(prompt.summary.pageNumber).toBe(1);
      expect(prompt.summary.hasContext).toBe(true);
      expect(prompt.summary.hasAdditionalInstructions).toBe(true);
    });

    it('summary flags false when context / instructions are omitted', () => {
      const prompt = buildPdfHideLlmFallbackPrompt(
        makeInput({ context: undefined, additionalInstructions: undefined }),
      );
      expect(prompt.summary.hasContext).toBe(false);
      expect(prompt.summary.hasAdditionalInstructions).toBe(false);
    });
  });

  describe('image-first layout', () => {
    it('places image block right after the imageIntro text (before context/draft/cells)', () => {
      const prompt = buildPdfHideLlmFallbackPrompt(
        makeInput({ context: { clef: 'TREBLE' } }),
      );
      // Expected order:
      //   text (imageIntro) → image → text (context) → text (draft) → text (cells) → text (instruction)
      expect(prompt.userContent[0].type).toBe('text');
      expect((prompt.userContent[0] as { text: string }).text).toContain(
        '修正対象ページ画像',
      );
      expect(prompt.userContent[1].type).toBe('image');
      // 以降のブロックに少なくとも draft と cells list と instruction が存在する
      const remainingText = concatText(prompt.userContent.slice(2));
      expect(remainingText).toContain('draft `.hide` ソース');
      expect(remainingText).toContain('修正対象セル');
      expect(remainingText).toContain('## 指示');
    });

    it('image block uses snake_case `media_type` field (Anthropic wire format)', () => {
      const prompt = buildPdfHideLlmFallbackPrompt(makeInput());
      const imgBlock = findImageBlock(prompt.userContent);
      expect(imgBlock).toBeDefined();
      expect(imgBlock!.source.type).toBe('base64');
      expect(imgBlock!.source.media_type).toBe('image/png');
      expect(imgBlock!.source.data).toBe('BASE64_PAGE_IMAGE');
    });
  });

  describe('draft section', () => {
    it('wraps draftHideSourceForPage in a ```hide fenced block', () => {
      const prompt = buildPdfHideLlmFallbackPrompt(makeInput());
      const allText = concatText(prompt.userContent);
      expect(allText).toContain('```hide\n[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]');
      // draft 末尾の改行は rstrip されて ``` の直前にある
      expect(allText).toContain('| Rm ;low-confidence:p0s0i0m1 minConf=0.50\n```');
    });
  });

  describe('low-confidence cells list', () => {
    it('lists each cell with cellId, partLabel, measure, confidence, reason', () => {
      const prompt = buildPdfHideLlmFallbackPrompt(
        makeInput({
          lowConfidenceCells: [
            makeCellRef({
              cellId: 'p0s0i0m1',
              partLabel: '1',
              globalMeasureIndex: 1,
              confidence: 'low',
              reason: 'minConf=0.50',
            }),
            makeCellRef({
              cellId: 'p0s0i1m3',
              partLabel: '2',
              globalMeasureIndex: 3,
              confidence: 'unknown',
              reason: 'no detection',
            }),
          ],
        }),
      );
      const text = concatText(prompt.userContent);
      expect(text).toContain('`p0s0i0m1`');
      expect(text).toContain('part [1]');
      expect(text).toContain('measure 2'); // globalMeasureIndex + 1
      expect(text).toContain('confidence=low');
      expect(text).toContain('minConf=0.50');

      expect(text).toContain('`p0s0i1m3`');
      expect(text).toContain('part [2]');
      expect(text).toContain('measure 4');
      expect(text).toContain('confidence=unknown');
      expect(text).toContain('no detection');
    });

    it('shows "修正対象なし" note when lowConfidenceCells is empty', () => {
      const prompt = buildPdfHideLlmFallbackPrompt(
        makeInput({ lowConfidenceCells: [] }),
      );
      const text = concatText(prompt.userContent);
      expect(text).toContain('修正対象なし');
      expect(prompt.summary.lowConfidenceCellCount).toBe(0);
    });
  });

  describe('context section', () => {
    it('includes clef / time / key / div / title / composer when provided', () => {
      const prompt = buildPdfHideLlmFallbackPrompt(
        makeInput({
          context: {
            clef: 'TREBLE',
            timeSignature: { numerator: 3, denominator: 4 },
            keyFifths: -1,
            div: 32,
            title: 'Test Piece',
            composer: 'Test Composer',
          },
        }),
      );
      const text = concatText(prompt.userContent);
      expect(text).toContain('楽曲メタ情報');
      expect(text).toContain('音部記号: TREBLE');
      expect(text).toContain('拍子: 3/4');
      expect(text).toContain('調号 (fifths): -1');
      expect(text).toContain('DIV: 32');
      expect(text).toContain('タイトル: Test Piece');
      expect(text).toContain('作曲者: Test Composer');
    });

    it('renders positive key fifths with a + sign', () => {
      const prompt = buildPdfHideLlmFallbackPrompt(
        makeInput({ context: { keyFifths: 2 } }),
      );
      expect(concatText(prompt.userContent)).toContain('調号 (fifths): +2');
    });

    it('does not emit a context section when context is undefined', () => {
      const prompt = buildPdfHideLlmFallbackPrompt(
        makeInput({ context: undefined }),
      );
      const text = concatText(prompt.userContent);
      expect(text).not.toContain('楽曲メタ情報');
    });
  });

  describe('additional instructions', () => {
    it('appends additionalInstructions section when provided', () => {
      const prompt = buildPdfHideLlmFallbackPrompt(
        makeInput({ additionalInstructions: '和音の 3 音目は b13 扱い' }),
      );
      const text = concatText(prompt.userContent);
      expect(text).toContain('## 追加指示');
      expect(text).toContain('和音の 3 音目は b13 扱い');
    });

    it('does not emit additional instructions section when blank', () => {
      const prompt = buildPdfHideLlmFallbackPrompt(
        makeInput({ additionalInstructions: '   ' }),
      );
      const text = concatText(prompt.userContent);
      expect(text).not.toContain('## 追加指示');
    });
  });

  describe('textOnlyPrompt', () => {
    it('replaces image with [image: page N] placeholder', () => {
      const prompt = buildPdfHideLlmFallbackPrompt(
        makeInput({
          pageImage: makeImage({ pageNumber: 3, label: 'system 2-4' }),
        }),
      );
      expect(prompt.textOnlyPrompt).toContain('[image: page 3 — system 2-4]');
      expect(prompt.textOnlyPrompt).not.toContain('BASE64_PAGE_IMAGE');
    });

    it('uses generic label when pageNumber / label are absent', () => {
      const prompt = buildPdfHideLlmFallbackPrompt(
        makeInput({
          pageImage: makeImage({ pageNumber: undefined, label: undefined }),
        }),
      );
      expect(prompt.textOnlyPrompt).toContain('[image: page image]');
    });
  });

  describe('systemPrompt content', () => {
    it('emphasizes silent-fill ban + fix-only + cellId preservation', () => {
      const { systemPrompt } = buildPdfHideLlmFallbackPrompt(makeInput());
      expect(systemPrompt).toContain('silent fill');
      expect(systemPrompt).toContain('still-uncertain');
      expect(systemPrompt).toContain('cellId');
      expect(systemPrompt).toContain('画像こそが真の source-of-truth');
    });
  });
});

// ============================================================
// B. applyPdfHideLlmFallbackResponse
// ============================================================

describe('applyPdfHideLlmFallbackResponse', () => {
  describe('fenced block extraction', () => {
    it('extracts the first ```hide``` block and reports hideBlockFound=true', () => {
      const response = [
        '12 セル中 1 セルを修正しました。',
        '',
        '```hide',
        '[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]',
        '[1]',
        '| C4k C4k C4k C4k',
        '| C4j D4j E4j F4j C4k ;corrected:p0s0i0m1',
        '```',
      ].join('\n');
      const result = applyPdfHideLlmFallbackResponse({ llmResponse: response });
      expect(result.hideBlockFound).toBe(true);
      expect(result.hideBlockCount).toBe(1);
      expect(result.hideSource).toContain('[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]');
      expect(result.cellOverrides).toHaveLength(1);
      expect(result.cellOverrides[0].cellId).toBe('p0s0i0m1');
      expect(result.cellOverrides[0].tokens).toBe('C4j D4j E4j F4j C4k');
      expect(result.cellOverrides[0].stillUncertain).toBe(false);
    });

    it('warns when no ```hide``` block is found and returns empty cellOverrides', () => {
      const response = 'これは修正できませんでした。理由は画像が不鮮明です。';
      const result = applyPdfHideLlmFallbackResponse({ llmResponse: response });
      expect(result.hideBlockFound).toBe(false);
      expect(result.hideBlockCount).toBe(0);
      expect(result.cellOverrides).toEqual([]);
      expect(result.warnings.some((w) => w.includes('見つかりませんでした'))).toBe(
        true,
      );
    });

    it('warns when multiple ```hide``` blocks appear and uses the first', () => {
      const response = [
        'First attempt:',
        '```hide',
        '| C4k C4k C4k C4k ;corrected:p0s0i0m1',
        '```',
        'Second attempt:',
        '```hide',
        '| D4k D4k D4k D4k ;corrected:p0s0i0m1',
        '```',
      ].join('\n');
      const result = applyPdfHideLlmFallbackResponse({ llmResponse: response });
      expect(result.hideBlockCount).toBe(2);
      expect(result.warnings.some((w) => w.includes('2 個あります'))).toBe(true);
      expect(result.cellOverrides).toHaveLength(1);
      expect(result.cellOverrides[0].tokens).toBe('C4k C4k C4k C4k');
    });
  });

  describe('cell override extraction', () => {
    it('extracts multiple cell overrides with cellId / tokens / comment', () => {
      const response = [
        '```hide',
        '[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]',
        '[1]',
        '| C4k C4k C4k C4k',
        '| F4k G4k A4k Bb4k ;corrected:p0s0i0m1',
        '| Rk Rk C4k C4k ;corrected:p0s0i0m2 partial-fix',
        '[2]',
        '| G3k G3k G3k G3k',
        '| F3k E3k D3k C3k ;corrected:p0s0i1m1',
        '```',
      ].join('\n');
      const result = applyPdfHideLlmFallbackResponse({ llmResponse: response });
      expect(result.cellOverrides).toHaveLength(3);

      const byId = new Map(result.cellOverrides.map((o) => [o.cellId, o]));
      expect(byId.get('p0s0i0m1')?.tokens).toBe('F4k G4k A4k Bb4k');
      expect(byId.get('p0s0i0m2')?.tokens).toBe('Rk Rk C4k C4k');
      expect(byId.get('p0s0i0m2')?.comment).toContain('partial-fix');
      expect(byId.get('p0s0i1m1')?.tokens).toBe('F3k E3k D3k C3k');
    });

    it('skips lines without `;cellId` marker (header / part switch / high-confidence)', () => {
      const response = [
        '```hide',
        '[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]', // header: no `|`
        '[1]', // part switch: no `|`
        '| C4k C4k C4k C4k', // high-confidence cell: `|` but no `;cellId`
        '| D4k D4k D4k D4k ;corrected:p0s0i0m1',
        '```',
      ].join('\n');
      const result = applyPdfHideLlmFallbackResponse({ llmResponse: response });
      expect(result.cellOverrides).toHaveLength(1);
      expect(result.cellOverrides[0].cellId).toBe('p0s0i0m1');
    });

    it('detects still-uncertain via `;still-uncertain:` marker', () => {
      const response = [
        '```hide',
        '| Rm ;still-uncertain:p0s0i0m1 octave-ambiguous',
        '```',
      ].join('\n');
      const result = applyPdfHideLlmFallbackResponse({ llmResponse: response });
      expect(result.cellOverrides).toHaveLength(1);
      expect(result.cellOverrides[0].stillUncertain).toBe(true);
    });

    it('treats unchanged Phase 3 markers (low-/mid-confidence) as still-uncertain', () => {
      // LLM が元のマーカーを変えずに返してきた場合 = 実質「修正できていない」
      const response = [
        '```hide',
        '| C4k C4k C4k C4k ;low-confidence:p0s0i0m1 minConf=0.30',
        '| Rm ;mid-confidence:p0s0i0m2 minConf=0.60',
        '```',
      ].join('\n');
      const result = applyPdfHideLlmFallbackResponse({ llmResponse: response });
      expect(result.cellOverrides).toHaveLength(2);
      expect(result.cellOverrides.every((o) => o.stillUncertain)).toBe(true);
    });

    it('trims token whitespace even with extra spaces around `|`', () => {
      const response = [
        '```hide',
        '|   C4k   D4k   E4k   F4k   ;corrected:p0s0i0m1',
        '```',
      ].join('\n');
      const result = applyPdfHideLlmFallbackResponse({ llmResponse: response });
      expect(result.cellOverrides[0].tokens).toBe('C4k   D4k   E4k   F4k');
      // leading/trailing whitespace is stripped; internal whitespace is preserved
    });

    it('handles cellIds with hyphens (e.g. missing-part0-m3)', () => {
      const response = [
        '```hide',
        '| Rm ;still-uncertain:missing-part0-m3 part-measure-count-mismatch',
        '```',
      ].join('\n');
      const result = applyPdfHideLlmFallbackResponse({ llmResponse: response });
      expect(result.cellOverrides).toHaveLength(1);
      expect(result.cellOverrides[0].cellId).toBe('missing-part0-m3');
    });
  });

  describe('expectedCellIds filter', () => {
    it('rejects cellIds not in expected set and emits warning', () => {
      const response = [
        '```hide',
        '| C4k C4k C4k C4k ;corrected:p0s0i0m1',
        '| D4k D4k D4k D4k ;corrected:p9s9i9m9', // unexpected
        '```',
      ].join('\n');
      const result = applyPdfHideLlmFallbackResponse({
        llmResponse: response,
        expectedCellIds: ['p0s0i0m1'],
      });
      expect(result.cellOverrides).toHaveLength(1);
      expect(result.cellOverrides[0].cellId).toBe('p0s0i0m1');
      expect(
        result.warnings.some((w) => w.includes("予期せぬ cellId") && w.includes('p9s9i9m9')),
      ).toBe(true);
    });

    it('warns about expected cellIds that are missing from the response', () => {
      const response = [
        '```hide',
        '| C4k C4k C4k C4k ;corrected:p0s0i0m1',
        '```',
      ].join('\n');
      const result = applyPdfHideLlmFallbackResponse({
        llmResponse: response,
        expectedCellIds: ['p0s0i0m1', 'p0s0i0m2'],
      });
      expect(
        result.warnings.some(
          (w) => w.includes('期待されていた cellId') && w.includes('p0s0i0m2'),
        ),
      ).toBe(true);
    });

    it('accepts all overrides when expectedCellIds is undefined', () => {
      const response = [
        '```hide',
        '| A ;corrected:p0s0i0m1',
        '| B ;corrected:abc123',
        '```',
      ].join('\n');
      const result = applyPdfHideLlmFallbackResponse({ llmResponse: response });
      expect(result.cellOverrides).toHaveLength(2);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('duplicate cellIds', () => {
    it('keeps the first and warns about duplicates', () => {
      const response = [
        '```hide',
        '| C4k C4k C4k C4k ;corrected:p0s0i0m1 first',
        '| D4k D4k D4k D4k ;corrected:p0s0i0m1 second',
        '```',
      ].join('\n');
      const result = applyPdfHideLlmFallbackResponse({ llmResponse: response });
      expect(result.cellOverrides).toHaveLength(1);
      expect(result.cellOverrides[0].tokens).toBe('C4k C4k C4k C4k');
      expect(
        result.warnings.some((w) => w.includes('複数回出現') && w.includes('p0s0i0m1')),
      ).toBe(true);
    });
  });

  describe('UNRESOLVED section', () => {
    it('extracts bullet items from UNRESOLVED section after the hide block', () => {
      const response = [
        '状況サマリ: 2 セル中 1 セルを修正、1 セルは不鮮明。',
        '',
        '```hide',
        '| C4k C4k C4k C4k ;corrected:p0s0i0m1',
        '```',
        '',
        'UNRESOLVED:',
        '- p0s0i0m2: octave-ambiguous (5 or 6?)',
        '- p0s0i1m3: image too blurry',
        '',
        '## その他の注記',
        'これは UNRESOLVED ではなく注記です。',
      ].join('\n');
      const result = applyPdfHideLlmFallbackResponse({ llmResponse: response });
      expect(result.unresolved).toHaveLength(2);
      expect(result.unresolved[0].text).toBe('p0s0i0m2: octave-ambiguous (5 or 6?)');
      expect(result.unresolved[0].index).toBe(1);
      expect(result.unresolved[1].text).toBe('p0s0i1m3: image too blurry');
      expect(result.unresolved[1].index).toBe(2);
    });

    it('returns empty unresolved when no UNRESOLVED header exists', () => {
      const response = [
        '```hide',
        '| C4k C4k C4k C4k ;corrected:p0s0i0m1',
        '```',
        '全て修正完了しました。',
      ].join('\n');
      const result = applyPdfHideLlmFallbackResponse({ llmResponse: response });
      expect(result.unresolved).toEqual([]);
    });

    it('handles inline UNRESOLVED header content as the first item', () => {
      const response = [
        '```hide',
        '| C4k C4k C4k C4k ;corrected:p0s0i0m1',
        '```',
        '',
        'UNRESOLVED: p0s0i0m2 の 3 拍目の和音が不鮮明',
      ].join('\n');
      const result = applyPdfHideLlmFallbackResponse({ llmResponse: response });
      expect(result.unresolved).toHaveLength(1);
      expect(result.unresolved[0].text).toBe('p0s0i0m2 の 3 拍目の和音が不鮮明');
    });
  });

  describe('end-to-end shape', () => {
    it('returns fully-populated result for a realistic response', () => {
      const response = [
        '12 セル中 2 セルを修正、1 セルは画像不鮮明のため UNRESOLVED。',
        '',
        '```hide',
        '[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]',
        '[1]',
        '| C4k C4k C4k C4k',
        '| F4k G4k A4k Bb4k ;corrected:p0s0i0m1',
        '| Rm ;still-uncertain:p0s0i0m2 octave-ambiguous',
        '[2]',
        '| G3k G3k G3k G3k',
        '| A3k Bb3k C4k D4k ;corrected:p0s0i1m1',
        '```',
        '',
        'UNRESOLVED:',
        '- p0s0i0m2: 画像が不鮮明でオクターブが判別不能',
      ].join('\n');
      const result = applyPdfHideLlmFallbackResponse({
        llmResponse: response,
        expectedCellIds: ['p0s0i0m1', 'p0s0i0m2', 'p0s0i1m1'],
      });

      expect(result.hideBlockFound).toBe(true);
      expect(result.hideBlockCount).toBe(1);
      expect(result.cellOverrides).toHaveLength(3);

      const byId = new Map(result.cellOverrides.map((o) => [o.cellId, o]));
      expect(byId.get('p0s0i0m1')?.stillUncertain).toBe(false);
      expect(byId.get('p0s0i0m2')?.stillUncertain).toBe(true);
      expect(byId.get('p0s0i1m1')?.stillUncertain).toBe(false);

      expect(result.unresolved).toHaveLength(1);
      expect(result.unresolved[0].text).toContain('p0s0i0m2');
      expect(result.warnings).toEqual([]);
    });
  });
});
