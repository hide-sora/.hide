/**
 * pdfHideLlmReview.ts — LLM による .hide draft の校正
 *
 * Audiveris OMR の draft .hide と PDF ページ画像を LLM に送り、
 * 楽譜画像と照合して修正済み .hide を返す。
 *
 * パート単位で LLM を呼び出し、トークン量と精度を両立する。
 *
 * v2: プロンプト強化 + duration バリデーション + フォーマット正規化
 */

import type { CallLlmFn } from './pdfHideLlm';

// ============================================================
// 公開型
// ============================================================

export interface LlmReviewInput {
  /** Audiveris→musicXmlToHide で生成した draft .hide ソース */
  draftHideSource: string;
  /** PDF 各ページの base64 PNG */
  base64Pages: Array<{ base64: string; mediaType: 'image/png' }>;
  /** musicXmlToHide の warnings (参考情報として LLM に渡す) */
  warnings: string[];
  /** LLM 呼び出し関数 */
  callLlm: CallLlmFn;
  /** 進捗コールバック */
  onProgress?: (detail: string) => void;
  /** 最大送信ページ数 (default: 8。大きいスコアのコスト制御) */
  maxPages?: number;
}

export interface LlmReviewResult {
  /** 修正済み .hide ソース */
  correctedSource: string;
  /** LLM が変更を加えたか */
  wasModified: boolean;
  /** LLM の生応答テキスト (デバッグ用) */
  rawResponse: string;
  /** バリデーションで draft に戻された小節数 */
  fallbackCount: number;
}

// ============================================================
// 公開API
// ============================================================

/**
 * LLM で draft .hide を校正する。
 *
 * パート単位に分割し、各パートを PDF 画像と照合して修正。
 * 修正後に duration バリデーションを行い、壊れた小節は draft に戻す。
 */
export async function reviewHideWithLlm(
  input: LlmReviewInput,
): Promise<LlmReviewResult> {
  const progress = input.onProgress ?? (() => {});
  const maxPages = input.maxPages ?? 8;

  const parts = splitIntoParts(input.draftHideSource);
  if (parts.length === 0) {
    return {
      correctedSource: input.draftHideSource,
      wasModified: false,
      rawResponse: '',
      fallbackCount: 0,
    };
  }

  const pages = input.base64Pages.slice(0, maxPages);
  const headerLine = input.draftHideSource.split('\n')[0];

  // ヘッダー解析
  const div = parseDivFromHeader(headerLine);
  const time = parseTimeFromHeader(headerLine);
  const expectedDur = div * time.num / time.den;

  const relevantWarnings = input.warnings.slice(0, 50);

  const correctedParts: string[] = [];
  const rawResponses: string[] = [];
  let anyModified = false;
  let totalFallbacks = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    progress(`パート ${i + 1}/${parts.length} を LLM で校正中...`);

    const partWarnings = relevantWarnings.filter(
      w => w.includes(`パート#${i + 1} `) || !w.includes('パート#'),
    );

    const result = await reviewSinglePart({
      headerLine,
      partIndex: i,
      partSource: part,
      totalParts: parts.length,
      base64Pages: pages,
      warnings: partWarnings,
      callLlm: input.callLlm,
      div,
      expectedMeasureDur: expectedDur,
    });

    correctedParts.push(result.correctedPart);
    rawResponses.push(result.rawResponse);
    totalFallbacks += result.fallbackCount;
    if (result.wasModified) anyModified = true;
  }

  if (totalFallbacks > 0) {
    progress(`バリデーション完了: ${totalFallbacks} 小節を draft に戻しました`);
  }

  const correctedSource = headerLine + '\n' + correctedParts.join('\n');

  return {
    correctedSource,
    wasModified: anyModified,
    rawResponse: rawResponses.join('\n---\n'),
    fallbackCount: totalFallbacks,
  };
}

// ============================================================
// 内部: パート分割
// ============================================================

function splitIntoParts(hideSource: string): string[] {
  const lines = hideSource.split('\n');
  const parts: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.includes(']|')) {
      parts.push(trimmed);
    }
  }

  return parts;
}

// ============================================================
// 内部: ヘッダー解析
// ============================================================

function parseDivFromHeader(headerLine: string): number {
  const m = headerLine.match(/DIV:(\d+)/);
  return m ? parseInt(m[1]) : 32;
}

function parseTimeFromHeader(headerLine: string): { num: number; den: number } {
  const m = headerLine.match(/TIME:(\d+)\/(\d+)/);
  return m ? { num: parseInt(m[1]), den: parseInt(m[2]) } : { num: 4, den: 4 };
}

// ============================================================
// 内部: 単一パートの LLM レビュー + バリデーション
// ============================================================

interface ReviewSinglePartInput {
  headerLine: string;
  partIndex: number;
  partSource: string;
  totalParts: number;
  base64Pages: Array<{ base64: string; mediaType: 'image/png' }>;
  warnings: string[];
  callLlm: CallLlmFn;
  div: number;
  expectedMeasureDur: number;
}

interface ReviewSinglePartResult {
  correctedPart: string;
  wasModified: boolean;
  rawResponse: string;
  fallbackCount: number;
}

async function reviewSinglePart(
  input: ReviewSinglePartInput,
): Promise<ReviewSinglePartResult> {
  const systemPrompt = buildReviewSystemPrompt(input.div, input.expectedMeasureDur);

  const userContent = buildReviewUserContent({
    headerLine: input.headerLine,
    partIndex: input.partIndex,
    partSource: input.partSource,
    totalParts: input.totalParts,
    base64Pages: input.base64Pages,
    warnings: input.warnings,
    expectedMeasureDur: input.expectedMeasureDur,
    div: input.div,
  });

  const rawResponse = await input.callLlm({
    systemPrompt,
    userContent,
    maxTokens: 16384,
  });

  // LLM 応答から .hide コードブロックを抽出
  let correctedPart = extractHideBlock(rawResponse, input.partSource);

  // バリデーション + フォールバック + フォーマット正規化
  const { fixed, fallbackCount } = validateAndFixPart(
    correctedPart,
    input.partSource,
    input.div,
    input.expectedMeasureDur,
  );
  correctedPart = fixed;

  const wasModified =
    normalizeForCompare(correctedPart) !== normalizeForCompare(input.partSource);

  return { correctedPart, wasModified, rawResponse, fallbackCount };
}

// ============================================================
// 内部: プロンプト構築 (強化版)
// ============================================================

function buildReviewSystemPrompt(div: number, expectedMeasureDur: number): string {
  const u = (divisor: number) => div / divisor;

  return `You are an expert music transcription proofreader reviewing a .hide notation file generated by OMR.

## .hide notation — complete reference

### Header
\`[CLEF:TREBLE TIME:4/4 KEY:-3 DIV:${div}]\`

### Parts
Each part is one line: \`[N]| notes , notes , notes ,,, |\`
- \`[N]\` = part number (1-based), \`[P]\` = voice percussion
- \`,\` = measure barrier (separates measures)
- \`,,,\` = final barline
- Notes within a measure are separated by SPACES

### Note syntax: PitchOctaveDuration
\`C4k\` = pitch C, octave 4, quarter note

### Duration characters (DIV:${div})
| char | name    | units |
|------|---------|-------|
| m    | whole   | ${u(1)}u |
| l    | half    | ${u(2)}u |
| k    | quarter | ${u(4)}u |
| j    | eighth  | ${u(8)}u |
| i    | 16th    | ${u(16)}u |
| h    | 32nd    | ${u(32)}u |

- Dotted: append \`.\` = base x 1.5 (e.g. \`k.\` = ${u(4) * 1.5}u, \`l.\` = ${u(2) * 1.5}u)
- Double-dotted: append \`..\` = base x 1.75

### Rests
\`Rk\` = quarter rest (${u(4)}u), \`Rl\` = half rest (${u(2)}u), \`Rm\` = whole rest (${u(1)}u)

### Ties
\`C4k+C4j\` = C4 quarter tied to C4 eighth = ${u(4) + u(8)}u total

### Accidentals
\`Gb4\` = G-flat, \`F#4\` = F-sharp, \`Bn4\` = B-natural (placed between letter and octave)

### Chords
\`C4E4G4k\` = C-E-G quarter chord (multiple pitches, single duration char at end)

## CRITICAL CONSTRAINT: Measure duration

**Each measure between \`,\` barriers MUST total exactly ${expectedMeasureDur}u.**
Exception: the first measure may be a pickup (anacrusis) with fewer units.

Before outputting any modified measure, verify the sum:
  Example: \`C4k E4k G4j A4j B4l\` = ${u(4)}+${u(4)}+${u(8)}+${u(8)}+${u(2)} = ${u(4) + u(4) + u(8) + u(8) + u(2)}u

If you change a note's pitch, keep its duration. If you change a note's rhythm,
adjust other notes so the measure still sums to ${expectedMeasureDur}u.
**If you cannot make a measure sum correctly, keep the original unchanged.**

## Format rules
- Notes within a measure: separated by SPACES only
- Do NOT place \`|\` between notes inside a measure
- \`,\` is the sole measure barrier
- Preserve the exact number of \`,\` barriers (= number of measures)
- Preserve the part label exactly (\`[1]|\`, \`[2]|\`, etc.)
- End with \`,,, |\` if the original does

## Your task
1. Compare the draft part against the score images
2. Fix wrong pitches, rhythms, missing/extra notes, wrong accidentals
3. **Verify** every modified measure sums to ${expectedMeasureDur}u
4. If a measure looks correct, keep it EXACTLY as-is (do not reformat)
5. If unsure, keep the original — do not guess
6. Output ONLY the corrected part line in a \`\`\`hide code block`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildReviewUserContent(input: {
  headerLine: string;
  partIndex: number;
  partSource: string;
  totalParts: number;
  base64Pages: Array<{ base64: string; mediaType: 'image/png' }>;
  warnings: string[];
  expectedMeasureDur: number;
  div: number;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
}): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content: any[] = [];

  // 1. Page images
  for (let i = 0; i < input.base64Pages.length; i++) {
    const page = input.base64Pages[i];
    content.push({
      type: 'text' as const,
      text: `[Score page ${i + 1}/${input.base64Pages.length}]`,
    });
    content.push({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: page.mediaType as 'image/png',
        data: page.base64,
      },
    });
  }

  // 2. Draft + instructions
  const warningText = input.warnings.length > 0
    ? `\n\nOMR warnings:\n${input.warnings.map(w => `- ${w}`).join('\n')}`
    : '';

  content.push({
    type: 'text' as const,
    text: `## Header
\`${input.headerLine}\`

## Draft part ${input.partIndex + 1} of ${input.totalParts}

\`\`\`hide
${input.partSource}
\`\`\`
${warningText}

Compare part ${input.partIndex + 1} (staff ${input.partIndex + 1} from the top in each system) against the score images.
Each measure must sum to exactly **${input.expectedMeasureDur}u** (DIV:${input.div}).
Output the corrected part in a \`\`\`hide code block.`,
  });

  return content;
}

// ============================================================
// 内部: LLM 応答パース
// ============================================================

function extractHideBlock(response: string, fallback: string): string {
  // ```hide ... ``` ブロックを抽出
  const match = response.match(/```hide\s*\n([\s\S]*?)```/);
  if (match) {
    const extracted = match[1].trim();
    if (extracted.startsWith('[') && extracted.includes(',')) {
      return extracted;
    }
  }

  // ``` ... ``` (言語指定なし) も試す
  const genericMatch = response.match(/```\s*\n([\s\S]*?)```/);
  if (genericMatch) {
    const extracted = genericMatch[1].trim();
    if (extracted.startsWith('[') && extracted.includes(',')) {
      return extracted;
    }
  }

  // 抽出できなければ fallback
  return fallback;
}

// ============================================================
// 内部: Duration 計算
// ============================================================

/** duration char → whole note に対する分割数 */
const DUR_DIVISORS: Record<string, number> = {
  m: 1, l: 2, k: 4, j: 8, i: 16, h: 32,
};

/** 単一トークン (ノート/レスト/タイ) の duration を返す */
function tokenDuration(token: string, div: number): number {
  // タイ: 各要素の合計
  if (token.includes('+')) {
    return token.split('+').reduce((s, t) => s + tokenDuration(t, div), 0);
  }
  // duration char + optional dots を末尾から抽出
  const m = token.match(/([hijklm])(\.{0,2})$/);
  if (!m) return 0;
  const base = div / DUR_DIVISORS[m[1]];
  if (m[2] === '..') return base * 1.75;
  if (m[2] === '.') return base * 1.5;
  return base;
}

/** 小節文字列 (| やスペースを含む) の合計 duration */
function calcMeasureDuration(measureStr: string, div: number): number {
  const cleaned = measureStr.replace(/\|/g, ' ').trim();
  if (!cleaned) return 0;
  const tokens = cleaned.split(/\s+/).filter(t => t.length > 0);
  return tokens.reduce((sum, t) => sum + tokenDuration(t, div), 0);
}

// ============================================================
// 内部: パート小節分割・結合
// ============================================================

interface PartParsed {
  label: string;        // e.g. "[1]|"
  measures: string[];   // 各小節の内容 (| は除去済)
  hasFinale: boolean;   // ,,, で終わるか
}

function splitPartMeasures(partLine: string): PartParsed {
  // ラベル抽出: [1]| or [P]|
  const labelMatch = partLine.match(/^(\[[^\]]+\]\|?)\s*/);
  const label = labelMatch ? labelMatch[1] : '';
  let body = partLine.slice(label.length).trim();

  // ,,, 終端を検出・除去
  const hasFinale = /,,,/.test(body);
  if (hasFinale) {
    body = body.replace(/,,,\s*\|?\s*$/, '');
  }

  // 末尾の | やスペースを除去
  body = body.replace(/\s*\|?\s*$/, '');

  // , で分割し、各小節から | を除去
  const raw = body.split(',');
  const measures = raw.map(m =>
    m.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim(),
  );

  return { label, measures, hasFinale };
}

function rejoinPart(label: string, measures: string[], hasFinale: boolean): string {
  const body = measures.join(' , ');
  const finale = hasFinale ? ' ,,, |' : '';
  return `${label} ${body}${finale}`;
}

// ============================================================
// 内部: バリデーション + フォールバック
// ============================================================

function validateAndFixPart(
  llmPart: string,
  draftPart: string,
  div: number,
  expectedDur: number,
): { fixed: string; fallbackCount: number } {
  const llm = splitPartMeasures(llmPart);
  const draft = splitPartMeasures(draftPart);

  // LLM が非空小節の 50% 以上を空にした → パート全体を draft に戻す
  const llmNonEmpty = llm.measures.filter(m => m).length;
  const draftNonEmpty = draft.measures.filter(m => m).length;
  if (draftNonEmpty > 2 && llmNonEmpty < draftNonEmpty * 0.5) {
    return { fixed: normalizePart(draftPart), fallbackCount: draftNonEmpty };
  }

  const fixedMeasures: string[] = [];
  let fallbackCount = 0;
  const len = Math.max(llm.measures.length, draft.measures.length);

  // fractional unit の許容誤差 (DIV:48 での h=1.5u 等)
  const tolerance = 0.5;

  for (let i = 0; i < len; i++) {
    const llmM = llm.measures[i] ?? '';
    const draftM = draft.measures[i] ?? '';

    // 最初の小節: pickup (アウフタクト) の可能性 → duration チェックしない
    if (i === 0) {
      fixedMeasures.push(llmM || draftM);
      continue;
    }

    // 両方空 → 空のまま
    if (!llmM && !draftM) {
      fixedMeasures.push('');
      continue;
    }

    // LLM が非空小節を空にした → draft に戻す
    if (!llmM && draftM) {
      fixedMeasures.push(draftM);
      fallbackCount++;
      continue;
    }

    // Duration チェック
    const llmDur = calcMeasureDuration(llmM, div);
    if (Math.abs(llmDur - expectedDur) > tolerance) {
      // LLM の duration が不正
      const draftDur = calcMeasureDuration(draftM, div);
      if (Math.abs(draftDur - expectedDur) <= tolerance) {
        // draft は正しい → draft に戻す
        fixedMeasures.push(draftM);
        fallbackCount++;
      } else {
        // 両方不正 → LLM を採用 (ピッチ修正が含まれている可能性)
        fixedMeasures.push(llmM);
      }
    } else {
      // LLM の duration は正しい → 採用
      fixedMeasures.push(llmM);
    }
  }

  const useLabel = llm.label || draft.label;
  const useFinale = llm.hasFinale || draft.hasFinale;
  const fixed = rejoinPart(useLabel, fixedMeasures, useFinale);
  return { fixed, fallbackCount };
}

// ============================================================
// 内部: フォーマット正規化
// ============================================================

/** パート行を parse → rejoin して一貫したフォーマットにする */
function normalizePart(partLine: string): string {
  const parsed = splitPartMeasures(partLine);
  return rejoinPart(parsed.label, parsed.measures, parsed.hasFinale);
}

/** 比較用: | とスペースの差異を無視 */
function normalizeForCompare(part: string): string {
  return part.replace(/\|/g, '').replace(/\s+/g, ' ').trim();
}
