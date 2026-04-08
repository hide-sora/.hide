/**
 * hideHamoringSuggest.ts — v1.9 ハモリ提案 LLM プロンプト構築層
 *
 * 仕様: matrix mode の最後の consumer 層。
 *
 * matrix iterator + chord label + voice leading observation を入力に
 * 「次の一手」を LLM に提示するためのプロンプトを組み立てる。`hideLlmReview`
 * (OMR レビュー用) と並ぶ第 2 の prompt builder で、こちらは **生成タスク**
 * 用なので役割と前提が逆向き:
 *
 *  | レイヤー              | 用途           | source-of-truth | silent fill |
 *  |-----------------------|----------------|------------------|-------------|
 *  | hideLlmReview         | OMR 校閲       | 元の楽譜画像     | **禁止**    |
 *  | hideHamoringSuggest   | ハモリ生成     | 現状 .hide       | **OK**      |
 *
 * 入力:
 *   1. `hideSource` — 編曲の現状 (= 出発点)
 *   2. `task` — 何を提案してほしいか (5 種別、discriminated union)
 *   3. `pieceContext?` — 楽曲メタ (任意)
 *
 * 出力 (`HamoringSuggestPrompt`):
 *   - `systemPrompt: string` — provider-agnostic system instruction
 *   - `userContent: HamoringContentBlock[]` — Anthropic 風 content block 列
 *     (画像は使わないので text-only)
 *   - `textOnlyPrompt: string` — フラット化したテキスト版
 *   - `summary: HamoringSuggestSummary` — UI / ログ向け集計
 *
 * 設計思想:
 *   - **Hamoren = ポップ/現代アカペラ** が対象なので古典和声の禁則は適用しない
 *     (cf. `hideVoiceLeading.ts` ヘッダー、`feedback_hamoren_genre.md`)
 *   - voice leading observation は **caution** として渡し、絶対禁則ではないこと
 *     を system prompt で明示する
 *   - **silent fill OK** — これは generative task であり、画像と照合する OMR
 *     レビューではない。LLM に「画像で確認できなければ書かないで」とは言わない
 *   - matrix / chord / voice leading の三層を内部で順に呼んで context を最大化
 *   - `task` は discriminated union で 5 種類: continue / addPart / fixSection /
 *     reharmonize / freeform
 *
 * スコープ外 (将来作業):
 *   - 実 LLM 呼び出し (この層は pure prompt builder)
 *   - 応答パーサ + 元 .hide へのマージ (= apply layer; 別レイヤーで作る)
 *   - UI ツール (Web GUI 等)
 */

import type { HideMatrix, HideMatrixMeasure } from './hideMatrix';
import { analyzeMatrix } from './hideMatrix';
import type { ChordLabel } from './hideChord';
import { classifyMatrixMeasures } from './hideChord';
import type { VoiceLeadingObservation } from './hideVoiceLeading';
import { analyzeVoiceLeading } from './hideVoiceLeading';

// ============================================================
// 公開型
// ============================================================

/**
 * 提案タスクの種別。
 *
 * 5 種別を discriminated union で表現:
 *  - **continue**: 曲の続きを N 小節提案
 *  - **addPart**: 現状の編曲に新しいパート (= ハモリ声部) を追加
 *  - **fixSection**: 指定範囲のセクションを修正
 *  - **reharmonize**: 指定範囲のコード進行を別案に
 *  - **freeform**: ユーザの自由記述
 *
 * すべての measure index は **1-based, inclusive** (= LLM が読む `.hide`
 * ソースの行番号と一致するよう揃えている)。
 */
export type HamoringSuggestTask =
  | {
      kind: 'continue';
      /** 追加する小節数 (>= 1) */
      measuresToAdd: number;
      /** 任意: 自由記述 (例: "サビに向かって盛り上がる", "Coda は減速") */
      styleHint?: string;
    }
  | {
      kind: 'addPart';
      /** 追加するパートのラベル (例: "3", "P") */
      partLabel: string;
      /** 任意: 自由記述 (例: "alto descant", "bass walking line") */
      voiceDescription?: string;
    }
  | {
      kind: 'fixSection';
      /** 1-based, inclusive */
      fromMeasure: number;
      /** 1-based, inclusive (>= fromMeasure) */
      toMeasure: number;
      /** 任意: 何を直してほしいか (例: "voice crossing が気になる", "盛り上がり不足") */
      goal?: string;
    }
  | {
      kind: 'reharmonize';
      /** 1-based, inclusive */
      fromMeasure: number;
      /** 1-based, inclusive (>= fromMeasure) */
      toMeasure: number;
      /** 任意: 制約 (例: "tonic で終わる", "II-V-I を含める", "ジャズコード") */
      constraints?: string;
    }
  | {
      kind: 'freeform';
      /** 自由記述 query (空文字は不可) */
      userQuery: string;
    };

/** 楽曲メタ (任意、グラウンディング情報) */
export interface HamoringPieceContext {
  title?: string;
  composer?: string;
  /** 自由記述 (例: "Aメロ", "ピックアップあり", "テンポは速め") */
  notes?: string;
}

/** プロンプト構築の入力 */
export interface HamoringSuggestInput {
  /** 編曲の現状 .hide ソース */
  hideSource: string;
  /** 何を提案してほしいか */
  task: HamoringSuggestTask;
  /** 任意: 楽曲メタ */
  pieceContext?: HamoringPieceContext;
}

/**
 * Anthropic API 風 content block。
 * ハモリ提案では画像を使わないので text のみ。
 */
export type HamoringContentBlock = { type: 'text'; text: string };

/** 集計情報 (UI / ログ向け) */
export interface HamoringSuggestSummary {
  hideSourceLineCount: number;
  /** 入力 .hide の小節数 */
  measureCount: number;
  /** 入力 .hide のパート数 */
  partCount: number;
  /** 分類できたコード数 (null は除外) */
  chordLabelCount: number;
  /** 検出された voice leading observation 数 */
  voiceLeadingObservationCount: number;
  /** タスク種別 (`task.kind`) */
  taskKind: HamoringSuggestTask['kind'];
}

/** プロンプト構築結果 */
export interface HamoringSuggestPrompt {
  /** Provider-agnostic system instruction */
  systemPrompt: string;
  /** Anthropic 風 user message content (text only) */
  userContent: HamoringContentBlock[];
  /** テキストのみのフラット表現 (デバッグログ用) */
  textOnlyPrompt: string;
  /** UI / ログ向け集計 */
  summary: HamoringSuggestSummary;
}

// ============================================================
// 公開API
// ============================================================

/**
 * `.hide` ソース + タスクから LLM ハモリ提案用プロンプトを構築する。
 *
 * 内部で `analyzeMatrix` → `classifyMatrixMeasures` → `analyzeVoiceLeading`
 * を順に呼び、得られた情報をすべて prompt の context に含める。
 *
 * @example
 *   const prompt = buildHamoringSuggestPrompt({
 *     hideSource: currentArrangement,
 *     task: { kind: 'addPart', partLabel: '3', voiceDescription: 'alto' },
 *     pieceContext: { title: '紅蓮華', notes: 'A メロ' },
 *   });
 *   // → Anthropic Messages API:
 *   //   anthropic.messages.create({
 *   //     model: 'claude-opus-4-6',
 *   //     max_tokens: 4096,
 *   //     system: prompt.systemPrompt,
 *   //     messages: [{ role: 'user', content: prompt.userContent }],
 *   //   });
 */
export function buildHamoringSuggestPrompt(
  input: HamoringSuggestInput,
): HamoringSuggestPrompt {
  validateTask(input.task);

  const matrixResult = analyzeMatrix(input.hideSource);
  const matrix = matrixResult.matrix;
  const chordLabels = classifyMatrixMeasures(matrix);
  const vlAnalysis = analyzeVoiceLeading(matrix);

  const systemPrompt = buildSystemPrompt();
  const sections = buildUserSections(
    input,
    matrix,
    chordLabels,
    vlAnalysis.observations,
  );
  const userContent: HamoringContentBlock[] = sections.map((s) => ({
    type: 'text',
    text: s.text,
  }));
  const textOnlyPrompt = sections.map((s) => s.text).join('\n\n');

  const summary: HamoringSuggestSummary = {
    hideSourceLineCount:
      input.hideSource === '' ? 0 : input.hideSource.split('\n').length,
    measureCount: matrix.measures.length,
    partCount: matrix.partLabels.length,
    chordLabelCount: chordLabels.filter((c) => c !== null).length,
    voiceLeadingObservationCount: vlAnalysis.observations.length,
    taskKind: input.task.kind,
  };

  return { systemPrompt, userContent, textOnlyPrompt, summary };
}

// ============================================================
// 内部: task validation
// ============================================================

function validateTask(task: HamoringSuggestTask): void {
  switch (task.kind) {
    case 'continue':
      if (!Number.isInteger(task.measuresToAdd) || task.measuresToAdd < 1) {
        throw new Error(
          `hideHamoringSuggest: task.measuresToAdd must be a positive integer (got ${task.measuresToAdd})`,
        );
      }
      return;
    case 'addPart':
      if (task.partLabel.trim() === '') {
        throw new Error(
          'hideHamoringSuggest: task.partLabel must be a non-empty string',
        );
      }
      return;
    case 'fixSection':
    case 'reharmonize':
      if (
        !Number.isInteger(task.fromMeasure) ||
        task.fromMeasure < 1 ||
        !Number.isInteger(task.toMeasure) ||
        task.toMeasure < 1
      ) {
        throw new Error(
          `hideHamoringSuggest: ${task.kind}.fromMeasure / toMeasure must be 1-based positive integers`,
        );
      }
      if (task.fromMeasure > task.toMeasure) {
        throw new Error(
          `hideHamoringSuggest: ${task.kind}.fromMeasure (${task.fromMeasure}) must be <= toMeasure (${task.toMeasure})`,
        );
      }
      return;
    case 'freeform':
      if (task.userQuery.trim() === '') {
        throw new Error(
          'hideHamoringSuggest: task.userQuery must be a non-empty string',
        );
      }
      return;
  }
}

// ============================================================
// 内部: system prompt
// ============================================================

function buildSystemPrompt(): string {
  return `あなたはアカペラ編曲アシスタントです。Hamoren プロジェクトの一部として、現状の編曲に対する「次の一手」レベルの提案を行います。

**重要な前提 — 対象ジャンル**:
  - 対象は **ポップ/現代アカペラ** です。古典和声の禁則 (平行 5 度・平行 8 度・声部交差・大跳躍・直行 5/8 度) は **適用しません**。
  - パワーコードとしての平行 5 度、リッチなボーカル和音のための声部交差、メリスマやエフェクトのための大跳躍は、いずれもポップ・現代アカペラでは積極的に使われる表現です。
  - 後述の "voice leading observations" セクションは「古典和声でなら caution されるであろう動き」を listing しているだけで、**禁則ではありません**。文脈に応じて活用してください。
  - これは **生成タスク** であり、OMR レビューではありません。元画像との照合は不要で、自由に音を提案して構いません。

入力:
  1. 現状の \`.hide\` ソース (行番号 prefix 付き)
  2. matrix mode が抽出した **コード進行** (各小節の和音ラベル)
  3. matrix mode が検出した **voice leading observations** (caution、上記の通り禁則ではない)
  4. **タスク** — 何を提案してほしいか
  5. (任意) 楽曲メタデータ

\`.hide\` 構文の最小チートシート:
  - ヘッダー: \`[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]\` (CLEF/TIME/KEY/DIV のみ)
  - 音符: \`<音名><臨時記号?><オクターブ><長さ文字>\`
    例: \`C4k\` (4分C4)、\`F#5l\` (半音F#5)、\`Bb3m\` (全音Bb3)
  - 長さ文字: h=32分 / i=16分 / j=8分 / k=4分 / l=2分 / m=全音
  - 休符: \`R<長さ文字>\` (例: \`Rk\` = 4分休符)
  - 和音: ピッチを連結してから 1 つの長さ文字 — \`C4E4G4m\` (Cメジャー全音符)
  - タイ: トークン直後に \`+\` — \`C4l+ C4l\` (タイで結ばれた半音符 2 つ)
  - パートラベル: \`[1]\` \`[2]\` ... \`[N]\` (上声→下声の順)、\`[P]\` = ボイスパーカッション
  - 小節区切り: \`|\` (グリッド区切り、レイアウト用) または \`.\` 通常 / \`..\` 複縦線 /
    \`...\` 終止 / \`.:\` リピート開始 / \`:.\` リピート終了
  - 連符: \`8(C4iD4iE4i)\` (8u 内に 3 音 = 8 分音符 3 連符)
  - 反復: \`:body:N\` (N 回演奏)
  - メタ: \`[T120]\` (テンポ) / \`[M3/4]\` (拍子変更) / \`[K+2]\` (全体半音シフト)

出力フォーマット (厳守):
  1. 最初に **数行の提案サマリ** (なぜそうしたか、音楽的根拠)
  2. 次に提案を含む \`.hide\` を 1 つの \`\`\`hide ... \`\`\` ブロックで:
     - **continue** タスクなら新しい小節だけのスニペットでも可 (例: \`[1]| C5m | D5m |\`)
     - **addPart** タスクなら追加パートを含めた **編曲全体** を返す
     - **fixSection / reharmonize** タスクなら修正後の **編曲全体** を返す
     - **freeform** タスクは内容に応じて判断
  3. (任意) 代替案がある場合は別の \`\`\`hide\`\`\` ブロックを追加し、それぞれの上に **代替案 1**, **代替案 2** のようにラベルを付けてください

提案できないとき (タスクが矛盾している / 入力が壊れている等) は、その旨を最初の数行に明記し、 \`\`\`hide\`\`\` ブロックは省略してください。`;
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
  input: HamoringSuggestInput,
  matrix: HideMatrix,
  chordLabels: Array<ChordLabel | null>,
  observations: VoiceLeadingObservation[],
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

  // 1. hideSource (line-numbered, full)
  sections.push({
    id: 'hideSource',
    text:
      '## 現状の .hide ソース\n\n```hide\n' +
      addLineNumbers(input.hideSource) +
      '\n```',
  });

  // 2. chord progression (computed from matrix)
  sections.push({
    id: 'chordProgression',
    text: formatChordProgressionSection(matrix, chordLabels),
  });

  // 3. voice leading observations (always present, even if empty —
  //    explicit "no cautions found" so LLM knows analysis was run)
  sections.push({
    id: 'voiceLeadingObservations',
    text: formatVoiceLeadingObservationsSection(observations),
  });

  // 4. task specification
  sections.push({
    id: 'task',
    text: formatTaskSection(input.task),
  });

  // 5. instruction footer
  sections.push({
    id: 'instruction',
    text: buildInstructionFooter(),
  });

  return sections;
}

// ============================================================
// 内部: chord progression formatting
// ============================================================

function formatChordProgressionSection(
  matrix: HideMatrix,
  chordLabels: Array<ChordLabel | null>,
): string {
  if (matrix.measures.length === 0) {
    return '## コード進行\n\n(小節がありません — 入力 .hide が空かヘッダーのみの可能性があります)';
  }

  const lines: string[] = ['## コード進行 (matrix mode 抽出)', ''];
  lines.push('| 小節 | コード | 補足 |');
  lines.push('|------|--------|------|');

  for (let i = 0; i < matrix.measures.length; i++) {
    const measureNumber = i + 1;
    const label = chordLabels[i];
    if (label === null) {
      lines.push(`| ${measureNumber} | (分類不能) | テンプレートにマッチしないか同時鳴音が少ない |`);
    } else {
      const note = label.inverted ? `転回形 (bass=${label.bass})` : '';
      lines.push(`| ${measureNumber} | ${label.symbol} | ${note} |`);
    }
  }

  return lines.join('\n');
}

// ============================================================
// 内部: voice leading observation formatting
// ============================================================

function formatVoiceLeadingObservationsSection(
  observations: VoiceLeadingObservation[],
): string {
  if (observations.length === 0) {
    return '## voice leading observations (caution)\n\n(古典和声で caution されるような動きは検出されませんでした。ただしこれは「現状でも古典的にも問題ない」という意味であり、ポップ的に何か追加してはいけないという意味ではありません)';
  }
  const lines: string[] = ['## voice leading observations (caution)', ''];
  lines.push(
    '以下は **古典和声でなら避けられる動き** ですが、ポップ/現代アカペラでは禁則ではありません。文脈で判断してください。',
  );
  lines.push('');
  for (let i = 0; i < observations.length; i++) {
    lines.push(`${i + 1}. ${formatObservation(observations[i]!)}`);
  }
  return lines.join('\n');
}

function formatObservation(obs: VoiceLeadingObservation): string {
  const partsText = obs.parts.length > 0 ? ` (パート: ${obs.parts.map((p) => `[${p}]`).join(' / ')})` : '';
  const measureText =
    obs.fromMeasureIndex === obs.toMeasureIndex
      ? `小節 ${obs.fromMeasureIndex + 1}`
      : `小節 ${obs.fromMeasureIndex + 1} → ${obs.toMeasureIndex + 1}`;
  return `[${obs.kind}] ${measureText}${partsText} — ${obs.message}`;
}

// ============================================================
// 内部: task formatting
// ============================================================

function formatTaskSection(task: HamoringSuggestTask): string {
  const lines: string[] = ['## タスク', ''];
  switch (task.kind) {
    case 'continue': {
      lines.push(`**種別**: continue (続きを ${task.measuresToAdd} 小節提案)`);
      lines.push('');
      lines.push(
        `現状の .hide ソースの末尾に続く小節を **${task.measuresToAdd} 小節分** 提案してください。各パートに対してハモリラインを付けた完全な続きを生成してください。`,
      );
      if (task.styleHint && task.styleHint.trim() !== '') {
        lines.push('');
        lines.push(`**スタイル指示**: ${task.styleHint}`);
      }
      lines.push('');
      lines.push(
        `出力の \`\`\`hide\`\`\` ブロックには **追加分の小節だけ** を入れる形でも、**全体ソース + 追加分** を返してもどちらでも構いません。明示してください。`,
      );
      return lines.join('\n');
    }

    case 'addPart': {
      lines.push(`**種別**: addPart (新パート [${task.partLabel}] を追加)`);
      lines.push('');
      lines.push(
        `現状の編曲に **新しいパート \`[${task.partLabel}]\`** を追加してください。既存パートを変更してはいけません。新パートは最初から最後まで全小節分書いてください。`,
      );
      if (task.voiceDescription && task.voiceDescription.trim() !== '') {
        lines.push('');
        lines.push(`**声部の希望**: ${task.voiceDescription}`);
      }
      lines.push('');
      lines.push(
        `出力の \`\`\`hide\`\`\` ブロックには **新パートを含めた編曲全体** を返してください。`,
      );
      return lines.join('\n');
    }

    case 'fixSection': {
      lines.push(
        `**種別**: fixSection (小節 ${task.fromMeasure} 〜 ${task.toMeasure} を修正)`,
      );
      lines.push('');
      lines.push(
        `**小節 ${task.fromMeasure} から ${task.toMeasure} まで** を修正してください。それ以外の小節は変更しないでください。`,
      );
      if (task.goal && task.goal.trim() !== '') {
        lines.push('');
        lines.push(`**修正の目的**: ${task.goal}`);
      }
      lines.push('');
      lines.push(
        `出力の \`\`\`hide\`\`\` ブロックには **修正後の編曲全体** を返してください。`,
      );
      return lines.join('\n');
    }

    case 'reharmonize': {
      lines.push(
        `**種別**: reharmonize (小節 ${task.fromMeasure} 〜 ${task.toMeasure} のコード進行を別案に)`,
      );
      lines.push('');
      lines.push(
        `**小節 ${task.fromMeasure} から ${task.toMeasure} まで** のコード進行を別案に書き換えてください。メロディ (= 最上声) は保ちつつ、内声・低音を新しいコード進行に合わせて変更してください。`,
      );
      if (task.constraints && task.constraints.trim() !== '') {
        lines.push('');
        lines.push(`**制約**: ${task.constraints}`);
      }
      lines.push('');
      lines.push(
        `出力の \`\`\`hide\`\`\` ブロックには **修正後の編曲全体** を返してください。複数案がある場合は代替案ブロックを追加してください。`,
      );
      return lines.join('\n');
    }

    case 'freeform': {
      lines.push('**種別**: freeform (自由記述)');
      lines.push('');
      lines.push('**ユーザのリクエスト**:');
      lines.push('');
      const quoted = task.userQuery
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
      lines.push(quoted);
      lines.push('');
      lines.push(
        `上記リクエストに沿った提案を行ってください。出力の \`\`\`hide\`\`\` ブロックの内容 (全体 / 部分) はリクエスト内容に合わせて判断してください。`,
      );
      return lines.join('\n');
    }
  }
}

// ============================================================
// 内部: instruction footer
// ============================================================

function buildInstructionFooter(): string {
  return `## 指示

システムプロンプトの出力フォーマット (提案サマリ → \`\`\`hide\`\`\` ブロック → 任意の代替案) に従って回答してください。古典和声の禁則は適用せず、ポップ/現代アカペラの感性で自由に提案して構いません。`;
}

// ============================================================
// 内部: line numbering (hideLlmReview と同じロジック、独立化)
// ============================================================

/**
 * 各行の先頭に右揃えの行番号を付加する。LLM が小節指定 (fromMeasure 等) と
 * .hide 行を対応付けやすくするための補助。
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
// 内部: re-export for testability
// ============================================================
//
// `HideMatrixMeasure` は内部だけで使うが、test 側で型シグネチャを書きたい
// ことがあるので side-effect of import としておく。直接使わない。
// (verbatimModuleSyntax で type-only import 扱いされる)
type _UnusedMeasureRef = HideMatrixMeasure;
