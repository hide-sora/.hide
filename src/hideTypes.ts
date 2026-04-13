/**
 * hideTypes.ts — .hide v2.0 楽譜記述言語の AST 型定義
 *
 * v2.0 破壊的変更:
 *  - 臨時記号: s → #, n → * (ナチュラル), x (ダブルシャープ), bb (ダブルフラット)
 *  - 音価: g-n の8段階 (g=64分, n=倍全)
 *  - DIV デフォルト: 32 → 64
 *  - staccato: 大文字音価 → s サフィックス
 *  - Rule B 廃止: 毎回絶対音高
 *  - 前打音: ~ → ` バックティック
 *  - トリル: * → tr サフィックス
 *  - ブロックコメント: \/* ... *\/
 */

// ============================================================
// ヘッダー
// ============================================================

/**
 * 譜表記号 (v2.0: SOPRANO, BARITONE 追加)
 */
export type HideClef =
  | 'TREBLE'
  | 'TREBLE_8VA'
  | 'TREBLE_8VB'
  | 'BASS'
  | 'ALTO'
  | 'TENOR'
  | 'PERCUSSION'
  | 'SOPRANO'
  | 'BARITONE';

/** ヘッダーで宣言される全体設定 */
export interface HideHeader {
  clef: HideClef;
  timeNum: number;
  timeDen: number;
  keyFifths: number;
  div: number;
  transposeSemitones: number;
  partClefs: Record<string, HideClef>;
}

export const HIDE_HEADER_DEFAULT: HideHeader = {
  clef: 'TREBLE',
  timeNum: 4,
  timeDen: 4,
  keyFifths: 0,
  div: 64,           // v2.0: 32 → 64
  transposeSemitones: 0,
  partClefs: {},
};

export function createDefaultHeader(): HideHeader {
  return { ...HIDE_HEADER_DEFAULT, partClefs: {} };
}

// ============================================================
// 音符・休符の構成要素
// ============================================================

/**
 * 1音(1ピッチ)。和音は HideNoteToken.pitches に複数を持つ。
 *
 * v2.0: alter は -2..+2 に拡張 (ダブルシャープ/ダブルフラット対応)
 *       accidentalExplicit 廃止 (Rule B 廃止)
 */
export interface HidePitch {
  step: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  octave: number;
  alter: -2 | -1 | 0 | 1 | 2;
}

export interface HideTupletMemberInfo {
  groupId: number;
  memberIndex: number;
  totalMembers: number;
  targetUnits: number;
  normalNotes: number;
}

export type HideUnit = number;

// ============================================================
// トークン
// ============================================================

/**
 * 音符トークン (v2.0)
 *
 * アーティキュレーション: サフィックス方式に統一
 *   s=staccato, S=staccatissimo, >=accent, ^=marcato, -=tenuto, ~=fermata
 *
 * オーナメント: 2文字サフィックス
 *   tr=trill, mr=mordent, tn=turn, z1/z2/z3=tremolo, ar=arpeggio, gl=glissando
 */
export interface HideNoteToken {
  kind: 'note';
  pitches: HidePitch[];
  durationUnits: HideUnit;
  dots: number;                // 0-3 (v2.0: 三重付点対応)
  // Articulations (suffix)
  staccato: boolean;           // s
  staccatissimo: boolean;      // S (v2.0 新規)
  accent: boolean;             // >
  tenuto: boolean;             // -
  fermata: boolean;            // ~
  marcato: boolean;            // ^
  // Ornaments (2-char suffix)
  trill: boolean;              // tr
  mordent: boolean;            // mr (v2.0 新規)
  turn: boolean;               // tn (v2.0 新規)
  tremolo: 0 | 1 | 2 | 3;     // z1/z2/z3 (v2.0 新規) 0=none
  arpeggio: boolean;           // ar (v2.0 新規)
  glissando: boolean;          // gl (v2.0 新規)
  // Connections
  slurStart: boolean;          // 小文字音名
  slurEnd: boolean;            // _ サフィックス
  tieToNext: boolean;          // +
  tieFromPrev?: boolean;       // 自動タイ分割
  // Grace note
  graceType?: 'grace' | 'acciaccatura'; // ` / ``
  // Lyrics
  lyric?: string;
  // Tuplet
  tupletMember?: HideTupletMemberInfo;
}

/** 休符トークン */
export interface HideRestToken {
  kind: 'rest';
  durationUnits: HideUnit;
  dots: number;
  tieToNext: boolean;
  tupletMember?: HideTupletMemberInfo;
}

/**
 * メタコマンドトークン (v2.0: 大幅拡張)
 *
 * 新タイプ: segno, coda, jump, rehearsal, text, expr, breath,
 *          caesura, ottava, pedal, chord, measureRepeat
 */
export interface HideMetaToken {
  kind: 'meta';
  type:
    | 'tempo'
    | 'tempoText'       // v2.0: [T:Allegro] [T:rit] etc.
    | 'time'
    | 'key'
    | 'transpose'
    | 'partSwitch'
    | 'clefChange'
    | 'dynamics'
    | 'volta'
    | 'voltaEnd'         // v2.0: [/V1] [/V2] — volta bracket close
    | 'segno'            // v2.0: [segno]
    | 'coda'             // v2.0: [coda]
    | 'jump'             // v2.0: [DC] [DS] [DC.fine] etc.
    | 'fine'             // v2.0: [fine]
    | 'tocoda'           // v2.0: [tocoda]
    | 'rehearsal'        // v2.0: [R:A]
    | 'text'             // v2.0: [text:...]
    | 'expression'       // v2.0: [expr:...]
    | 'breath'           // v2.0: [breath]
    | 'caesura'          // v2.0: [caesura]
    | 'ottava'           // v2.0: [8va] [8vb] [15ma] [15mb] [8va/] etc.
    | 'pedal'            // v2.0: [ped] [ped/]
    | 'chord'            // v2.0: [C:Cmaj7]
    | 'measureRepeat';   // v2.0: [%]
  // tempo
  bpm?: number;
  // tempoText
  tempoText?: string;          // "Allegro", "rit", "accel", "atempo"
  // volta
  voltaNumber?: number;
  // time
  timeNum?: number;
  timeDen?: number;
  // key
  keyFifths?: number;
  // transpose
  transposeSemitones?: number;
  // partSwitch
  partLabel?: string;
  instrumentName?: string;     // v2.0: [1:Piano] → "Piano"
  // dynamics
  dynamics?: string;
  // clef
  clef?: HideClef;
  // jump
  jumpType?: 'DC' | 'DC.fine' | 'DC.coda' | 'DS' | 'DS.fine' | 'DS.coda';
  // rehearsal
  rehearsalMark?: string;      // "A", "B", "1", "2" ...
  // text / expression
  textContent?: string;
  // ottava
  ottavaType?: '8va' | '8vb' | '15ma' | '15mb';
  ottavaEnd?: boolean;         // true for [8va/] etc.
  // pedal
  pedalEnd?: boolean;          // true for [ped/]
  // chord symbol
  chordSymbol?: string;        // "Cmaj7", "Am7", "G7/B"
}

/**
 * 小節線スタイル (v2.0: dashed, invisible 追加)
 */
export type HideBarlineStyle =
  | 'single'
  | 'double'
  | 'final'
  | 'repeatStart'
  | 'repeatEnd'
  | 'dashed'       // v2.0: ,-
  | 'invisible';   // v2.0: ,.

export interface HideMeasureBarrierToken {
  kind: 'measureBarrier';
  style: HideBarlineStyle;
}

/** 連符グループ N(...) */
export interface HideTupletGroup {
  kind: 'tuplet';
  targetUnits: HideUnit;
  members: (HideNoteToken | HideRestToken)[];
}

/** 反復グループ :body:N */
export interface HideRepeatGroup {
  kind: 'repeat';
  body: HideToken[];
  count: number;
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
// AST
// ============================================================

export interface HideAst {
  header: HideHeader;
  body: HideToken[];
}

// ============================================================
// パート分離後の中間表現
// ============================================================

export interface HidePart {
  label: string;
  displayName: string;
  partId: string;
  midiProgram: number;
  instrumentName?: string;     // v2.0: [1:Piano] から
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
// 長さエイリアス → unit 変換テーブル (v2.0: g-n の8段階)
// ============================================================

/**
 * 長さ文字 → unit 数 (DIV=64 時の基本値)
 *  g=1 (64分), h=2 (32分), i=4 (16分), j=8 (8分),
 *  k=16 (4分), l=32 (2分), m=64 (全), n=128 (倍全)
 *
 * v2.0: 音価文字は case-insensitive (大文字=staccato は廃止)
 */
export const LENGTH_ALIAS_TO_UNITS: Record<string, number> = {
  g: 1, h: 2, i: 4, j: 8, k: 16, l: 32, m: 64, n: 128,
  G: 1, H: 2, I: 4, J: 8, K: 16, L: 32, M: 64, N: 128,
};

/**
 * 長さ文字を DIV に応じてスケールしたユニット数に変換する。
 *  DIV=64  → そのまま (g=1, k=16, m=64)
 *  DIV=128 → 2倍 (g=2, k=32, m=128)
 */
export function getLengthUnits(lengthChar: string, div: number): number {
  const base = LENGTH_ALIAS_TO_UNITS[lengthChar];
  if (base === undefined) return 0;
  if (div === 64) return base;
  const scaled = (base * div) / 64;
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

export const PART_LABEL_META: Record<string, PartMeta> = {
  P: { partId: 'P_VP', displayName: 'Voice Percussion', midiProgram: 53 },
};

/**
 * パートラベルからメタ情報を生成する (v2.0: instrumentName サポート)
 */
export function getPartMeta(label: string, instrumentName?: string): PartMeta {
  if (PART_LABEL_META[label]) return PART_LABEL_META[label];
  if (/^\d+$/.test(label)) {
    const displayName = instrumentName || `Voice ${label}`;
    return { partId: `P_V${label}`, displayName, midiProgram: 53 };
  }
  return { partId: `P_${label}`, displayName: instrumentName || label, midiProgram: 53 };
}
