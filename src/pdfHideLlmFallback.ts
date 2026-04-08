/**
 * pdfHideLlmFallback.ts — PDF→.hide pipeline Phase 4: 低信頼セルの LLM 補完
 *
 * Phase 3 (`pdfHideAssemble.ts`) が emit した低信頼セル
 * (`PdfHideLowConfidenceCellId[]`) を、ページ画像を source-of-truth として LLM に
 * 「該当セルだけ修正」させるための prompt builder + apply layer。
 *
 * 設計方針 (Plan H 適材適所 hybrid + 100% 優先):
 *  - **fix-only モード**: 全曲 OMR をやり直すのではなく、Phase 3 が作った draft を
 *    LLM に渡して、`;low-confidence:<cellId>` / `;mid-confidence:<cellId>` /
 *    `;unknown:<cellId>` マークが付いたセルだけを画像と照合して修正させる。
 *  - **silent fill 禁止**: 画像で確信を持てないセルは LLM が `;still-uncertain:<cellId>`
 *    マークを残し、apply 層で `unresolved` 項目として surface する。consumer は
 *    残った曖昧セルを diagnostic として hide studio に渡す。
 *  - **per-cell override 抽出**: apply 層は LLM の `\`\`\`hide` 出力を line-by-line に
 *    走査し、各セル行 (`| <tokens> ;<level>:<cellId>`) を `cellOverrides` Map に
 *    積む。consumer は draft の対応セルを上書きする。
 *  - **Anthropic wire format**: `userContent` の `image` block は `media_type` snake_case
 *    で出す。`messages[0].content` にそのまま投入できる。
 *  - **画像 first**: Phase 4 は「画像を見て修正」がメインタスクなので、画像 → 説明 →
 *    draft → 修正対象リスト → 指示 の順で並べる。`pdfHideMeta.ts` (画像 first) と
 *    同じレイアウト方針。
 *  - **LLM 呼び出しは行わない**: pure prompt builder + pure parser。consumer が
 *    `Promise.all(pages.map(p => callLlm(prompt(p))))` で並列実行する。
 *
 * スコープ外:
 *  - LLM 呼び出しそのもの
 *  - draft への override 反映 (consumer 側、`mergeFallback` 的な責務は別レイヤー)
 *  - 多ラウンド reviewLoop (Phase 4 は 1 ラウンドで打ち切る方針)
 *
 * 依存: 他モジュール一切なし (`pdfHideAssemble.ts` の型に **構造的に互換** な
 * ID 文字列だけを扱うため、import せずに済ませる)。テストしやすさと
 * 循環依存回避のための意図的な切り分け。
 */

// ============================================================
// 公開型: 入力
// ============================================================

/**
 * 1 ページ画像。`mediaType` はカメルケース (内部入力フォーマット)。
 * Anthropic wire format (`media_type` snake_case) 変換は
 * `interleaveSectionsAndImage` の責務。
 */
export interface PdfHideFallbackImage {
  /** Base64 エンコードされた画像データ (`data:` プレフィックス無し) */
  base64: string;
  /** MIME タイプ */
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** 1-based ページ番号 (任意、グラウンディング用) */
  pageNumber?: number;
  /** ページラベル (任意、例: "page 1") */
  label?: string;
}

/**
 * Anthropic API 風 multimodal content block.
 * `messages[0].content` にそのまま投入できる形。
 */
export type PdfHideFallbackContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    };

/**
 * Phase 1 で取得済みの楽曲メタ (任意、prompt のグラウンディング用)。
 * `pdfHideMeta.ts` の `PdfHideScoreContext` の subset を構造的に受け入れる
 * (型 import を避けて疎結合にしている)。
 */
export interface PdfHideFallbackContext {
  /** 例: 'TREBLE' */
  clef?: string;
  /** 例: { numerator: 4, denominator: 4 } */
  timeSignature?: { numerator: number; denominator: number };
  /** -7..+7 */
  keyFifths?: number;
  /** ヘッダー DIV. default 32 */
  div?: number;
  /** タイトル (任意) */
  title?: string;
  /** 作曲者 (任意) */
  composer?: string;
}

/**
 * Phase 3 から渡される 1 つの低信頼セル参照。
 *
 * `pdfHideAssemble.ts` の `PdfHideLowConfidenceCellId` と構造的に互換にしたい
 * フィールドだけを持つ。あえて import せず、文字列 ID ベースの最小契約にして
 * Phase 4 が他モジュールに依存しないようにしている。
 */
export interface PdfHideLowConfidenceCellRef {
  /** Phase 3 が生成した cellId (例: "p0s0i1m2", "missing-part0-m3") */
  cellId: string;
  /** part label (例: "1", "2", "P") */
  partLabel: string;
  /** 全パート串通しでの 0-indexed measure 番号 */
  globalMeasureIndex: number;
  /** Phase 3 が割り振った信頼度 ('mid' | 'low' | 'unknown') */
  confidence: 'mid' | 'low' | 'unknown';
  /** 任意の理由文 (Phase 3 の reason / `noteheadCount` などを文字列化) */
  reason?: string;
}

/** prompt 構築の入力 */
export interface PdfHideLlmFallbackInput {
  /**
   * 修正対象ページの画像 1 枚。
   * 複数ページを 1 call に詰めると LLM が混乱しやすいので、Phase 4 は
   * **per-page prompt** が前提。consumer が `Promise.all` で並列実行する。
   */
  pageImage: PdfHideFallbackImage;
  /**
   * Phase 3 が emit した、このページの draft `.hide` ソース部分文字列.
   * `[CLEF:...]` ヘッダー + `[N]` part switch + 各 cell 行 (1 cell = 1 行)
   * を含む。低信頼セル行には `;<level>:<cellId>` マーカーが付いている。
   *
   * Phase 3 全体の hideSource からこのページ分だけを切り出すのは consumer 責務。
   */
  draftHideSourceForPage: string;
  /**
   * このページに属する低信頼セルのリスト。
   * apply 層が LLM 応答から override を抽出する際、ここに無い cellId は warning。
   */
  lowConfidenceCells: PdfHideLowConfidenceCellRef[];
  /** 任意: Phase 1 で取得済みの楽曲メタ (clef/time/key 等を prompt に乗せる) */
  context?: PdfHideFallbackContext;
  /**
   * 任意: タスク固有の追加指示
   * (例: "voice 1-2 だけ修正", "8 小節 4 拍目の和音は判別不能なら UNRESOLVED に残す")
   */
  additionalInstructions?: string;
}

// ============================================================
// 公開型: prompt
// ============================================================

/** 集計情報 (UI / ログ向け) */
export interface PdfHideLlmFallbackSummary {
  /** ページ番号 (1-based、未指定なら undefined) */
  pageNumber?: number;
  /** 修正対象セル数 */
  lowConfidenceCellCount: number;
  /** context が指定されたか */
  hasContext: boolean;
  /** additionalInstructions が指定されたか */
  hasAdditionalInstructions: boolean;
}

/** prompt 構築結果 */
export interface PdfHideLlmFallbackPrompt {
  /** Provider-agnostic system instruction */
  systemPrompt: string;
  /** Anthropic 風 user message content (drop directly into `messages[0].content`) */
  userContent: PdfHideFallbackContentBlock[];
  /** テキストのみのフラット表現 (非マルチモーダル / デバッグログ用) */
  textOnlyPrompt: string;
  /** UI / ログ向け集計 */
  summary: PdfHideLlmFallbackSummary;
}

// ============================================================
// 公開型: apply
// ============================================================

/** apply 層への入力 */
export interface PdfHideLlmFallbackApplyInput {
  /** LLM 応答テキスト (生) */
  llmResponse: string;
  /**
   * 任意: 期待される cellId のリスト。
   * 指定すると、ここに含まれない cellId を override に持つ行は warning に格下げ
   * (= consumer に「LLM が予期せぬ cellId を出力した」ことを surface する)。
   * 通常は input.lowConfidenceCells.map(c => c.cellId) を渡す。
   */
  expectedCellIds?: string[];
}

/** 1 セル分の override 情報 */
export interface PdfHideFallbackCellOverride {
  /** Phase 3 由来の cellId */
  cellId: string;
  /**
   * 修正後トークン文字列 (`|` を除いた token 部のみ).
   * 例: "C4k D4k E4k F4k", "F#4k Bn3k Bb3k Rk"
   */
  tokens: string;
  /**
   * 行末コメント全体 (`;` 込み).
   * 例: ";corrected:p0s0i1m2", ";still-uncertain:p0s0i1m2 octave-ambiguous"
   */
  comment: string;
  /**
   * LLM が「これでも修正しきれなかった」と明示しているか.
   * `still-uncertain` / `unresolved` / `unknown` を comment に含むと true。
   * 当該セルは consumer 側で diagnostic に格上げするべき。
   */
  stillUncertain: boolean;
}

/** UNRESOLVED ブロックから抽出した 1 項目 */
export interface PdfHideFallbackUnresolvedItem {
  /** Bullet prefix を除去した本文 */
  text: string;
  /** 1-based の出現順序 */
  index: number;
}

/** apply 層の結果 */
export interface PdfHideLlmFallbackApplyResult {
  /** ` ```hide``` ` フェンスブロックが少なくとも 1 つ見つかったか */
  hideBlockFound: boolean;
  /** 見つかったブロック数 (>1 のとき warning) */
  hideBlockCount: number;
  /**
   * 抽出された `.hide` ソース文字列 (最初のブロックを採用、デバッグ用).
   * ブロックが無ければ undefined。
   */
  hideSource?: string;
  /** cellId → override の配列。consumer が draft に反映する */
  cellOverrides: PdfHideFallbackCellOverride[];
  /** UNRESOLVED 項目 (LLM が修正しきれなかった分の自由記述) */
  unresolved: PdfHideFallbackUnresolvedItem[];
  /** apply 層自身が検出した警告 (応答 shape の問題、unexpected cellId など) */
  warnings: string[];
}

// ============================================================
// 公開API: prompt builder
// ============================================================

/**
 * 低信頼セル + ページ画像 + draft hideSource から Phase 4 LLM 補完用プロンプトを構築する。
 *
 * @example
 *   // consumer は Phase 3 の lowConfidenceCells をページごとに分けてループする
 *   const cellsByPage = groupBy(draft.lowConfidenceCells, c => c.pageIndex);
 *   const fallbackResults = await Promise.all(
 *     Object.entries(cellsByPage).map(async ([pageIdxStr, cells]) => {
 *       const pageIdx = Number(pageIdxStr);
 *       const prompt = buildPdfHideLlmFallbackPrompt({
 *         pageImage: pageImages[pageIdx],
 *         draftHideSourceForPage: extractPageHideSource(draft, pageIdx),
 *         lowConfidenceCells: cells.map(c => ({
 *           cellId: `p${c.pageIndex}s${c.systemIndex}i${c.staffIndex}m${c.measureIndex}`,
 *           partLabel: c.partLabel,
 *           globalMeasureIndex: c.globalMeasureIndex,
 *           confidence: c.confidence === 'high' ? 'mid' : c.confidence,
 *         })),
 *         context: {
 *           clef: meta.context.clefsPerStaff[0],
 *           timeSignature: meta.context.initialTimeSignature,
 *           keyFifths: meta.context.initialKeyFifths,
 *         },
 *       });
 *       const resp = await anthropic.messages.create({
 *         model: 'claude-opus-4-6',
 *         max_tokens: 4096,
 *         system: prompt.systemPrompt,
 *         messages: [{ role: 'user', content: prompt.userContent }],
 *       });
 *       return applyPdfHideLlmFallbackResponse({
 *         llmResponse: resp.content[0].text,
 *         expectedCellIds: cells.map(c => `p${c.pageIndex}...`),
 *       });
 *     }),
 *   );
 */
export function buildPdfHideLlmFallbackPrompt(
  input: PdfHideLlmFallbackInput,
): PdfHideLlmFallbackPrompt {
  const lowConfidenceCells = input.lowConfidenceCells ?? [];

  const systemPrompt = buildSystemPrompt();
  const sections = buildUserSections(input, lowConfidenceCells);
  const userContent = interleaveSectionsAndImage(sections, input.pageImage);
  const textOnlyPrompt = buildTextOnlyPrompt(sections, input.pageImage);

  const summary: PdfHideLlmFallbackSummary = {
    pageNumber: input.pageImage.pageNumber,
    lowConfidenceCellCount: lowConfidenceCells.length,
    hasContext: input.context !== undefined,
    hasAdditionalInstructions:
      input.additionalInstructions !== undefined &&
      input.additionalInstructions.trim() !== '',
  };

  return { systemPrompt, userContent, textOnlyPrompt, summary };
}

// ============================================================
// 公開API: apply layer
// ============================================================

/**
 * Phase 4 LLM 応答を解析して、cellId 単位の override + UNRESOLVED 項目を取り出す。
 *
 * @example
 *   const result = applyPdfHideLlmFallbackResponse({
 *     llmResponse: msg.content[0].text,
 *     expectedCellIds: input.lowConfidenceCells.map(c => c.cellId),
 *   });
 *   for (const ov of result.cellOverrides) {
 *     if (!ov.stillUncertain) {
 *       // consumer: draft の該当セルを ov.tokens で上書き
 *     }
 *   }
 *   // result.unresolved + stillUncertain 項目は最終 diagnostic として hide studio へ
 */
export function applyPdfHideLlmFallbackResponse(
  input: PdfHideLlmFallbackApplyInput,
): PdfHideLlmFallbackApplyResult {
  const warnings: string[] = [];

  // 1. ```hide``` フェンスブロック抽出
  const hideBlocks = extractHideBlocks(input.llmResponse);
  if (hideBlocks.length === 0) {
    warnings.push('LLM 応答に ```hide``` フェンスブロックが見つかりませんでした');
  } else if (hideBlocks.length > 1) {
    warnings.push(
      'LLM 応答に ```hide``` フェンスブロックが ' +
        hideBlocks.length +
        ' 個あります — 最初のものを採用しました',
    );
  }
  const hideSource = hideBlocks.length > 0 ? hideBlocks[0] : undefined;

  // 2. cell override 抽出 (フェンスブロック内を line-by-line にスキャン)
  const expected = input.expectedCellIds
    ? new Set(input.expectedCellIds)
    : undefined;
  const cellOverrides = hideSource
    ? extractCellOverrides(hideSource, expected, warnings)
    : [];

  // 3. UNRESOLVED 抽出 (応答全体から、最初の hide ブロックの後ろを優先的に見る)
  const unresolved = extractUnresolvedItems(input.llmResponse);

  return {
    hideBlockFound: hideBlocks.length > 0,
    hideBlockCount: hideBlocks.length,
    hideSource,
    cellOverrides,
    unresolved,
    warnings,
  };
}

// ============================================================
// 内部: system prompt
// ============================================================

function buildSystemPrompt(): string {
  return `あなたはアカペラ楽譜の OMR (Optical Music Recognition) **修正専任** エンジニアです。古典的な画像処理ベースの OMR が読み取った draft \`.hide\` ソースの中で、信頼度が低かったセルだけを **画像と照合して修正** することがあなたの責務です。

**重要な前提**:
  - **画像こそが真の source-of-truth** です。draft が何と書いていようと、画像と異なる記譜は決して書かないでください。
  - **silent fill (推測で休符や音符を埋める) は厳禁** です。画像で確信を持てないセルは \`;still-uncertain:<cellId>\` マーカーを残してください。修正不能なまま \`;corrected:\` を付けるのは禁止です。
  - **draft 全体を再生成しない** でください。あなたのタスクは「マーカー付きセルだけ修正」であって、高信頼セル (マーカーが付いていないセル) には触らないでください。
  - **cellId は変更しない** でください。修正前後で同じ cellId 文字列を保ってください。これが consumer 側の merge ロジックの鍵になります。
  - **行構造を保つ** こと: 1 cell = 1 行 (\`| <tokens> ;<status>:<cellId> [reason]\` 形式)。複数 cell を 1 行に詰めないでください。

入力 (この順序で渡されます):
  1. **修正対象ページの楽譜画像** — 1 ページ分、これが OMR 対象です
  2. (任意) 楽曲メタ情報 — clef / time / key 等のグラウンディング
  3. **古典 OMR の draft \`.hide\` ソース** (このページ分) — マーカー付きセルが含まれる
  4. **修正対象セルのリスト** — cellId と理由
  5. (任意) 追加指示
  6. 出力指示

\`.hide\` 構文の最小チートシート (修正に使う部分のみ):
  - ヘッダー: \`[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]\` (CLEF/TIME/KEY/DIV のみ)
  - 音符: \`<音名><臨時記号?><オクターブ><長さ文字>\`
    例: \`C4k\` (4分C4)、\`F#5l\` (半音F#5)、\`Bb3m\` (全音Bb3)、\`Cn5k\` (ナチュラルC5)
  - 長さ文字: h=32分 / i=16分 / j=8分 / k=4分 / l=2分 / m=全音
  - 休符: \`R<長さ文字>\` (例: \`Rk\` = 4分休符)
  - 和音: ピッチを連結してから 1 つの長さ文字 — \`C4E4G4m\` (Cメジャー全音符)
  - タイ: トークン直後に \`+\` — \`C4l+ C4l\` (タイで結ばれた半音符 2 つ = 全音符相当)
  - パートラベル: \`[1]\` \`[2]\` ... (上声→下声)、\`[P]\` = ボイスパーカッション
  - 小節区切り: 各 cell 行は \`|\` で開始
  - コメント: \`;\` 以降は行末まで無視 (= cellId マーカーは行末に置く)

出力フォーマット (厳守):
  1. 最初に **数行の状況サマリ** (例: "12 セル中 10 セルを修正、2 セルは画像不鮮明で UNRESOLVED")
  2. 次に修正後の \`.hide\` ソース全体 (このページ分) を 1 つの \`\`\`hide ... \`\`\` ブロックで
     - **draft の全行を返してください** (高信頼セル含めて、行構造を保ったまま)
     - マーカー付き行のトークン部分だけ修正し、cellId は維持
     - 修正済み: \`;corrected:<cellId>\` (理由を残したい場合は同じ行のコメント末尾に書く)
     - 修正不能: \`;still-uncertain:<cellId> <短い理由>\` (これは silent fill 回避のために必須)
  3. **画像で確認できなかった項目** があれば最後に \`UNRESOLVED:\` セクションを追加し、各項目を 1 行で記述

修正が 1 件もできないとき (画像が不鮮明 / そもそも該当範囲が描かれていない) は、その旨を最初の数行に明記し、対象セルすべてに \`;still-uncertain:\` を付けて返してください。**推測で埋めないこと**。`;
}

// ============================================================
// 内部: user content sections
// ============================================================

interface UserSection {
  /** Section identifier (for testing / debug) */
  id: string;
  text: string;
}

function buildUserSections(
  input: PdfHideLlmFallbackInput,
  lowConfidenceCells: PdfHideLowConfidenceCellRef[],
): UserSection[] {
  const sections: UserSection[] = [];

  // 0. images intro section (caption-like text right BEFORE the image block)
  //    actual image is interleaved by `interleaveSectionsAndImage` after this section.
  sections.push({
    id: 'imageIntro',
    text: buildImageIntroSection(input.pageImage),
  });

  // 1. context section (任意, image の後に来る)
  if (input.context !== undefined) {
    sections.push({
      id: 'context',
      text: formatContextSection(input.context),
    });
  }

  // 2. draft hide source section
  sections.push({
    id: 'draft',
    text: formatDraftSection(input.draftHideSourceForPage),
  });

  // 3. low-confidence cells list
  sections.push({
    id: 'lowConfidenceCells',
    text: formatLowConfidenceCellsSection(lowConfidenceCells),
  });

  // 4. additional instructions (if any)
  if (
    input.additionalInstructions !== undefined &&
    input.additionalInstructions.trim() !== ''
  ) {
    sections.push({
      id: 'additionalInstructions',
      text: '## 追加指示\n\n' + input.additionalInstructions.trim(),
    });
  }

  // 5. instruction footer (always present)
  sections.push({
    id: 'instruction',
    text: buildInstructionFooter(lowConfidenceCells.length),
  });

  return sections;
}

function buildImageIntroSection(image: PdfHideFallbackImage): string {
  const labelParts: string[] = [];
  if (image.pageNumber !== undefined) labelParts.push(`page ${image.pageNumber}`);
  if (image.label) labelParts.push(image.label);
  const labelText = labelParts.length > 0 ? ` (${labelParts.join(' — ')})` : '';
  return `## 修正対象ページ画像${labelText}\n\n以下にこのページの楽譜画像を示します。**この画像こそが真の source-of-truth** です。`;
}

function formatContextSection(ctx: PdfHideFallbackContext): string {
  const lines: string[] = ['## 楽曲メタ情報 (グラウンディング用)'];
  if (ctx.title) lines.push(`- タイトル: ${ctx.title}`);
  if (ctx.composer) lines.push(`- 作曲者: ${ctx.composer}`);
  if (ctx.clef) lines.push(`- 音部記号: ${ctx.clef}`);
  if (ctx.timeSignature) {
    lines.push(
      `- 拍子: ${ctx.timeSignature.numerator}/${ctx.timeSignature.denominator}`,
    );
  }
  if (typeof ctx.keyFifths === 'number') {
    lines.push(`- 調号 (fifths): ${ctx.keyFifths >= 0 ? '+' : ''}${ctx.keyFifths}`);
  }
  if (typeof ctx.div === 'number') {
    lines.push(`- DIV: ${ctx.div}`);
  }
  if (lines.length === 1) {
    // contextが空オブジェクトのとき
    lines.push('(メタ情報なし)');
  }
  return lines.join('\n');
}

function formatDraftSection(draftHideSourceForPage: string): string {
  const trimmed = draftHideSourceForPage.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return [
    '## 古典 OMR の draft `.hide` ソース (このページ分)',
    '',
    '以下は古典 OMR が読み取った draft です。`;low-confidence:<cellId>` / `;mid-confidence:<cellId>` / `;unknown:<cellId>` のマーカーが付いた行が **あなたが修正すべきセル** です。マーカーが付いていない行は高信頼で確定済みなので **絶対に変更しないでください**。',
    '',
    '```hide',
    trimmed,
    '```',
  ].join('\n');
}

function formatLowConfidenceCellsSection(
  cells: PdfHideLowConfidenceCellRef[],
): string {
  if (cells.length === 0) {
    return '## 修正対象セル\n\n**(修正対象なし — このページに低信頼セルはありません)**';
  }
  const lines: string[] = ['## 修正対象セル'];
  lines.push('');
  lines.push(
    `以下の ${cells.length} 個のセルが修正対象です。それぞれ画像と照合し、 \`;corrected:<cellId>\` または \`;still-uncertain:<cellId>\` をマーカーとして付けて返してください。`,
  );
  lines.push('');
  for (const c of cells) {
    const reasonText = c.reason ? ` — ${c.reason}` : '';
    lines.push(
      `- \`${c.cellId}\` (part [${c.partLabel}], measure ${c.globalMeasureIndex + 1}, confidence=${c.confidence})${reasonText}`,
    );
  }
  return lines.join('\n');
}

function buildInstructionFooter(lowConfidenceCellCount: number): string {
  const cellNote =
    lowConfidenceCellCount > 0
      ? `${lowConfidenceCellCount} 個の低信頼セルを画像と慎重に照合し、修正してください。`
      : '修正対象セルはありませんが、念のため画像と draft を照合し、矛盾があれば UNRESOLVED に列挙してください。';
  return `## 指示\n\n${cellNote}\n\nシステムプロンプトの出力フォーマット (状況サマリ → \`\`\`hide\`\`\` ブロック → UNRESOLVED) に従って回答してください。**推測で埋めず**、確認できなかったセルは \`;still-uncertain:<cellId>\` マーカーで残してください。draft の **全行** (高信頼セル含む) を返し、修正対象セルのトークン部だけを差し替えてください。cellId は変更しないでください。`;
}

// ============================================================
// 内部: image / section interleaving (画像 first レイアウト)
// ============================================================

/**
 * セクション群とページ画像 1 枚を 1 本の content block 列に組み立てる。
 *
 * 戦略 (`pdfHideMeta.ts` と同じ「画像 first」方針):
 *   - imageIntro section の直後に画像を差し込む
 *   - その後ろに context → draft → low-conf cells → instruction を並べる
 *   - imageIntro section が無い fallback パスでは text 全部出してから画像を最後に
 */
function interleaveSectionsAndImage(
  sections: UserSection[],
  image: PdfHideFallbackImage,
): PdfHideFallbackContentBlock[] {
  const blocks: PdfHideFallbackContentBlock[] = [];

  const introIdx = sections.findIndex((s) => s.id === 'imageIntro');

  if (introIdx === -1) {
    for (const section of sections) {
      blocks.push({ type: 'text', text: section.text });
    }
    pushImageBlock(blocks, image);
    return blocks;
  }

  // imageIntro まで (imageIntro 含む) を出力
  for (let i = 0; i <= introIdx; i++) {
    blocks.push({ type: 'text', text: sections[i].text });
  }
  // 画像を出力
  pushImageBlock(blocks, image);
  // 残りのセクションを出力
  for (let i = introIdx + 1; i < sections.length; i++) {
    blocks.push({ type: 'text', text: sections[i].text });
  }
  return blocks;
}

function pushImageBlock(
  blocks: PdfHideFallbackContentBlock[],
  image: PdfHideFallbackImage,
): void {
  blocks.push({
    type: 'image',
    source: {
      type: 'base64',
      media_type: image.mediaType,
      data: image.base64,
    },
  });
}

// ============================================================
// 内部: text-only fallback
// ============================================================

function buildTextOnlyPrompt(
  sections: UserSection[],
  image: PdfHideFallbackImage,
): string {
  const introIdx = sections.findIndex((s) => s.id === 'imageIntro');
  const parts: string[] = [];

  const labelParts: string[] = [];
  if (image.pageNumber !== undefined) labelParts.push(`page ${image.pageNumber}`);
  if (image.label) labelParts.push(image.label);
  const labelText = labelParts.length > 0 ? labelParts.join(' — ') : 'page image';
  const placeholder = `[image: ${labelText}]`;

  if (introIdx === -1) {
    for (const s of sections) parts.push(s.text);
    parts.push(placeholder);
    return parts.join('\n\n');
  }

  for (let i = 0; i <= introIdx; i++) parts.push(sections[i].text);
  parts.push(placeholder);
  for (let i = introIdx + 1; i < sections.length; i++) parts.push(sections[i].text);
  return parts.join('\n\n');
}

// ============================================================
// 内部: hide ブロック抽出
// ============================================================

/**
 * 応答から ```hide ... ``` を全て抽出する.
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
function extractHideBlocks(response: string): string[] {
  const blocks: string[] = [];
  const re = /```[ \t]*hide[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(response)) !== null) {
    blocks.push(m[1]!);
  }
  return blocks;
}

// ============================================================
// 内部: cell override 抽出
// ============================================================

/**
 * `;<word>:<cellId>` パターンを cell 行から検出するためのインライン正規表現.
 * cellId は word 文字 (`p0s0i1m2` や `missing-part0-m3` 等) を許容するため
 * `[\w-]+` で受ける。`;` の前後の whitespace は許容。
 */
const CELL_MARKER_RE = /;[ \t]*([\w-]+)[ \t]*:[ \t]*([\w-]+)/;

/**
 * `still-uncertain` 系のキーワードを含む comment かを判定する.
 * LLM が `;still-uncertain:`, `;unresolved:`, `;unknown:` のいずれかを使った場合、
 * apply 層は consumer に「これでも修正しきれなかった」ことを surface する。
 *
 * `mid-confidence` / `low-confidence` は Phase 3 の draft マーカーがそのまま LLM
 * 応答に残った可能性 (= LLM が触らずに返した) を意味するが、これも consumer 視点
 * では「修正できていない」のと同じなので stillUncertain 扱いとする。
 */
function isStillUncertainComment(commentText: string): boolean {
  const lower = commentText.toLowerCase();
  return (
    lower.includes('still-uncertain') ||
    lower.includes('still uncertain') ||
    lower.includes('unresolved') ||
    lower.includes('unknown') ||
    lower.includes('low-confidence') ||
    lower.includes('mid-confidence')
  );
}

/**
 * hide ブロック内を line-by-line にスキャンし、`| <tokens> ;<word>:<cellId>` 形式の
 * cell 行から override 情報を抽出する。
 *
 * - 同じ cellId が複数行に現れたら最初のものを採用、2 件目以降は warning
 * - expected が指定されていて含まれない cellId は warning
 * - cellId 無しの行 (高信頼セル / part switch / header) はスキップ
 */
function extractCellOverrides(
  hideBlock: string,
  expected: Set<string> | undefined,
  warnings: string[],
): PdfHideFallbackCellOverride[] {
  const overrides: PdfHideFallbackCellOverride[] = [];
  const seen = new Set<string>();
  const lines = hideBlock.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    // cell 行は `|` (任意の前置 whitespace 込み) で始まる
    const m = /^\s*\|\s*(.*)$/.exec(line);
    if (!m) continue;
    const afterPipe = m[1] ?? '';

    // `;` の最初の出現位置で tokens / comment を分離
    const semiIdx = afterPipe.indexOf(';');
    if (semiIdx === -1) continue; // cellId 無しの cell 行 (高信頼) → スキップ
    const tokens = afterPipe.slice(0, semiIdx).trim();
    const comment = afterPipe.slice(semiIdx).trim(); // `;` 込み

    const markerMatch = CELL_MARKER_RE.exec(comment);
    if (!markerMatch) continue; // cellId なしの comment は無視
    const cellId = markerMatch[2]!;

    if (expected !== undefined && !expected.has(cellId)) {
      warnings.push(
        `LLM 応答に予期せぬ cellId が含まれていました: '${cellId}' — override に採用しません`,
      );
      continue;
    }
    if (seen.has(cellId)) {
      warnings.push(
        `LLM 応答に cellId '${cellId}' が複数回出現しました — 最初のものを採用しました`,
      );
      continue;
    }
    seen.add(cellId);

    overrides.push({
      cellId,
      tokens,
      comment,
      stillUncertain: isStillUncertainComment(comment),
    });
  }

  // expected で指定されたが override に含まれなかった cellId を warning
  if (expected !== undefined) {
    for (const id of expected) {
      if (!seen.has(id)) {
        warnings.push(
          `期待されていた cellId '${id}' が LLM 応答に含まれていません`,
        );
      }
    }
  }

  return overrides;
}

// ============================================================
// 内部: UNRESOLVED 抽出
// ============================================================

/**
 * 応答から UNRESOLVED 項目を抽出する.
 *
 * 検索範囲:
 *   - 最初の ```hide``` ブロックの **後** のテキストだけを見る
 *     (ブロック内の "UNRESOLVED" コメントを誤検出しないため)
 *   - ブロックがない場合は応答全体を見る
 *
 * パース仕様:
 *   - `^UNRESOLVED` で始まる行をヘッダーとする (case-insensitive)
 *   - ヘッダー行に inline content (`UNRESOLVED: foo`) があればそれを 1 項目目として採用
 *   - 後続の行を順に読み、bullet prefix (`-`, `*`, `+`, `1.`, `1)`) を除去して項目化
 *   - 空行で打ち切る (項目がまだない場合は skip して継続)
 *   - 次の heading (`## ...`) や fenced block で打ち切る
 */
function extractUnresolvedItems(
  response: string,
): PdfHideFallbackUnresolvedItem[] {
  let searchText = response;
  const blockRe = /```[ \t]*hide[ \t]*\r?\n[\s\S]*?\r?\n[ \t]*```/;
  const blockMatch = blockRe.exec(response);
  if (blockMatch) {
    searchText = response.slice(blockMatch.index + blockMatch[0].length);
  }

  const lines = searchText.split(/\r?\n/);
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*UNRESOLVED\b/i.test(lines[i]!)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const items: PdfHideFallbackUnresolvedItem[] = [];
  const pushItem = (text: string) => {
    items.push({ text, index: items.length + 1 });
  };

  const headerInline = lines[headerIdx]!
    .replace(/^\s*UNRESOLVED\s*[:：]?\s*/i, '')
    .trim();
  if (headerInline !== '') {
    pushItem(headerInline);
  }

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#{1,6}\s/.test(line)) break; // 次の heading で打ち切り
    if (/^[ \t]*```/.test(line)) break; // fenced block で打ち切り
    if (line.trim() === '') {
      if (items.length > 0) break;
      continue;
    }
    const cleaned = stripBulletPrefix(line).trim();
    if (cleaned !== '') pushItem(cleaned);
  }

  return items;
}

/** `- foo` / `* foo` / `+ foo` / `1. foo` / `1) foo` の prefix を除去 */
function stripBulletPrefix(line: string): string {
  return line.replace(/^\s*([-*+]|\d+[.)])\s+/, '');
}
