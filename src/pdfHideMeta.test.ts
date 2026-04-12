/**
 * pdfHideMeta.test.ts — pdfHideMeta.ts (Phase 1 LLM 全曲構造解析 prompt + apply) のテスト
 */

import { describe, it, expect } from 'vitest';
import {
  buildPdfHideMetaPrompt,
  applyPdfHideMetaResponse,
} from './pdfHideMeta';
import type { PdfHideMetaImage } from './pdfHideMeta';

// ============================================================
// テストヘルパー
// ============================================================

function makeImage(pageNumber: number): PdfHideMetaImage {
  return {
    base64: `BASE64_PAGE_${pageNumber}`,
    mediaType: 'image/png',
    pageNumber,
    label: `page ${pageNumber}`,
  };
}

/** validate を必ず通す最小限の score context object. */
function makeValidContextObject(): Record<string, unknown> {
  return {
    voicePartsCount: 4,
    hasPiano: false,
    hasPercussion: false,
    stavesPerSystem: 4,
    staffRoles: ['voice', 'voice', 'voice', 'voice'],
    clefsPerStaff: ['TREBLE', 'TREBLE', 'TREBLE', 'BASS'],
    initialTimeSignature: { numerator: 4, denominator: 4 },
    initialKeyFifths: -1,
    lyricsRows: 1,
    totalMeasures: 16,
  };
}

/** JSON object を ```json ブロックに包んだテキスト応答を作る. */
function wrapJsonBlock(obj: unknown, prefix = '概要: 4 声 SATB、F メジャー、4/4、16 小節'): string {
  return `${prefix}\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;
}

// ============================================================
// buildPdfHideMetaPrompt
// ============================================================

describe('pdfHideMeta — buildPdfHideMetaPrompt', () => {
  it('builds a multimodal prompt with system + user content', () => {
    const prompt = buildPdfHideMetaPrompt({
      pageImages: [makeImage(1), makeImage(2)],
    });

    expect(prompt.systemPrompt).toContain('構造解析');
    expect(prompt.systemPrompt).toContain('voicePartsCount');
    expect(prompt.systemPrompt).toContain('```json');
    expect(prompt.userContent.length).toBeGreaterThan(0);
    expect(prompt.summary).toEqual({
      imageCount: 2,
      hasPieceHint: false,
      hasAdditionalInstructions: false,
    });
  });

  it('includes exactly N image blocks for N input pages', () => {
    const prompt = buildPdfHideMetaPrompt({
      pageImages: [makeImage(1), makeImage(2), makeImage(3)],
    });
    const imageBlocks = prompt.userContent.filter((b) => b.type === 'image');
    expect(imageBlocks).toHaveLength(3);
    // 順序保持
    expect((imageBlocks[0] as { source: { data: string } }).source.data).toBe(
      'BASE64_PAGE_1',
    );
    expect((imageBlocks[2] as { source: { data: string } }).source.data).toBe(
      'BASE64_PAGE_3',
    );
  });

  it('uses Anthropic wire format for image blocks (snake_case media_type)', () => {
    const prompt = buildPdfHideMetaPrompt({
      pageImages: [makeImage(1)],
    });
    const img = prompt.userContent.find((b) => b.type === 'image');
    expect(img).toBeDefined();
    expect((img as { source: { media_type: string; type: string } }).source.media_type).toBe('image/png');
    expect((img as { source: { type: string } }).source.type).toBe('base64');
  });

  it('places instruction text AFTER images (so LLM reads images then instruction)', () => {
    const prompt = buildPdfHideMetaPrompt({
      pageImages: [makeImage(1)],
    });
    const idxImage = prompt.userContent.findIndex((b) => b.type === 'image');
    const idxInstruction = prompt.userContent.findIndex(
      (b) => b.type === 'text' && b.text.includes('抽出指示'),
    );
    expect(idxImage).toBeGreaterThanOrEqual(0);
    expect(idxInstruction).toBeGreaterThan(idxImage);
  });

  it('includes piece hint section when provided', () => {
    const prompt = buildPdfHideMetaPrompt({
      pageImages: [makeImage(1)],
      pieceHint: { title: 'Test Song', composer: 'Anon' },
    });
    expect(prompt.summary.hasPieceHint).toBe(true);
    const hintBlock = prompt.userContent.find(
      (b) => b.type === 'text' && b.text.includes('Test Song'),
    );
    expect(hintBlock).toBeDefined();
    expect((hintBlock as { text: string }).text).toContain('Anon');
  });

  it('omits piece hint section when all fields blank', () => {
    const prompt = buildPdfHideMetaPrompt({
      pageImages: [makeImage(1)],
      pieceHint: { title: '', composer: '   ' },
    });
    expect(prompt.summary.hasPieceHint).toBe(false);
    const hintBlock = prompt.userContent.find(
      (b) => b.type === 'text' && b.text.includes('楽曲ヒント'),
    );
    expect(hintBlock).toBeUndefined();
  });

  it('includes additionalInstructions when provided', () => {
    const prompt = buildPdfHideMetaPrompt({
      pageImages: [makeImage(1)],
      additionalInstructions: '歌詞は無視してください',
    });
    expect(prompt.summary.hasAdditionalInstructions).toBe(true);
    const block = prompt.userContent.find(
      (b) => b.type === 'text' && b.text.includes('歌詞は無視'),
    );
    expect(block).toBeDefined();
  });

  it('handles zero pageImages without throwing', () => {
    const prompt = buildPdfHideMetaPrompt({ pageImages: [] });
    expect(prompt.summary.imageCount).toBe(0);
    expect(prompt.userContent.filter((b) => b.type === 'image')).toHaveLength(0);
    // intro が "なし" になる
    const intro = prompt.userContent.find(
      (b) => b.type === 'text' && b.text.includes('楽譜画像'),
    );
    expect((intro as { text: string }).text).toContain('なし');
  });

  it('textOnlyPrompt is non-empty and references all pages', () => {
    const prompt = buildPdfHideMetaPrompt({
      pageImages: [makeImage(1), makeImage(2)],
    });
    expect(prompt.textOnlyPrompt).toContain('page 1');
    expect(prompt.textOnlyPrompt).toContain('page 2');
    expect(prompt.textOnlyPrompt).toContain('抽出指示');
  });
});

// ============================================================
// applyPdfHideMetaResponse — happy path
// ============================================================

describe('pdfHideMeta — applyPdfHideMetaResponse (happy path)', () => {
  it('parses valid JSON block with all required fields', () => {
    const obj = makeValidContextObject();
    const result = applyPdfHideMetaResponse({ llmResponse: wrapJsonBlock(obj) });
    expect(result.parseError).toBeUndefined();
    expect(result.context).toBeDefined();
    expect(result.context!.voicePartsCount).toBe(4);
    expect(result.context!.hasPiano).toBe(false);
    expect(result.context!.stavesPerSystem).toBe(4);
    expect(result.context!.staffRoles).toEqual(['voice', 'voice', 'voice', 'voice']);
    expect(result.context!.clefsPerStaff).toEqual(['TREBLE', 'TREBLE', 'TREBLE', 'BASS']);
    expect(result.context!.initialTimeSignature).toEqual({ numerator: 4, denominator: 4 });
    expect(result.context!.initialKeyFifths).toBe(-1);
    expect(result.context!.lyricsRows).toBe(1);
    expect(result.context!.totalMeasures).toBe(16);
    expect(result.warnings).toEqual([]);
  });

  it('handles uppercase JSON tag', () => {
    const obj = makeValidContextObject();
    const response = `summary\n\n\`\`\`JSON\n${JSON.stringify(obj)}\n\`\`\``;
    const result = applyPdfHideMetaResponse({ llmResponse: response });
    expect(result.parseError).toBeUndefined();
    expect(result.context).toBeDefined();
  });

  it('parses optional metadata fields', () => {
    const obj = {
      ...makeValidContextObject(),
      title: 'Eine kleine Nachtmusik',
      composer: 'Mozart',
      arranger: 'arr. me',
      translator: 'tr. you',
      copyright: '© 2026',
    };
    const result = applyPdfHideMetaResponse({ llmResponse: wrapJsonBlock(obj) });
    expect(result.context!.title).toBe('Eine kleine Nachtmusik');
    expect(result.context!.composer).toBe('Mozart');
    expect(result.context!.arranger).toBe('arr. me');
    expect(result.context!.translator).toBe('tr. you');
    expect(result.context!.copyright).toBe('© 2026');
  });

  it('parses keyChanges / timeChanges / repeatStructure', () => {
    const obj = {
      ...makeValidContextObject(),
      keyChanges: [{ measureIndex: 8, fifths: 2 }],
      timeChanges: [{ measureIndex: 12, numerator: 3, denominator: 4 }],
      repeatStructure: [{ startMeasure: 0, endMeasure: 7, kind: 'simple' }],
    };
    const result = applyPdfHideMetaResponse({ llmResponse: wrapJsonBlock(obj) });
    expect(result.context!.keyChanges).toEqual([{ measureIndex: 8, fifths: 2 }]);
    expect(result.context!.timeChanges).toEqual([
      { measureIndex: 12, numerator: 3, denominator: 4 },
    ]);
    expect(result.context!.repeatStructure).toEqual([
      { startMeasure: 0, endMeasure: 7, kind: 'simple' },
    ]);
  });

  it('parses tempoMarks with optional bpm', () => {
    const obj = {
      ...makeValidContextObject(),
      tempoMarks: [
        { measureIndex: 0, marking: 'Allegro', bpm: 120 },
        { measureIndex: 8, marking: 'rit.' },
      ],
    };
    const result = applyPdfHideMetaResponse({ llmResponse: wrapJsonBlock(obj) });
    expect(result.context!.tempoMarks).toHaveLength(2);
    expect(result.context!.tempoMarks![0]).toEqual({
      measureIndex: 0,
      marking: 'Allegro',
      bpm: 120,
    });
    expect(result.context!.tempoMarks![1]).toEqual({
      measureIndex: 8,
      marking: 'rit.',
    });
    expect(result.context!.tempoMarks![1].bpm).toBeUndefined();
  });

  it('parses chordSymbols, rehearsalMarks, sectionLabels', () => {
    const obj = {
      ...makeValidContextObject(),
      chordSymbols: [
        { measureIndex: 0, beat: 0, text: 'C' },
        { measureIndex: 0, beat: 2, staffIndex: 0, text: 'G7' },
      ],
      rehearsalMarks: [{ measureIndex: 8, label: 'A' }],
      sectionLabels: [{ measureIndex: 0, label: 'Verse 1' }],
    };
    const result = applyPdfHideMetaResponse({ llmResponse: wrapJsonBlock(obj) });
    expect(result.context!.chordSymbols).toHaveLength(2);
    expect(result.context!.chordSymbols![0].text).toBe('C');
    expect(result.context!.chordSymbols![1].staffIndex).toBe(0);
    expect(result.context!.rehearsalMarks).toEqual([{ measureIndex: 8, label: 'A' }]);
    expect(result.context!.sectionLabels).toEqual([{ measureIndex: 0, label: 'Verse 1' }]);
  });

  it('parses lyrics with rows', () => {
    const obj = {
      ...makeValidContextObject(),
      lyricsRows: 2,
      lyrics: {
        rows: [
          { rowIndex: 0, language: 'ja', text: 'こんにちは みなさん' },
          { rowIndex: 1, language: 'en', text: 'hello everyone' },
        ],
      },
    };
    const result = applyPdfHideMetaResponse({ llmResponse: wrapJsonBlock(obj) });
    expect(result.context!.lyrics!.rows).toHaveLength(2);
    expect(result.context!.lyrics!.rows[0].language).toBe('ja');
    expect(result.context!.lyrics!.rows[1].text).toBe('hello everyone');
  });
});

// ============================================================
// applyPdfHideMetaResponse — error / warning paths
// ============================================================

describe('pdfHideMeta — applyPdfHideMetaResponse (errors)', () => {
  it('returns parseError when no fenced block exists', () => {
    const result = applyPdfHideMetaResponse({
      llmResponse: 'no JSON here, just prose',
    });
    expect(result.context).toBeUndefined();
    expect(result.parseError).toContain('json');
  });

  it('returns parseError on malformed JSON', () => {
    const response = '```json\n{ "voicePartsCount": 4,  // dangling comma\n```';
    const result = applyPdfHideMetaResponse({ llmResponse: response });
    expect(result.context).toBeUndefined();
    expect(result.parseError).toContain('JSON parse');
    expect(result.rawJson).toBeDefined();
  });

  it('returns parseError when top-level is not an object', () => {
    const response = '```json\n[1, 2, 3]\n```';
    const result = applyPdfHideMetaResponse({ llmResponse: response });
    expect(result.parseError).toContain('オブジェクト');
  });

  it('returns parseError when voicePartsCount missing', () => {
    const obj: Record<string, unknown> = makeValidContextObject();
    delete obj.voicePartsCount;
    const result = applyPdfHideMetaResponse({ llmResponse: wrapJsonBlock(obj) });
    expect(result.context).toBeUndefined();
    expect(result.parseError).toContain('voicePartsCount');
  });

  it('returns parseError when hasPiano is wrong type', () => {
    const obj = { ...makeValidContextObject(), hasPiano: 'yes' };
    const result = applyPdfHideMetaResponse({ llmResponse: wrapJsonBlock(obj) });
    expect(result.parseError).toContain('hasPiano');
  });

  it('returns parseError when staffRoles length mismatches stavesPerSystem', () => {
    const obj = {
      ...makeValidContextObject(),
      stavesPerSystem: 4,
      staffRoles: ['voice', 'voice'], // length 2 ≠ 4
    };
    const result = applyPdfHideMetaResponse({ llmResponse: wrapJsonBlock(obj) });
    expect(result.parseError).toContain('staffRoles');
    expect(result.parseError).toContain('stavesPerSystem');
  });

  it('returns parseError when staffRoles has invalid value', () => {
    const obj = {
      ...makeValidContextObject(),
      staffRoles: ['voice', 'voice', 'voice', 'soprano'], // soprano not allowed
    };
    const result = applyPdfHideMetaResponse({ llmResponse: wrapJsonBlock(obj) });
    expect(result.parseError).toContain('staffRoles');
  });

  it('returns parseError when initialKeyFifths out of -7..+7', () => {
    const obj = { ...makeValidContextObject(), initialKeyFifths: 12 };
    const result = applyPdfHideMetaResponse({ llmResponse: wrapJsonBlock(obj) });
    expect(result.parseError).toContain('initialKeyFifths');
  });

  it('returns parseError when initialTimeSignature is malformed', () => {
    const obj = {
      ...makeValidContextObject(),
      initialTimeSignature: { numerator: 4 }, // missing denominator
    };
    const result = applyPdfHideMetaResponse({ llmResponse: wrapJsonBlock(obj) });
    expect(result.parseError).toContain('initialTimeSignature');
  });

  it('warns and drops malformed optional field (keyChanges as object)', () => {
    const obj = { ...makeValidContextObject(), keyChanges: { foo: 'bar' } };
    const result = applyPdfHideMetaResponse({ llmResponse: wrapJsonBlock(obj) });
    expect(result.context).toBeDefined();
    expect(result.context!.keyChanges).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('keyChanges'))).toBe(true);
  });

  it('warns and drops malformed entry within keyChanges array', () => {
    const obj = {
      ...makeValidContextObject(),
      keyChanges: [
        { measureIndex: 0, fifths: 1 },
        { measureIndex: 'eight', fifths: 2 }, // invalid
      ],
    };
    const result = applyPdfHideMetaResponse({ llmResponse: wrapJsonBlock(obj) });
    expect(result.context).toBeDefined();
    expect(result.context!.keyChanges).toEqual([{ measureIndex: 0, fifths: 1 }]);
    expect(result.warnings.some((w) => w.includes('keyChanges[1]'))).toBe(true);
  });

  it('warns and drops malformed lyrics structure', () => {
    const obj = { ...makeValidContextObject(), lyrics: { foo: 'bar' } };
    const result = applyPdfHideMetaResponse({ llmResponse: wrapJsonBlock(obj) });
    expect(result.context!.lyrics).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('lyrics'))).toBe(true);
  });

  it('returns parseError listing multiple missing fields', () => {
    const obj: Record<string, unknown> = makeValidContextObject();
    delete obj.voicePartsCount;
    delete obj.totalMeasures;
    const result = applyPdfHideMetaResponse({ llmResponse: wrapJsonBlock(obj) });
    expect(result.parseError).toContain('voicePartsCount');
    expect(result.parseError).toContain('totalMeasures');
  });
});
