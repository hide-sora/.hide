/**
 * hideChordAnalyzer.ts — 拡張コード分析モジュール (外部)
 *
 * .hide core の hideChord.ts (basic triad/seventh) の上に乗る
 * リッチな分析レイヤー。.hide 標準には含めず、外部モジュールとして提供。
 *
 * 機能:
 *  - beat 単位 + note-onset 単位の時間分解コード分析
 *  - 拡張コードテンプレート (sus4, sus2, 6, m6, 7sus4, aug7, add9, madd9)
 *  - 転回形の番号付け (第1/第2/第3転回)
 *  - ON コード検出 (バス音が構成音でない)
 *  - fill-5th: 省略された完全5度を補ってコード推定 → (o5) 表記
 *  - confidence/alternatives: 判定の確信度と代替解釈
 *  - progression context: 前後のコード進行から曖昧コードを解消
 *  - ローマ数字 (度数) 表記 (KEY ヘッダーから算出)
 *  - 複合表記 (Ⅲ7/E7)
 *  - [C] 行テキスト生成 (ChordName_Duration 記法)
 *
 * 記法:
 *  - コードトークン: `C_k` (C major 四分), `Cm7_l` (Cm7 二分)
 *  - `_` の左 = コード名 (root + quality), 右 = duration (h/i/j/k/l/m)
 *  - degree prefix: `Ⅰ/ C_m` (小節の構造 degree)
 *  - ON コード: `C/E_k` (C major with E bass, 四分)
 *  - ambiguous: `Am7~C6_k` (Am7 or C6, 四分)
 *  - omitted 5th: `CM7(o5)_m` (Cmaj7 with omitted 5th, 全音符)
 */

import type { HidePitch, HideToken, HideNoteToken } from './hideTypes';
import type { HideMatrix, HideMatrixCell, HideMatrixMeasure } from './hideMatrix';

// ============================================================
// 公開型
// ============================================================

/** 拡張和音種別 (core の ChordQuality + sus/6/add9 系) */
export type ChordQualityEx =
  | 'maj' | 'min' | 'dim' | 'aug'
  | 'maj7' | 'dom7' | 'min7' | 'm7b5' | 'dim7' | 'minMaj7'
  | 'sus4' | 'sus2' | '6' | 'm6' | '7sus4' | 'aug7'
  | 'add9' | 'madd9';

/** 拡張コードシンボル */
export interface ChordSymbol {
  /** 根音ピッチクラス名 ("C", "C#", "F#" etc.) */
  root: string;
  /** 和音種別 */
  quality: ChordQualityEx;
  /** 転回形 (0=基本形, 1=第1転回, 2=第2転回, 3=第3転回) */
  inversion: number;
  /** バス音のピッチクラス名 ("G" etc.) */
  bass: string;
  /** バスがコード構成音でない場合 true (ON コード) */
  isOnChord: boolean;
  /** キー内の度数 ("Ⅰ", "♭Ⅲ", "#Ⅳ" etc.) */
  degree: string;
  /** 絶対表記 ("C", "Cm7", "G7/F3", "C/D") — 転回形=/Bass+番号, ON=/Bassのみ */
  absolute: string;
  /** 度数表記 ("Ⅰ", "Ⅵm7") */
  relative: string;
  /** 複合表記 ("Ⅰ/C", "Ⅴ7/G7/F3") */
  combined: string;
  /** 判定の確信度 */
  confidence: 'definite' | 'likely' | 'ambiguous' | 'incomplete';
  /** 代替解釈 (ambiguous 時に提示) */
  alternatives: ChordSymbol[];
  /** 5th 省略推定で復元した場合 true */
  omittedFifth: boolean;
}

/** Note-onset 時点のスナップショット */
export interface OnsetSnapshot {
  /** 小節内の unit オフセット (0-based) */
  offsetUnits: number;
  /** この時点の全パート鳴音 */
  pitches: HidePitch[];
  /** コード判定結果 */
  chord: ChordSymbol | null;
}

/** Beat 単位の分析結果 */
export interface BeatAnalysis {
  /** Beat インデックス (0-based) */
  beatIndex: number;
  /** この beat の代表コード (beat 先頭の和音) */
  primary: ChordSymbol | null;
  /** この beat 内の note-onset ごとの経過和音 */
  onsets: OnsetSnapshot[];
}

/** 小節単位の分析結果 */
export interface MeasureAnalysis {
  /** 小節インデックス (0-based) */
  measureIndex: number;
  /** Beat 単位の分析 */
  beats: BeatAnalysis[];
  /** この小節の代表コード (beat 1 のコード) */
  summary: ChordSymbol | null;
  /** [C] セルテキスト ("Ⅰ/ C_l Am7_l") */
  cellText: string;
}

/** 全体の分析結果 */
export interface ChordAnalysisResult {
  /** 小節ごとの分析 */
  measures: MeasureAnalysis[];
  /** キーの根音名 */
  keyRoot: string;
  /** KEY ヘッダー値 (fifths) */
  keyFifths: number;
}

// ============================================================
// 定数
// ============================================================

const SEMITONE_NAMES = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
] as const;

const STEP_TO_SEMITONE: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

/**
 * 半音インターバル → 度数名 (ポップ慣習: 常に大文字ローマ数字 + accidental)
 * index = (chordRoot - keyRoot) mod 12
 */
const DEGREE_NAMES = [
  'Ⅰ', '♭Ⅱ', 'Ⅱ', '♭Ⅲ', 'Ⅲ', 'Ⅳ', '#Ⅳ', 'Ⅴ', '♭Ⅵ', 'Ⅵ', '♭Ⅶ', 'Ⅶ',
];

/** ポップ記法での quality 表示 */
const QUALITY_DISPLAY: Record<ChordQualityEx, string> = {
  'maj': '', 'min': 'm', 'dim': 'dim', 'aug': 'aug',
  'maj7': 'M7', 'dom7': '7', 'min7': 'm7', 'm7b5': 'm7b5',
  'dim7': 'dim7', 'minMaj7': 'mM7',
  'sus4': 'sus4', 'sus2': 'sus2', '6': '6', 'm6': 'm6',
  '7sus4': '7sus4', 'aug7': 'aug7',
  'add9': 'add9', 'madd9': 'madd9',
};

/** 三和音テンプレート (拡張) */
const TRIAD_TEMPLATES: { quality: ChordQualityEx; intervals: number[] }[] = [
  { quality: 'maj',  intervals: [0, 4, 7] },
  { quality: 'min',  intervals: [0, 3, 7] },
  { quality: 'sus4', intervals: [0, 5, 7] },
  { quality: 'sus2', intervals: [0, 2, 7] },
  { quality: 'dim',  intervals: [0, 3, 6] },
  { quality: 'aug',  intervals: [0, 4, 8] },
];

/** 四和音テンプレート (拡張: 6/m6 → 7th 系 → add9 系) */
const FOUR_NOTE_TEMPLATES: { quality: ChordQualityEx; intervals: number[] }[] = [
  { quality: '6',       intervals: [0, 4, 7, 9] },
  { quality: 'm6',      intervals: [0, 3, 7, 9] },
  { quality: 'maj7',    intervals: [0, 4, 7, 11] },
  { quality: 'dom7',    intervals: [0, 4, 7, 10] },
  { quality: 'min7',    intervals: [0, 3, 7, 10] },
  { quality: 'm7b5',    intervals: [0, 3, 6, 10] },
  { quality: 'dim7',    intervals: [0, 3, 6, 9] },
  { quality: 'minMaj7', intervals: [0, 3, 7, 11] },
  { quality: '7sus4',   intervals: [0, 5, 7, 10] },
  { quality: 'aug7',    intervals: [0, 4, 8, 10] },
  { quality: 'add9',    intervals: [0, 2, 4, 7] },
  { quality: 'madd9',   intervals: [0, 2, 3, 7] },
];

/** 七の和音 quality (構造的に優先される) */
const SEVENTH_QUALITIES: ChordQualityEx[] = [
  'maj7', 'dom7', 'min7', 'm7b5', 'dim7', 'minMaj7', 'aug7',
];

// ============================================================
// 公開 API
// ============================================================

/**
 * Matrix 全体をコード分析する。
 *
 * 1st pass: 各小節を独立にコード分析 (beat/onset 単位)
 * 2nd pass: 前後のコード進行コンテキストから ambiguous コードを解消
 *
 * @param matrix analyzeMatrix() の出力
 * @returns beat 単位 / onset 単位の分析 + [C] セルテキスト
 */
export function analyzeChords(matrix: HideMatrix): ChordAnalysisResult {
  const keyFifths = matrix.header.keyFifths;
  const keyRootPc = fifthsToKeyRoot(keyFifths);
  const keyRoot = SEMITONE_NAMES[keyRootPc];
  const div = matrix.header.div;
  const timeDen = matrix.header.timeDen;
  const unitsPerBeat = Math.round(div / timeDen);

  // 1st pass: 各小節を独立に分析
  const measures: MeasureAnalysis[] = [];
  for (const m of matrix.measures) {
    measures.push(analyzeMeasure(matrix, m, keyRootPc, unitsPerBeat, div));
  }

  // 2nd pass: progression context で ambiguous を解消
  resolveProgression(measures, keyRootPc, unitsPerBeat, div);

  return { measures, keyRoot, keyFifths };
}

/**
 * ピッチ配列を拡張コードとして分類する。
 *
 * hideChord.ts の classifyChord を拡張し、以下を追加:
 *  - sus4/sus2/6/m6/7sus4/aug7/add9/madd9 テンプレート
 *  - 転回形番号付け (0-3)
 *  - ON コード検出 (バス非構成音)
 *  - fill-5th: 省略された完全5度を補って四和音マッチ
 *  - confidence/alternatives: 判定確信度と代替解釈
 *  - ローマ数字度数 (keyRootPc 基準)
 *  - 5+ ピッチクラスの縮約マッチ
 *
 * @param pitches ある時刻の全鳴音
 * @param keyRootPc キーの根音ピッチクラス (fifthsToKeyRoot で算出)
 */
export function classifyChordEx(
  pitches: HidePitch[],
  keyRootPc: number,
): ChordSymbol | null {
  if (pitches.length === 0) return null;

  // バス (実音最低)
  const bassPitch = findLowestPitch(pitches);
  const bassPc = pitchToSemitone(bassPitch);

  // distinct pitch class set (sorted)
  const pcSet = uniqueSortedPcSet(pitches);
  if (pcSet.length < 2) return null;

  // 3-4 pc: 直接マッチ (全候補を収集して confidence 判定)
  if (pcSet.length >= 3 && pcSet.length <= 4) {
    const all = matchPcSetAll(pcSet, bassPc, keyRootPc);
    if (all.length > 0) {
      const confidence = all.length === 1 ? 'definite' : 'ambiguous' as const;
      return withConfidence(all[0], all.slice(1), confidence);
    }
  }

  // 5+ pc: 1音ずつ除いて 4pc にマッチ (7th 優先)
  if (pcSet.length >= 5) {
    const result = tryReduceToFour(pcSet, bassPc, keyRootPc);
    if (result) return withConfidence(result, [], 'likely');
  }

  // fill-5th: 3pc で三和音不一致 → 完全5度を補って四和音マッチ
  if (pcSet.length === 3) {
    const result = tryFillFifth(pcSet, bassPc, keyRootPc);
    if (result) return result; // confidence = 'incomplete', omittedFifth = true
  }

  // ON コード: バスを除いて残りでマッチ (reduce-to-3 より優先)
  if (pcSet.length >= 3) {
    const result = tryOnChord(pcSet, bassPc, keyRootPc);
    if (result) return withConfidence(result, [], 'likely');
  }

  // 4+ pc で 4pc 不一致: 1音除いて 3pc にマッチ (最終手段)
  if (pcSet.length >= 4) {
    const result = tryReduceToThree(pcSet, bassPc, keyRootPc);
    if (result) return withConfidence(result, [], 'likely');
  }

  // dyad (2 pc): パワーコード検出 (完全5度 = interval 7)
  if (pcSet.length === 2) {
    const interval = ((pcSet[1] - pcSet[0]) % 12 + 12) % 12;
    if (interval === 7) {
      const sym = buildChordSymbol(pcSet[0], 'maj', bassPc, [0, 7], keyRootPc, false);
      return withConfidence(sym, [], 'incomplete');
    }
  }

  return null;
}

/**
 * [C] 行テキストを生成する。
 *
 * @returns `[C]| Ⅰ/ C_m | Ⅴ7/ G7_l Am_l | ...` 形式の文字列
 */
export function formatCRow(result: ChordAnalysisResult, matrix: HideMatrix): string {
  const cells = result.measures.map(m => ` ${m.cellText} `);
  return `[C]|${cells.join('|')}|`;
}

// ============================================================
// 内部: 拡張コード分類
// ============================================================

/**
 * pcSet をテンプレートにマッチさせ、全候補を返す。バス優先ルート解決。
 */
function matchPcSetAll(
  pcSet: number[],
  bassPc: number,
  keyRootPc: number,
): ChordSymbol[] {
  const templates = pcSet.length === 3 ? TRIAD_TEMPLATES : FOUR_NOTE_TEMPLATES;
  const rootCandidates = [bassPc, ...pcSet.filter(p => p !== bassPc)];
  const results: ChordSymbol[] = [];
  const seen = new Set<string>();

  for (const root of rootCandidates) {
    const rotated = pcSet
      .map(x => ((x - root) % 12 + 12) % 12)
      .sort((a, b) => a - b);
    for (const tpl of templates) {
      if (intervalsEqual(rotated, tpl.intervals)) {
        const sym = buildChordSymbol(root, tpl.quality, bassPc, tpl.intervals, keyRootPc, false);
        const key = `${sym.root}:${sym.quality}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push(sym);
        }
      }
    }
  }
  return results;
}

/**
 * pcSet をテンプレートにマッチさせる。最初の一致を返す。
 */
function matchPcSet(
  pcSet: number[],
  bassPc: number,
  keyRootPc: number,
): ChordSymbol | null {
  const all = matchPcSetAll(pcSet, bassPc, keyRootPc);
  return all.length > 0 ? all[0] : null;
}

/** 5+ pc → 非バス音を1つずつ除いて 4pc マッチを試行 (7th 優先) */
function tryReduceToFour(
  pcSet: number[],
  bassPc: number,
  keyRootPc: number,
): ChordSymbol | null {
  const candidates: ChordSymbol[] = [];
  // 高い音から除去を試行 (テンションは高音に多い)
  for (let i = pcSet.length - 1; i >= 0; i--) {
    if (pcSet[i] === bassPc) continue;
    const reduced = [...pcSet.slice(0, i), ...pcSet.slice(i + 1)];
    if (reduced.length === 4) {
      const result = matchPcSet(reduced, bassPc, keyRootPc);
      if (result) candidates.push(result);
    }
  }
  if (candidates.length === 0) return null;
  // 根音位置の7th を優先 (Cmaj9 → Cmaj7 > Cadd9)
  const rootPos7th = candidates.find(
    c => c.inversion === 0 && SEVENTH_QUALITIES.includes(c.quality),
  );
  if (rootPos7th) return rootPos7th;
  const rootPos = candidates.find(c => c.inversion === 0);
  if (rootPos) return rootPos;
  return candidates[0];
}

/** 4+ pc → 非バス音を1つずつ除いて 3pc マッチを試行 */
function tryReduceToThree(
  pcSet: number[],
  bassPc: number,
  keyRootPc: number,
): ChordSymbol | null {
  for (let i = pcSet.length - 1; i >= 0; i--) {
    if (pcSet[i] === bassPc) continue;
    const reduced = [...pcSet.slice(0, i), ...pcSet.slice(i + 1)];
    if (reduced.length === 3) {
      const result = matchPcSet(reduced, bassPc, keyRootPc);
      if (result) return result;
    }
    // 2つ除去 (5pc → 3pc)
    if (reduced.length > 3) {
      for (let j = reduced.length - 1; j >= 0; j--) {
        if (reduced[j] === bassPc) continue;
        const r2 = [...reduced.slice(0, j), ...reduced.slice(j + 1)];
        if (r2.length === 3) {
          const result = matchPcSet(r2, bassPc, keyRootPc);
          if (result) return result;
        }
      }
    }
  }
  return null;
}

/** ON コード: バスを除いて残りでマッチし、バスを ON 表記に */
function tryOnChord(
  pcSet: number[],
  bassPc: number,
  keyRootPc: number,
): ChordSymbol | null {
  const withoutBass = pcSet.filter(pc => pc !== bassPc);
  if (withoutBass.length < 3 || withoutBass.length > 4) return null;
  // バスなしでマッチ (ルート候補はバスなしの最低音優先)
  const result = matchPcSet(withoutBass, withoutBass[0], keyRootPc);
  if (!result) return null;
  // ON コードとして再構築
  return buildChordSymbol(
    SEMITONE_NAMES.indexOf(result.root as typeof SEMITONE_NAMES[number]),
    result.quality,
    bassPc,
    getTemplateIntervals(result.quality),
    keyRootPc,
    true,
  );
}

/**
 * fill-5th: 3pc で三和音テンプレートに不一致の場合、
 * 各 pc を root 候補として完全5度 (root+7) を補い四和音マッチを試みる。
 * 成功時は (o5) 付き・confidence='incomplete' で返す。
 */
function tryFillFifth(
  pcSet: number[],
  bassPc: number,
  keyRootPc: number,
): ChordSymbol | null {
  const rootCandidates = [bassPc, ...pcSet.filter(p => p !== bassPc)];
  for (const root of rootCandidates) {
    const fifth = (root + 7) % 12;
    if (pcSet.includes(fifth)) continue; // 5th already present
    const extended = [...pcSet, fifth].sort((a, b) => a - b);
    const rotated = extended
      .map(x => ((x - root) % 12 + 12) % 12)
      .sort((a, b) => a - b);
    for (const tpl of FOUR_NOTE_TEMPLATES) {
      if (intervalsEqual(rotated, tpl.intervals)) {
        const sym = buildChordSymbol(root, tpl.quality, bassPc, tpl.intervals, keyRootPc, false);
        sym.omittedFifth = true;
        sym.confidence = 'incomplete';
        // (o5) を absolute に付加
        const qDisplay = QUALITY_DISPLAY[sym.quality];
        const rootName = SEMITONE_NAMES[root];
        const bassName = SEMITONE_NAMES[bassPc];
        const absBase = rootName + qDisplay + '(o5)';
        if (bassPc === root) {
          sym.absolute = absBase;
        } else if (sym.isOnChord) {
          sym.absolute = `${absBase}/${bassName}`;
        } else {
          sym.absolute = `${absBase}/${bassName}${sym.inversion}`;
        }
        sym.combined = `${sym.relative}/${sym.absolute}`;
        return sym;
      }
    }
  }
  return null;
}

// ============================================================
// 内部: confidence ヘルパー
// ============================================================

/** ChordSymbol に confidence と alternatives を設定する */
function withConfidence(
  primary: ChordSymbol,
  alternatives: ChordSymbol[],
  confidence: ChordSymbol['confidence'],
): ChordSymbol {
  primary.confidence = confidence;
  primary.alternatives = alternatives;
  for (const alt of alternatives) {
    alt.confidence = confidence;
    alt.alternatives = [];
  }
  return primary;
}

// ============================================================
// 内部: progression context (2nd pass)
// ============================================================

/**
 * 2nd pass: 前後のコード進行コンテキストから ambiguous コードを解消する。
 *
 * ヒューリスティック:
 * 1. 5度下行 (circle progression): 左→自→右 が 5度下行なら +3
 * 2. 5度上行: +2
 * 3. ステップモーション (2度): +1
 * 4. ダイアトニック適合: +1
 */
function resolveProgression(
  measures: MeasureAnalysis[],
  keyRootPc: number,
  unitsPerBeat: number,
  div: number,
): void {
  for (let i = 0; i < measures.length; i++) {
    const m = measures[i];
    if (!m.summary || m.summary.confidence !== 'ambiguous' || m.summary.alternatives.length === 0) continue;

    const left = i > 0 ? measures[i - 1].summary : null;
    const right = i < measures.length - 1 ? measures[i + 1].summary : null;

    // コンテキストがなければ解消不能
    if (!left && !right) continue;

    const candidates = [m.summary, ...m.summary.alternatives];
    let bestScore = -Infinity;
    let bestIdx = 0;

    for (let ci = 0; ci < candidates.length; ci++) {
      const c = candidates[ci];
      const rootPc = SEMITONE_NAMES.indexOf(c.root as typeof SEMITONE_NAMES[number]);
      let score = 0;

      // 左隣からの根音移動を評価
      if (left) {
        const leftPc = SEMITONE_NAMES.indexOf(left.root as typeof SEMITONE_NAMES[number]);
        const interval = ((rootPc - leftPc) % 12 + 12) % 12;
        if (interval === 5) score += 3;  // 5度下行 (最も自然)
        if (interval === 7) score += 2;  // 5度上行
        if (interval === 2 || interval === 10) score += 1; // ステップ
      }

      // 右隣への根音移動を評価
      if (right) {
        const rightPc = SEMITONE_NAMES.indexOf(right.root as typeof SEMITONE_NAMES[number]);
        const interval = ((rightPc - rootPc) % 12 + 12) % 12;
        if (interval === 5) score += 3;  // 右へ5度下行
        if (interval === 7) score += 2;  // 右へ5度上行
        if (interval === 2 || interval === 10) score += 1;
      }

      // ダイアトニック適合
      if (isDiatonic(rootPc, c.quality, keyRootPc)) score += 1;

      if (score > bestScore) {
        bestScore = score;
        bestIdx = ci;
      }
    }

    // スコアが正で、かつ最良候補が現在の primary と異なる場合のみ解消
    if (bestIdx !== 0 && bestScore > 0) {
      const best = candidates[bestIdx];
      const newAlternatives = candidates.filter((_, idx) => idx !== bestIdx);

      // summary を差し替え
      m.summary = withConfidence({ ...best }, newAlternatives, 'likely');

      // beat/onset レベルも更新 (ambiguous だったものを差し替え)
      for (const beat of m.beats) {
        if (beat.primary && beat.primary.confidence === 'ambiguous') {
          beat.primary = m.summary;
        }
        for (let oi = 0; oi < beat.onsets.length; oi++) {
          if (beat.onsets[oi].chord && beat.onsets[oi].chord!.confidence === 'ambiguous') {
            beat.onsets[oi].chord = m.summary;
          }
        }
      }

      // cellText を再生成
      m.cellText = buildCellText(m.beats, m.summary, unitsPerBeat, div);
    }
  }
}

/** メジャーキーのダイアトニックコード判定 */
function isDiatonic(rootPc: number, quality: ChordQualityEx, keyRootPc: number): boolean {
  const degree = ((rootPc - keyRootPc) % 12 + 12) % 12;
  const diatonic: Record<number, ChordQualityEx[]> = {
    0:  ['maj', 'maj7', 'add9'],       // I
    2:  ['min', 'min7', 'madd9'],      // ii
    4:  ['min', 'min7'],               // iii
    5:  ['maj', 'maj7', 'add9'],       // IV
    7:  ['maj', 'dom7'],               // V
    9:  ['min', 'min7', 'madd9'],      // vi
    11: ['dim', 'm7b5'],              // vii
  };
  const allowed = diatonic[degree];
  return allowed ? allowed.includes(quality) : false;
}

// ============================================================
// 内部: ChordSymbol 構築
// ============================================================

/** ChordSymbol を組み立てる */
function buildChordSymbol(
  rootPc: number,
  quality: ChordQualityEx,
  bassPc: number,
  intervals: number[],
  keyRootPc: number,
  isOnChord: boolean,
): ChordSymbol {
  const rootName = SEMITONE_NAMES[rootPc];
  const bassName = SEMITONE_NAMES[bassPc];
  const qDisplay = QUALITY_DISPLAY[quality];

  // 転回形
  let inversion = 0;
  if (!isOnChord) {
    const bassInterval = ((bassPc - rootPc) % 12 + 12) % 12;
    const idx = intervals.indexOf(bassInterval);
    inversion = idx >= 0 ? idx : 0;
  }

  // 度数
  const degreeInterval = ((rootPc - keyRootPc) % 12 + 12) % 12;
  const degree = DEGREE_NAMES[degreeInterval];

  // 絶対表記: 基本形=ChordName, 転回形=ChordName/Bass+番号, ON=ChordName/Bass
  const absBase = rootName + qDisplay;
  let absolute: string;
  if (bassPc === rootPc) {
    absolute = absBase;
  } else if (isOnChord) {
    absolute = `${absBase}/${bassName}`;
  } else {
    absolute = `${absBase}/${bassName}${inversion}`;
  }

  // 度数表記
  const relative = degree + qDisplay;

  // 複合表記
  const combined = `${relative}/${absolute}`;

  return {
    root: rootName, quality, inversion, bass: bassName,
    isOnChord, degree, absolute, relative, combined,
    confidence: 'definite', alternatives: [], omittedFifth: false,
  };
}

/** quality → intervals テンプレートを引く */
function getTemplateIntervals(quality: ChordQualityEx): number[] {
  for (const t of TRIAD_TEMPLATES) {
    if (t.quality === quality) return t.intervals;
  }
  for (const t of FOUR_NOTE_TEMPLATES) {
    if (t.quality === quality) return t.intervals;
  }
  return [0, 4, 7]; // fallback: major triad
}

// ============================================================
// 内部: タイムライン構築
// ============================================================

/** 1パートの1小節内での音符イベント */
interface NoteEvent {
  startUnit: number;
  endUnit: number;
  pitches: HidePitch[];
}

/**
 * セルの body トークンからタイムラインを構築する。
 * タイ連結された同一ピッチは1つのイベントとして統合。
 */
function buildCellTimeline(cell: HideMatrixCell): NoteEvent[] {
  return buildBodyTimeline(cell.body, 0);
}

function buildBodyTimeline(body: HideToken[], startOffset: number): NoteEvent[] {
  const events: NoteEvent[] = [];
  let pos = startOffset;
  let tieActive = false;
  let prevPitches: HidePitch[] = [];

  for (const tok of body) {
    if (tok.kind === 'note') {
      const isTieContinuation =
        tieActive && hidePitchesEqual(prevPitches, tok.pitches);

      if (isTieContinuation && events.length > 0) {
        // タイ継続: 既存イベントの endUnit を延長
        events[events.length - 1].endUnit = pos + tok.durationUnits;
      } else {
        events.push({
          startUnit: pos,
          endUnit: pos + tok.durationUnits,
          pitches: tok.pitches.slice(),
        });
      }
      tieActive = tok.tieToNext;
      prevPitches = tok.pitches;
      pos += tok.durationUnits;
    } else if (tok.kind === 'rest') {
      tieActive = false;
      prevPitches = [];
      pos += tok.durationUnits;
    } else if (tok.kind === 'tuplet') {
      // 連符: 各メンバーの演奏時間を比例配分
      const totalWritten = tok.members.reduce((s, m) => s + m.durationUnits, 0);
      const scale = totalWritten > 0 ? tok.targetUnits / totalWritten : 1;
      for (const m of tok.members) {
        const played = Math.round(m.durationUnits * scale);
        if (m.kind === 'note') {
          events.push({ startUnit: pos, endUnit: pos + played, pitches: m.pitches.slice() });
        }
        pos += played;
      }
      tieActive = false;
      prevPitches = [];
    } else if (tok.kind === 'repeat') {
      const innerDur = computeBodyDuration(tok.body);
      const count = Math.max(1, Math.floor(tok.count));
      for (let i = 0; i < count; i++) {
        const inner = buildBodyTimeline(tok.body, pos);
        events.push(...inner);
        pos += innerDur;
      }
      tieActive = false;
      prevPitches = [];
    }
    // meta, measureBarrier は無視
  }
  return events;
}

/** body の総演奏時間 (反復・連符展開後) */
function computeBodyDuration(body: HideToken[]): number {
  let sum = 0;
  for (const tok of body) {
    if (tok.kind === 'note' || tok.kind === 'rest') sum += tok.durationUnits;
    else if (tok.kind === 'tuplet') sum += tok.targetUnits;
    else if (tok.kind === 'repeat') {
      sum += computeBodyDuration(tok.body) * Math.max(1, Math.floor(tok.count));
    }
  }
  return sum;
}

/**
 * 指定時点で鳴っているピッチを全パートから収集する。
 */
function collectSoundingPitches(
  timelines: Map<string, NoteEvent[]>,
  timePoint: number,
  partLabels: string[],
): HidePitch[] {
  const out: HidePitch[] = [];
  for (const label of partLabels) {
    if (label === 'P' || label === 'C') continue;
    const events = timelines.get(label);
    if (!events) continue;
    for (const e of events) {
      if (e.startUnit <= timePoint && e.endUnit > timePoint) {
        for (const p of e.pitches) out.push(p);
      }
    }
  }
  return out;
}

// ============================================================
// 内部: 小節分析
// ============================================================

function analyzeMeasure(
  matrix: HideMatrix,
  measure: HideMatrixMeasure,
  keyRootPc: number,
  unitsPerBeat: number,
  div: number,
): MeasureAnalysis {
  // 1. 全ピッチパートのタイムライン構築
  const timelines = new Map<string, NoteEvent[]>();
  for (const label of matrix.partLabels) {
    if (label === 'P' || label === 'C') continue;
    const cell = measure.cells.get(label);
    if (cell) timelines.set(label, buildCellTimeline(cell));
  }

  const totalDuration = measure.durationUnits;

  // 2. onset 収集 (beat 境界 + 全パートの音符開始時刻)
  const onsetTimes = new Set<number>();
  for (let t = 0; t < totalDuration; t += unitsPerBeat) {
    onsetTimes.add(t);
  }
  for (const events of timelines.values()) {
    for (const e of events) {
      if (e.startUnit < totalDuration) onsetTimes.add(e.startUnit);
    }
  }
  const sortedOnsets = [...onsetTimes].sort((a, b) => a - b);

  // 3. 各 onset でスナップショット
  const snapshots: OnsetSnapshot[] = [];
  for (const offset of sortedOnsets) {
    const pitches = collectSoundingPitches(timelines, offset, matrix.partLabels);
    const chord = classifyChordEx(pitches, keyRootPc);
    snapshots.push({ offsetUnits: offset, pitches, chord });
  }

  // 4. beat 単位にグルーピング
  const numBeats = totalDuration > 0 ? Math.ceil(totalDuration / unitsPerBeat) : 0;
  const beats: BeatAnalysis[] = [];
  for (let bi = 0; bi < numBeats; bi++) {
    const beatStart = bi * unitsPerBeat;
    const beatEnd = Math.min((bi + 1) * unitsPerBeat, totalDuration);
    const beatOnsets = snapshots.filter(
      s => s.offsetUnits >= beatStart && s.offsetUnits < beatEnd,
    );
    const primary = beatOnsets.length > 0 ? beatOnsets[0].chord : null;
    beats.push({ beatIndex: bi, primary, onsets: beatOnsets });
  }

  // 5. summary = beat 1 のコード
  const summary = beats.length > 0 ? beats[0].primary : null;

  // 6. [C] セルテキスト生成
  const cellText = buildCellText(beats, summary, unitsPerBeat, div);

  return { measureIndex: measure.index, beats, summary, cellText };
}

// ============================================================
// 内部: [C] セルテキスト生成
// ============================================================

/**
 * beat 配列からコードセグメントを構築し、ChordName_Duration 形式のテキストを生成。
 *
 * 同じコードの連続 beat をマージし、duration を割り当てる。
 */
function buildCellText(
  beats: BeatAnalysis[],
  summary: ChordSymbol | null,
  unitsPerBeat: number,
  div: number,
): string {
  if (beats.length === 0) return '';

  // beat 単位のコードシーケンスを構築 (同じコードの連続をマージ)
  const segments: { chord: ChordSymbol | null; durationUnits: number }[] = [];
  for (const beat of beats) {
    const chord = beat.primary;
    const last = segments.length > 0 ? segments[segments.length - 1] : null;
    if (last && chordSymbolsEqual(last.chord, chord)) {
      last.durationUnits += unitsPerBeat;
    } else {
      segments.push({ chord, durationUnits: unitsPerBeat });
    }
  }

  // degree prefix (summary の度数)
  const degreePrefix = summary ? `${summary.relative}/ ` : '';

  // 各セグメントをトークン化
  const tokens: string[] = [];
  for (const seg of segments) {
    if (!seg.chord) {
      // コード不明: 休符と同じ duration で R 表記
      const durChars = unitsToDurationChars(seg.durationUnits, div);
      for (const dc of durChars) tokens.push(`?_${dc}`);
    } else {
      const chordName = formatChordName(seg.chord);
      const durChars = unitsToDurationChars(seg.durationUnits, div);
      for (const dc of durChars) tokens.push(`${chordName}_${dc}`);
    }
  }

  return degreePrefix + tokens.join(' ');
}

/** ChordSymbol → コード名文字列 (ambiguous 時は ~ 区切り) */
function formatChordName(sym: ChordSymbol): string {
  if (sym.confidence === 'ambiguous' && sym.alternatives.length > 0) {
    return sym.absolute + '~' + sym.alternatives[0].absolute;
  }
  return sym.absolute;
}

/** 2つの ChordSymbol が同じコードかを判定 (root + quality + bass) */
function chordSymbolsEqual(a: ChordSymbol | null, b: ChordSymbol | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.root === b.root && a.quality === b.quality && a.bass === b.bass;
}

/**
 * unit 数を .hide duration 文字列に貪欲分解する。
 * 例: DIV=32 で 12u → ['k', 'j'] (8+4)
 */
function unitsToDurationChars(units: number, div: number): string[] {
  const descending: { char: string; rawAtDiv32: number }[] = [
    { char: 'm', rawAtDiv32: 32 },
    { char: 'l', rawAtDiv32: 16 },
    { char: 'k', rawAtDiv32: 8 },
    { char: 'j', rawAtDiv32: 4 },
    { char: 'i', rawAtDiv32: 2 },
    { char: 'h', rawAtDiv32: 1 },
  ];
  const result: string[] = [];
  let remaining = units;
  for (const { char, rawAtDiv32 } of descending) {
    const value = Math.round((rawAtDiv32 * div) / 32);
    if (value < 1) continue;
    while (remaining >= value) {
      result.push(char);
      remaining -= value;
    }
  }
  if (result.length === 0) result.push('k'); // fallback
  return result;
}

// ============================================================
// 内部: ピッチユーティリティ
// ============================================================

function pitchToSemitone(p: HidePitch): number {
  const raw = STEP_TO_SEMITONE[p.step] + p.alter;
  return ((raw % 12) + 12) % 12;
}

function pitchToAbsolute(p: HidePitch): number {
  return p.octave * 12 + STEP_TO_SEMITONE[p.step] + p.alter;
}

function findLowestPitch(pitches: HidePitch[]): HidePitch {
  let lowest = pitches[0];
  let lowestAbs = pitchToAbsolute(lowest);
  for (let i = 1; i < pitches.length; i++) {
    const abs = pitchToAbsolute(pitches[i]);
    if (abs < lowestAbs) { lowestAbs = abs; lowest = pitches[i]; }
  }
  return lowest;
}

function uniqueSortedPcSet(pitches: HidePitch[]): number[] {
  return Array.from(new Set(pitches.map(pitchToSemitone))).sort((a, b) => a - b);
}

/**
 * KEY ヘッダーの fifths 値からキーの根音ピッチクラスを算出する。
 * fifths=0 → C(0), fifths=1 → G(7), fifths=-1 → F(5), etc.
 */
export function fifthsToKeyRoot(fifths: number): number {
  return ((fifths * 7) % 12 + 12) % 12;
}

function intervalsEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hidePitchesEqual(a: HidePitch[], b: HidePitch[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].step !== b[i].step) return false;
    if (a[i].octave !== b[i].octave) return false;
    if (a[i].alter !== b[i].alter) return false;
  }
  return true;
}
