/**
 * hideLlmReview.ts — v1.9 LLM レビュー pipeline 用プロンプト構築層
 *
 * 仕様: README §4 / project status の "PDF→.hide LLM レビュー pipeline" の (a) 部分。
 *
 * 入力:
 *   1. `hideSource` — `musicXmlToHide` が逆変換した .hide ソース
 *   2. `diagnostics: MusicXmlToHideDiagnostic[]` — 構造化された不整合・省略情報
 *   3. `matrixIssues?: HideMatrixIssue[]` — `analyzeMatrix(hideSource)` の strict 検出
 *      (任意、推奨)
 *   4. `pageImages?: LlmReviewImage[]` — 元 PDF / 楽譜画像の base64 (任意、複数可)
 *   5. `pieceContext?` — 曲タイトル・作曲者などのグラウンディング情報 (任意)
 *
 * 出力 (`LlmReviewPrompt`):
 *   - `systemPrompt: string` — provider-agnostic system instruction
 *   - `userContent: LlmReviewContentBlock[]` — Anthropic API 風 multimodal content
 *     blocks (`messages[0].content` にそのまま投入できる形)
 *   - `textOnlyPrompt: string` — フラット化したテキスト版 (非マルチモーダル / ログ用)
 *   - `summary: LlmReviewSummary` — UI / ログ向けの集計
 *
 * 設計思想:
 *   - **silent fill しない** という reverse converter の設計を貫き、LLM に
 *     「画像こそが真の source-of-truth であり、hideSource の不整合をそれと照合
 *      して修正する」ことを明示する
 *   - 各 diagnostic / matrix issue は kind 付きで人間 + LLM 両方が読みやすい
 *     Japanese sentence にフォーマットする
 *   - 最小限の `.hide` cheatsheet を **system prompt** に含める
 *     (Anthropic prompt caching を活用しやすい配置)
 *   - hideSource は line-number prefix 付きで出すことで diagnostic の measureIndex
 *     と LLM が照合しやすくする
 *   - `LlmReviewContentBlock` は **Anthropic API の wire format をそのまま** 採用
 *     (`source.media_type` snake_case 等)。fetch 直叩き / SDK のどちらでも
 *     `messages[0].content` に投入できる
 *
 * スコープ外 (将来作業):
 *   - LLM 応答を新 .hide にマージするロジック (= apply layer)
 *   - 1 ラウンドでカバーできない場合のループ戦略
 *   - LLM 呼び出しそのもの (この層は単方向の prompt builder)
 */

import type { MusicXmlToHideDiagnostic, MusicXmlToHideResult } from './musicXmlToHide';
import type { HideMatrixIssue } from './hideMatrix';
import { analyzeMatrix } from './hideMatrix';

// ============================================================
// 公開型
// ============================================================

/**
 * 元 PDF / 楽譜画像 1 ページ。
 * `mediaType` はカメルケース (内部入力フォーマット)。
 * Anthropic wire format に変換するのは `interleaveImagesAndSections` の責務。
 */
export interface LlmReviewImage {
  /** Base64 エンコードされた画像データ (`data:` プレフィックス無し) */
  base64: string;
  /** MIME タイプ */
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** 1-based ページ番号 (任意、グラウンディング用) */
  pageNumber?: number;
  /** ページラベル (任意、例: "system 2", "page 1 上半分") */
  label?: string;
}

/**
 * Anthropic API 風 multimodal content block。
 *
 * **重要:** フィールド名は Anthropic Messages API の wire format に合わせており
 * (`source.media_type` snake_case)、`messages[0].content` にそのまま投入できる。
 * 他プロバイダ向けに変換する場合は consumer 側で reshape すること。
 */
export type LlmReviewContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    };

/** 集計情報 (UI / ログ向け) */
export interface LlmReviewSummary {
  diagnosticCount: number;
  matrixIssueCount: number;
  imageCount: number;
  hideSourceLineCount: number;
  /** 検出された diagnostic 種別 (sorted, unique) */
  diagnosticKinds: string[];
  /** 検出された matrix issue 種別 (sorted, unique) */
  matrixIssueKinds: string[];
}

/** プロンプト構築結果 */
export interface LlmReviewPrompt {
  /** Provider-agnostic system instruction */
  systemPrompt: string;
  /** Anthropic 風 user message content (drop directly into `messages[0].content`) */
  userContent: LlmReviewContentBlock[];
  /** テキストのみのフラット表現 (非マルチモーダル / デバッグログ用) */
  textOnlyPrompt: string;
  /** UI / ログ向け集計 */
  summary: LlmReviewSummary;
}

/** 楽曲メタデータ (LLM へのグラウンディング情報、任意) */
export interface LlmReviewPieceContext {
  title?: string;
  composer?: string;
  /** 自由記述 (例: "ピックアップ小節あり", "voice 1 はソプラノ", ...) */
  notes?: string;
}

/** プロンプト構築の入力 */
export interface LlmReviewInput {
  /** `musicXmlToHide` が出した .hide ソース */
  hideSource: string;
  /** `musicXmlToHide` が出した構造化 diagnostics */
  diagnostics: MusicXmlToHideDiagnostic[];
  /**
   * 任意: `analyzeMatrix(hideSource).issues`。
   * reverse converter と strict 検証層の両方の signal を LLM に渡したい場合に推奨。
   */
  matrixIssues?: HideMatrixIssue[];
  /**
   * 任意: 元 PDF / 楽譜画像 (複数ページ可)。
   * 配列順序がそのまま LLM への提示順序になる。
   */
  pageImages?: LlmReviewImage[];
  /** 任意: 楽曲メタデータ */
  pieceContext?: LlmReviewPieceContext;
  /**
   * 任意: 2 ラウンド目以降の follow-up context。
   * `hideLlmReviewLoop` (= ロードマップ (c) 部分) が次ラウンドを組むときに渡す。
   * round 1 の単発 prompt では undefined。
   */
  followup?: LlmReviewFollowupContext;
}

/**
 * 2 ラウンド目以降の follow-up 用文脈情報。
 *
 * **設計意図:** 単発の `buildLlmReviewPrompt` を「ループ層が呼び出す」関係を保つ
 * ため、ループ状態を直接渡すのではなく、必要な情報だけを抽出した plain object
 * として渡す (循環依存を避ける目的もある)。`previousUnresolved` は `string[]`
 * (構造化 `LlmReviewUnresolvedItem` ではない) ─ apply layer の型を import せず
 * 済むため。
 */
export interface LlmReviewFollowupContext {
  /** 現在のラウンド (1-based、ただし followup を渡すときは必ず >= 2) */
  round: number;
  /** ループの上限ラウンド数 */
  maxRounds: number;
  /** 前回 LLM が UNRESOLVED にマークした項目 (free-form text) */
  previousUnresolved: string[];
  /** 前回 LLM の修正サマリ (任意、free-form text) */
  previousSummary?: string;
}

// ============================================================
// 公開API
// ============================================================

/**
 * `musicXmlToHide` の出力 + 元 PDF 画像から LLM レビュー用プロンプトを構築する。
 *
 * @example
 *   const result = musicXmlToHide(xml);
 *   const prompt = buildLlmReviewPrompt({
 *     hideSource: result.hideSource,
 *     diagnostics: result.diagnostics,
 *     matrixIssues: analyzeMatrix(result.hideSource).issues,
 *     pageImages: [{ mediaType: 'image/png', base64: pngBase64, pageNumber: 1 }],
 *     pieceContext: { title: 'BWV 269', composer: 'J.S. Bach' },
 *   });
 *   // → Anthropic Messages API:
 *   //   anthropic.messages.create({
 *   //     model: 'claude-opus-4-6',
 *   //     max_tokens: 4096,
 *   //     system: prompt.systemPrompt,
 *   //     messages: [{ role: 'user', content: prompt.userContent }],
 *   //   });
 */
export function buildLlmReviewPrompt(input: LlmReviewInput): LlmReviewPrompt {
  const diagnostics = input.diagnostics ?? [];
  const matrixIssues = input.matrixIssues ?? [];
  const pageImages = input.pageImages ?? [];

  const systemPrompt = buildSystemPrompt();
  const sections = buildUserSections(input, diagnostics, matrixIssues, pageImages.length);
  const userContent = interleaveImagesAndSections(sections, pageImages);
  const textOnlyPrompt = sections.map(s => s.text).join('\n\n');

  const summary: LlmReviewSummary = {
    diagnosticCount: diagnostics.length,
    matrixIssueCount: matrixIssues.length,
    imageCount: pageImages.length,
    hideSourceLineCount: input.hideSource === '' ? 0 : input.hideSource.split('\n').length,
    diagnosticKinds: uniqueSorted(diagnostics.map(d => d.kind)),
    matrixIssueKinds: uniqueSorted(matrixIssues.map(i => i.kind)),
  };

  return { systemPrompt, userContent, textOnlyPrompt, summary };
}

/**
 * 簡易版: `musicXmlToHide` の result をそのまま渡せば、内部で
 * `analyzeMatrix(hideSource)` も実行して両方の signal を入れた prompt を返す。
 *
 * 推奨される標準フロー:
 *
 *   const result = musicXmlToHide(xml);
 *   const prompt = buildLlmReviewPromptFromResult(result, pageImages, ctx);
 */
export function buildLlmReviewPromptFromResult(
  result: MusicXmlToHideResult,
  pageImages?: LlmReviewImage[],
  pieceContext?: LlmReviewPieceContext,
): LlmReviewPrompt {
  const matrixIssues = analyzeMatrix(result.hideSource).issues;
  return buildLlmReviewPrompt({
    hideSource: result.hideSource,
    diagnostics: result.diagnostics,
    matrixIssues,
    pageImages,
    pieceContext,
  });
}

// ============================================================
// 内部: system prompt
// ============================================================

function buildSystemPrompt(): string {
  return `あなたはアカペラ楽譜の OMR (Optical Music Recognition) 出力を**画像を真の source-of-truth として**レビューする校閲者です。

入力:
  1. 元の楽譜画像 (PDF をラスタ化したもの) — **これが正解**
  2. 画像から OMR + MusicXML 経由で逆変換された \`.hide\` ソース
  3. 逆変換時に検出された構造化された不整合 (diagnostics)
  4. (任意) \`.hide\` の strict 検証層が再検出した issues

あなたの責務:
  - 画像と \`.hide\` ソースを照合する
  - diagnostics / issues が指摘している箇所を最優先で確認する
  - 必要に応じて \`.hide\` ソースを修正する
  - **silent fill (推測で休符や音符を埋める) は厳禁** — 画像で確認できない箇所は
    その旨を明記して残す

\`.hide\` 構文の最小チートシート:
  - ヘッダー: \`[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]\` (CLEF/TIME/KEY/DIV のみ)
  - 音符: \`<音名><臨時記号?><オクターブ><長さ文字>\`
    例: \`C4k\` (4分C4)、\`F#5l\` (半音F#5)、\`Bb3m\` (全音Bb3)、\`Cn5k\` (ナチュラルC5)
  - 長さ文字: h=32分 / i=16分 / j=8分 / k=4分 / l=2分 / m=全音
  - 休符: \`R<長さ文字>\` (例: \`Rk\` = 4分休符)
  - 和音: ピッチを連結してから 1 つの長さ文字 — \`C4E4G4m\` (Cメジャー全音符)
  - タイ: トークン直後に \`+\` — \`C4l+ C4l\` (タイで結ばれた半音符 2 つ = 全音符相当)
  - パートラベル: \`[1]\` \`[2]\` ... \`[N]\` (上声→下声の順)、\`[P]\` = ボイスパーカッション
  - 小節区切り: \`|\` (グリッド区切り、レイアウト用) または \`.\` 通常 / \`..\` 複縦線 /
    \`...\` 終止 / \`.:\` リピート開始 / \`:.\` リピート終了
  - 連符: \`8(C4iD4iE4i)\` (8u 内に 3 音 = 8 分音符 3 連符)
  - 反復: \`:body:N\` (N 回演奏)
  - メタ: \`[T120]\` (テンポ) / \`[M3/4]\` (拍子変更) / \`[K+2]\` (全体半音シフト)
  - コメント: \`;\` 以降は行末まで無視

出力フォーマット (厳守):
  1. 最初に **数行の修正サマリ** (どの小節で何を直したか、根拠)
  2. 次に修正済み \`.hide\` ソース全体を 1 つの \`\`\`hide ... \`\`\` ブロックで
  3. **画像で確認できなかった箇所** があれば最後に \`UNRESOLVED:\` セクションを追加し、
     各項目を 1 行で記述

修正できないとき (画像が不鮮明 / OMR が壊滅的 / 該当箇所が画像に映っていない) は、
その小節は元のまま残し UNRESOLVED に追記してください。**推測で埋めないこと**。`;
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
  input: LlmReviewInput,
  diagnostics: MusicXmlToHideDiagnostic[],
  matrixIssues: HideMatrixIssue[],
  imageCount: number,
): UserSection[] {
  const sections: UserSection[] = [];

  // 0. piece context (if any)
  const ctx = input.pieceContext;
  if (ctx && (ctx.title || ctx.composer || ctx.notes)) {
    const lines: string[] = ['## 楽曲情報'];
    if (ctx.title) lines.push(`- タイトル: ${ctx.title}`);
    if (ctx.composer) lines.push(`- 作曲者: ${ctx.composer}`);
    if (ctx.notes) lines.push(`- 備考: ${ctx.notes}`);
    sections.push({ id: 'pieceContext', text: lines.join('\n') });
  }

  // 0b. follow-up round context (if any) — round 2+ で渡される
  if (input.followup) {
    sections.push({
      id: 'followup',
      text: formatFollowupSection(input.followup),
    });
  }

  // 1. hideSource (line-numbered)
  sections.push({
    id: 'hideSource',
    text:
      '## 逆変換された .hide ソース\n\n```hide\n' +
      addLineNumbers(input.hideSource) +
      '\n```',
  });

  // 2. diagnostics (always present, even if empty — explicit "no issues found")
  sections.push({
    id: 'diagnostics',
    text: formatDiagnosticsSection(diagnostics),
  });

  // 3. matrix issues (only if any — strict layer is optional input)
  if (matrixIssues.length > 0) {
    sections.push({
      id: 'matrixIssues',
      text: formatMatrixIssuesSection(matrixIssues),
    });
  }

  // 4. instruction footer
  sections.push({
    id: 'instruction',
    text: buildInstructionFooter(imageCount),
  });

  return sections;
}

function formatFollowupSection(ctx: LlmReviewFollowupContext): string {
  const lines: string[] = [];
  lines.push(`## レビューラウンド ${ctx.round} / ${ctx.maxRounds}`);
  lines.push('');
  lines.push(
    `これは複数ラウンドレビューの ${ctx.round} 回目です。下に提示する \`.hide\` ソースは前回 (round ${ctx.round - 1}) あなたが返した修正バージョンです。`,
  );
  lines.push('');

  if (ctx.previousUnresolved.length > 0) {
    lines.push('### 前回 UNRESOLVED にマークした項目');
    for (let i = 0; i < ctx.previousUnresolved.length; i++) {
      lines.push(`${i + 1}. ${ctx.previousUnresolved[i]}`);
    }
    lines.push('');
  } else {
    lines.push('### 前回 UNRESOLVED');
    lines.push('(前回 UNRESOLVED 項目はありませんでした)');
    lines.push('');
  }

  if (ctx.previousSummary && ctx.previousSummary.trim() !== '') {
    lines.push('### 前回の修正サマリ');
    // 各行に > を付けて blockquote 化
    const quoted = ctx.previousSummary
      .split('\n')
      .map(l => `> ${l}`)
      .join('\n');
    lines.push(quoted);
    lines.push('');
  }

  lines.push('### 今回のラウンドでフォーカスしてほしいこと');
  lines.push('- 上記 UNRESOLVED 項目を再度画像で確認できないか試す');
  lines.push('- 下に列挙される残存 issues / diagnostics を修正する');
  lines.push('- それでも判断できない箇所は再度 UNRESOLVED に残す — **推測で埋めないこと**');
  if (ctx.round >= ctx.maxRounds) {
    lines.push('');
    lines.push(
      `**これが最終ラウンドです** (上限 ${ctx.maxRounds})。確信度の高い修正のみ行い、残った曖昧な箇所は UNRESOLVED に正直に残してください。`,
    );
  }

  return lines.join('\n');
}

function buildInstructionFooter(imageCount: number): string {
  const imageNote =
    imageCount > 0
      ? `${imageCount} 枚の楽譜画像が添付されています。各 diagnostic / issue を画像と照合して修正案を提示してください。`
      : '楽譜画像は添付されていません。診断結果と .hide ソースのみで判断できる修正だけを行い、画像確認が必要な箇所は UNRESOLVED に記載してください。';
  return `## 指示\n\n${imageNote}\n\nシステムプロンプトの出力フォーマット (修正サマリ → \`\`\`hide\`\`\` ブロック → UNRESOLVED) に従って回答してください。`;
}

// ============================================================
// 内部: diagnostic formatting
// ============================================================

function formatDiagnosticsSection(diagnostics: MusicXmlToHideDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return '## 逆変換 diagnostics\n\n(なし — 構造的な不整合は検出されませんでした。ただし OMR エラーやピッチ間違いの可能性は残るので画像と必ず照合してください)';
  }
  const lines: string[] = ['## 逆変換 diagnostics', ''];
  for (let i = 0; i < diagnostics.length; i++) {
    lines.push(`${i + 1}. ${formatDiagnostic(diagnostics[i])}`);
  }
  return lines.join('\n');
}

/**
 * Diagnostic 1 件を LLM 向けの 1 行の sentence にフォーマットする。
 * 各 sentence は (a) kind タグ、(b) 該当箇所 (パート/小節)、(c) なぜ問題か、
 * (d) LLM に何を確認/修正してほしいか、を含む。
 */
function formatDiagnostic(d: MusicXmlToHideDiagnostic): string {
  switch (d.kind) {
    case 'partMeasureCountMismatch':
      return `[partMeasureCountMismatch] パート [${d.partLabel}] の小節数が ${d.got}/${d.expected} と他パートより少ない。画像で該当パートが本当に短いのか、それとも OMR が小節を取りこぼしたのか確認してください。silent fill はせず、不足している小節を画像から書き起こすか UNRESOLVED に残してください。`;
    case 'multipleAttributes':
      return `[multipleAttributes] パート#${d.partIndex + 1} に <attributes> ブロックが複数 (= 拍子/調号の中途変更)。逆変換は最初の <attributes> のみ採用しているため、変更後の小節は誤った拍子/調号で表現されている可能性があります。画像で変更箇所を特定し、\`[M3/4]\` や \`[K+2]\` のメタを該当小節の前に挿入してください。`;
    case 'multipleVoices':
      return `[multipleVoices] パート#${d.partIndex + 1} 小節 ${d.measureIndex + 1} に複数 voice (${d.voices.join(',')})。逆変換は voice=1 のみ採用しているため、追加 voice の音は失われています。画像で内声分割が必要かを判断し、必要なら新しいパート \`[N]\` を増やすか同パート内の和音 (\`C4E4G4k\`) として書き直してください。`;
    case 'tupletDetected':
      return `[tupletDetected] パート#${d.partIndex + 1} 小節 ${d.measureIndex + 1} に連符 (<time-modification>) を検出。逆変換は duration をそのまま近似しているため拍子合計が合わない可能性があります。画像で連符種別 (3連符 / 5連符 等) を確認し、\`8(C4iD4iE4i)\` のような連符記法に書き換えてください。`;
    case 'nonStandardDuration':
      return `[nonStandardDuration] パート#${d.partIndex + 1} 小節 ${d.measureIndex + 1} の duration ${d.durationUnits}u が標準長さ (h/i/j/k/l/m) に一致せず最近接で近似されました。画像で実際の音価を確認してください — 付点音符・タイ連結 (例: \`C4l+ C4k\`) の見落としかもしれません。`;
  }
}

// ============================================================
// 内部: matrix issue formatting
// ============================================================

function formatMatrixIssuesSection(issues: HideMatrixIssue[]): string {
  const lines: string[] = ['## .hide strict 検証層の issue (analyzeMatrix)', ''];
  for (let i = 0; i < issues.length; i++) {
    lines.push(`${i + 1}. ${formatMatrixIssue(issues[i])}`);
  }
  return lines.join('\n');
}

function formatMatrixIssue(issue: HideMatrixIssue): string {
  const loc: string[] = [];
  if (issue.measureIndex !== undefined) loc.push(`小節 ${issue.measureIndex + 1}`);
  if (issue.partLabel) loc.push(`パート [${issue.partLabel}]`);
  const locText = loc.length > 0 ? ` (${loc.join(', ')})` : '';
  return `[${issue.kind}]${locText} ${issue.message}`;
}

// ============================================================
// 内部: line numbering
// ============================================================

/**
 * 各行の先頭に右揃えの行番号を付加する。LLM が diagnostic の measureIndex と
 * 行を対応付けやすくするための補助。
 */
function addLineNumbers(source: string): string {
  if (source === '') return '';
  const lines = source.split('\n');
  const width = String(lines.length).length;
  return lines
    .map((line, i) => `${String(i + 1).padStart(width, ' ')} | ${line}`)
    .join('\n');
}

// ============================================================
// 内部: image interleaving
// ============================================================

/**
 * 画像群とテキストセクションを 1 本の content block 列に組み立てる。
 *
 * 戦略: **画像を先に並べる** (LLM が視覚情報を先に受け取って後続のテキスト
 * 診断を grounding できるように)。各画像の前には pageNumber/label の short
 * caption を入れる。
 */
function interleaveImagesAndSections(
  sections: UserSection[],
  images: LlmReviewImage[],
): LlmReviewContentBlock[] {
  const blocks: LlmReviewContentBlock[] = [];

  for (const img of images) {
    const labelParts: string[] = [];
    if (img.pageNumber !== undefined) labelParts.push(`page ${img.pageNumber}`);
    if (img.label) labelParts.push(img.label);
    if (labelParts.length > 0) {
      blocks.push({ type: 'text', text: `(${labelParts.join(' — ')})` });
    }
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    });
  }

  for (const section of sections) {
    blocks.push({ type: 'text', text: section.text });
  }

  return blocks;
}

// ============================================================
// 内部: utilities
// ============================================================

function uniqueSorted(items: string[]): string[] {
  return Array.from(new Set(items)).sort();
}
