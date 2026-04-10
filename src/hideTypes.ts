/**
 * hideTypes.ts — .hide 楽譜記述言語の AST 型定義
 *
 * 仕様: .hide v1.1 + v1.2 + v1.3 マージ後
 *  - v1.1: 音符署名 [音名][オクターブ][長さ]、和音、連符、休符、タイ、歌詞
 *  - v1.2: メタコマンド([T120][M3/4][K+2])、反復(:...:N)、パート切替([S][A][T][B][P1])
 *  - v1.3: 臨時記号(s/b/n)、ホワイトスペース・コメント許容
 *
 * 型は M1 から M5 まで段階的に使うので最初から完全形を定義する。
 */

// ============================================================
// ヘッダー
// ============================================================

/**
 * 譜表記号
 *  - TREBLE      : ト音記号 (G clef)
 *  - TREBLE_8VA  : ト音記号 8va (上に小さく "8" — 実音は 1 オクターブ上)
 *  - TREBLE_8VB  : ト音記号 8va bassa (下に小さく "8" — 実音は 1 オクターブ下)
 *                  テナーパートで頻用
 *  - BASS        : ヘ音記号 (F clef)
 *  - ALTO/TENOR  : ハ音記号 (C clef) 中央/上
 *  - PERCUSSION  : 打楽器用 5 線無し中立譜表
 */
export type HideClef = 'TREBLE' | 'TREBLE_8VA' | 'TREBLE_8VB' | 'BASS' | 'ALTO' | 'TENOR' | 'PERCUSSION';

/** ヘッダーで宣言される全体設定 */
export interface HideHeader {
  clef: HideClef;        // CLEF:TREBLE (省略時 TREBLE) — score 全体のデフォルト譜表
  timeNum: number;       // TIME numerator (省略時 4)
  timeDen: number;       // TIME denominator (省略時 4)
  keyFifths: number;     // KEY: 五度圏 元曲の調 (省略時 0=C major)
  div: number;           // DIV: 全音符あたりの単位数 (省略時 32 → 4分=8u)
  transposeSemitones: number; // [K+n] による半音シフト (省略時 0)
  /**
   * パートラベル → 譜表記号 のマップ (省略時 空 = 全パートが header.clef を使う)
   *
   * `[CLEFS:1=T,2=T,3=T8,4=B ...]` のような per-part 譜表宣言からパースされる。
   * matrix mode で `[1][2][3][4]` 等の番号付きパートに譜表を割り当てるための
   * 公式なメカニズム。stream mode (単一パート) では無視される。
   *
   * 値の vocabulary:
   *   T  → TREBLE
   *   B  → BASS
   *   T8 → TREBLE_8VB
   *   A  → ALTO
   *   Te → TENOR
   *   N  → PERCUSSION
   */
  partClefs: Record<string, HideClef>;
}

/**
 * ヘッダーのデフォルト値 (v1.8: ヘッダー完全省略時に使われる)
 *
 * partClefs は Record なので、spread でコピーすると参照共有される。
 * パーサ等で既定値をベースに header を組み立てる場合は必ず
 * `createDefaultHeader()` か `{ ...HIDE_HEADER_DEFAULT, partClefs: {} }` を使う。
 */
export const HIDE_HEADER_DEFAULT: HideHeader = {
  clef: 'TREBLE',
  timeNum: 4,
  timeDen: 4,
  keyFifths: 0,
  div: 32,
  transposeSemitones: 0,
  partClefs: {},
};

/** 新しい (mutate しても安全な) デフォルトヘッダーを返す */
export function createDefaultHeader(): HideHeader {
  return { ...HIDE_HEADER_DEFAULT, partClefs: {} };
}

// ============================================================
// 音符・休符の構成要素
// ============================================================

/** 1音(1ピッチ)。和音は HideNoteToken.pitches に複数を持つ */
export interface HidePitch {
  step: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  octave: number;            // 0-9
  alter: -1 | 0 | 1;         // フラット/ナチュラル/シャープ (v1.5)
  accidentalExplicit?: boolean; // ユーザーが #/b/n を明示的に書いたか (Rule B 用)
}

/** 連符メンバー情報。連符の中の音符・休符に付与される */
export interface HideTupletMemberInfo {
  groupId: number;       // 同一連符グループの識別子
  memberIndex: number;   // グループ内のインデックス (0始まり)
  totalMembers: number;  // グループ全体のメンバー数
  targetUnits: number;   // 連符全体が占める時間 unit
}

/** 1ユニット = DIV=32時で32分音符1個分 */
export type HideUnit = number;

// ============================================================
// トークン (パース結果の最小構成要素)
// ============================================================

/** 音符トークン (和音は pitches を複数持つ) */
export interface HideNoteToken {
  kind: 'note';
  pitches: HidePitch[];        // 和音対応
  durationUnits: HideUnit;     // 例: jなら 4u (付点込み: k.=12u, k..=14u)
  dots: number;                // 0=無し, 1=付点 (×1.5), 2=2重付点 (×1.75)
  staccato: boolean;           // 大文字長さ (K/L/M等)
  accent: boolean;             // k> アクセント
  tenuto: boolean;             // k- テヌート
  fermata: boolean;            // k~ フェルマータ
  marcato: boolean;            // k^ マルカート
  trill: boolean;              // k* トリル
  slurStart: boolean;          // 小文字音名 (a-g)
  slurEnd: boolean;            // _ サフィックス
  tieToNext: boolean;          // 直後に '+' があった
  tieFromPrev?: boolean;       // 自動タイ分割で前小節から繋がっている
  graceType?: 'grace' | 'acciaccatura'; // ~ 前打音 / ~~ 短前打音
  lyric?: string;              // 直後の歌詞文字列
  tupletMember?: HideTupletMemberInfo;
}

/** 休符トークン (Rk = 4分休符) */
export interface HideRestToken {
  kind: 'rest';
  durationUnits: HideUnit;     // 付点込み: Rk.=12u, Rk..=14u
  dots: number;                // 0=無し, 1=付点 (×1.5), 2=2重付点 (×1.75)
  staccato: boolean;
  tieToNext: boolean;
  tupletMember?: HideTupletMemberInfo;
}

/**
 * メタコマンドトークン ([T120][M3/4][K+2][KCm][1][2][P][1T][2B][3T8][B]等)
 *
 * v1.9 拡張: partSwitch に optional clef を持たせて `[1T]` `[2B]` `[3T8]` のような
 * 「パート宣言 + 譜表」構文をサポートする。単独 `[T]` `[B]` `[T8]` は partLabel を
 * 持たない "clefChange" 型で、現在のパートの譜表を切り替える。
 */
export interface HideMetaToken {
  kind: 'meta';
  type: 'tempo' | 'time' | 'key' | 'transpose' | 'partSwitch' | 'clefChange' | 'dynamics' | 'volta';
  bpm?: number;                    // [T120] → 120
  voltaNumber?: number;            // [V1] → 1, [V2] → 2
  timeNum?: number;                // [M3/4] → 3
  timeDen?: number;                // [M3/4] → 4
  keyFifths?: number;              // [KCm] → -3 (元曲の調変更)
  transposeSemitones?: number;     // [K+2] → 2 (半音シフト, v1.6)
  partLabel?: string;              // [1][2][P] → '1','2','P'  (v1.9: SATB は廃止)
  /** 強弱記号 [Dp] [Df] [Dff] [Dmf] 等 / ヘアピン [D<] [D>] [D/] */
  dynamics?: string;
  /**
   * 譜表 — partSwitch に付与された場合は「宣言時の譜表」、clefChange 単独の場合は
   * 「現在パートの譜表変更」。undefined は譜表指定なし。
   */
  clef?: HideClef;
}

/**
 * 小節線スタイル (v1.9 後期で導入された 5 種類のバーライン語彙)
 *
 *  - `single`     : `,`   通常の小節線 (MusicXML 暗黙)
 *  - `double`     : `,,`  複縦線 (light-light)
 *  - `final`      : `,,,` 終止線 (light-heavy)
 *  - `repeatStart`: `,:` 繰り返しスタート (heavy-light + repeat forward, 次の小節の左端)
 *  - `repeatEnd`  : `:,`  繰り返し終わり (light-heavy + repeat backward, 現在の小節の右端)
 */
export type HideBarlineStyle = 'single' | 'double' | 'final' | 'repeatStart' | 'repeatEnd';

/**
 * 小節終止マーカー (v1.9 後期)
 *
 * 「ここで小節を強制的に閉じる」hard barrier。bucketize が
 *   1. 現在の bucket を即 close (totalUnits != unitsPerMeasure なら warning)
 *   2. style に応じて bucket の右端 (single/double/final/repeatEnd) または
 *      次の小節の左端 (repeatStart) にバーライン情報を記録
 *   3. 新しい bucket を開始
 * という処理をする。`|` は引き続き whitespace 扱い (matrix mode の cell 区切り
 * としてのみ意味を持つ)。
 *
 * ソース表記: `,` `,,` `,,,` `,:` `:,`
 * (`.` は付点修飾子として使用: `k.` = 付点四分音符)
 *
 * forward (`compileHide`) / reverse (`musicXmlToHide`) / future PDF OMR の
 * 三者で一貫する end-of-measure マーカー。
 */
export interface HideMeasureBarrierToken {
  kind: 'measureBarrier';
  style: HideBarlineStyle;
}

/** 連符グループ N(...) — 中身は HideToken[] (実際にはノート/休符のみ) */
export interface HideTupletGroup {
  kind: 'tuplet';
  targetUnits: HideUnit;          // 8(...) → 8u
  members: (HideNoteToken | HideRestToken)[];
}

/** 反復グループ :body:N — ネスト可能 */
export interface HideRepeatGroup {
  kind: 'repeat';
  body: HideToken[];   // ネスト可能
  count: number;       // 合計演奏回数 (:2 → 2回)
}

/** トークンの union 型 */
export type HideToken =
  | HideNoteToken
  | HideRestToken
  | HideMetaToken
  | HideMeasureBarrierToken
  | HideTupletGroup
  | HideRepeatGroup;

// ============================================================
// AST (パース結果のルート)
// ============================================================

export interface HideAst {
  header: HideHeader;
  body: HideToken[];   // 反復未展開・パート未分離の生のトークン列
}

// ============================================================
// パート分離後の中間表現 (Expander の出力)
// ============================================================

/** 1パート分のフラットなトークン列 (反復展開済み) */
export interface HidePart {
  label: string;             // '1','2',...,'N','P'
  displayName: string;       // 'Voice 1','Voice 2',...,'Voice Percussion'
  partId: string;            // MusicXML の <score-part id="..."> に使う
  midiProgram: number;       // GM音色番号 (Voice Oohs = 53)
  tokens: (HideNoteToken | HideRestToken | HideMetaToken | HideMeasureBarrierToken)[];
}

export interface HidePartitionedAst {
  header: HideHeader;
  parts: HidePart[];
}

// ============================================================
// コンパイル結果
// ============================================================

export interface HideCompileOptions {
  title?: string;
  composer?: string;
  lyricist?: string;
}

export interface HideCompileResult {
  musicXml: string;
  warnings: string[];
  partsCount: number;
  measuresCount: number;
}

// ============================================================
// 長さエイリアス → unit 変換テーブル
// ============================================================

/**
 * 長さ文字 (h-m) → unit 数 (DIV=32 時の基本値)
 *  h=1 (32分), i=2 (16分), j=4 (8分), k=8 (4分), l=16 (2分), m=32 (全)
 *  大文字は同じ unit でスタッカート
 *
 *  DIV != 32 の場合は (DIV / 32) 倍にスケールする (getLengthUnits 参照)
 */
export const LENGTH_ALIAS_TO_UNITS: Record<string, number> = {
  h: 1, i: 2, j: 4, k: 8, l: 16, m: 32,
  H: 1, I: 2, J: 4, K: 8, L: 16, M: 32,
};

/**
 * 長さ文字を DIV に応じてスケールしたユニット数に変換する。
 *  DIV=32 → そのまま (h=1, k=8, m=32)
 *  DIV=64 → 2倍 (h=2, k=16, m=64)
 *  DIV=16 → 0.5倍 (h=0.5 = エラー、最低1にクランプ)
 */
export function getLengthUnits(lengthChar: string, div: number): number {
  const base = LENGTH_ALIAS_TO_UNITS[lengthChar];
  if (base === undefined) return 0;
  if (div === 32) return base;
  const scaled = (base * div) / 32;
  // 整数化 (DIV が 32 の倍数/約数なら正確)
  return Math.round(scaled);
}

/** 音名 → MusicXML step 用大文字化 */
export const NOTE_STEP_NORMALIZE: Record<string, HidePitch['step']> = {
  a: 'A', b: 'B', c: 'C', d: 'D', e: 'E', f: 'F', g: 'G',
  A: 'A', B: 'B', C: 'C', D: 'D', E: 'E', F: 'F', G: 'G',
};

/** パートラベル → 表示名・MIDI音色マップ */
export interface PartMeta {
  partId: string;
  displayName: string;
  midiProgram: number;
}

/**
 * 固定パートラベルのメタ情報。
 *  - P: アカペラの voice percussion (ボイパ) — 物理的には人声なので midiProgram は voice と同じ 53
 *
 * 番号付きパート [1][2]... は getPartMeta() で動的生成する。
 * 旧 SATB 固定ラベル [S][A][T][B] は v1.9 で廃止。
 */
export const PART_LABEL_META: Record<string, PartMeta> = {
  P: { partId: 'P_VP', displayName: 'Voice Percussion', midiProgram: 53 },
};

/**
 * パートラベルからメタ情報を生成する。
 *
 *  - "P": Voice Percussion (PART_LABEL_META から)
 *  - "1".."N": 任意人数アカペラの番号付きボーカルパート → "Voice N"
 *  - その他: ラベル文字列そのものを表示名にする (フォールバック)
 */
export function getPartMeta(label: string): PartMeta {
  if (PART_LABEL_META[label]) return PART_LABEL_META[label];
  // [1] [2] ... [N] = 任意人数アカペラの番号付きボーカルパート
  if (/^\d+$/.test(label)) {
    return { partId: `P_V${label}`, displayName: `Voice ${label}`, midiProgram: 53 };
  }
  // unknown label fallback
  return { partId: `P_${label}`, displayName: label, midiProgram: 53 };
}
