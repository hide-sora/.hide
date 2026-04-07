/**
 * hideChord.ts — v1.9 matrix mode の上に乗る chord 分類レイヤー
 *
 * 仕様: README §4 "Matrix mode" の自然な consumer。
 *
 * matrix mode が出力する `HidePitch[]` (= ある時刻での全鳴音) を受け取り、
 * pitch class set として扱って既知の三和音 / 七の和音テンプレートにマッチ
 * させる。`measureToChord(matrix, measure)` の出力をそのまま渡せる。
 *
 * 用途:
 *  - LLM へのコード進行プロンプト構築
 *  - ハモり提案の "現在のコードは何か" 抽出
 *  - 声部進行解析の前段
 *
 * スコープ外 (意図的):
 *  - 5音以上の和音 (テンション含む) の分類 — null を返す
 *  - エンハーモニック表記の最適化 (常にシャープ表記)
 *  - キー中心の機能解析 (I/IV/V のような Roman 数字付け)
 *
 * これらは将来必要になったら別レイヤーとして追加する想定。
 */

import type { HidePitch } from './hideTypes';
import type { HideMatrix } from './hideMatrix';
import { measureToChord } from './hideMatrix';

// ============================================================
// 公開型
// ============================================================

/**
 * 認識可能な和音種別。
 *  - triad: maj / min / dim / aug
 *  - 7th  : maj7 / dom7 / min7 / m7b5 / dim7 / minMaj7
 */
export type ChordQuality =
  | 'maj'
  | 'min'
  | 'dim'
  | 'aug'
  | 'maj7'
  | 'dom7'
  | 'min7'
  | 'm7b5'
  | 'dim7'
  | 'minMaj7';

/** 和音 1 個の分類結果 */
export interface ChordLabel {
  /** 根音 (シャープ表記、例: "C", "C#", "F#") */
  root: string;
  /** 和音種別 */
  quality: ChordQuality;
  /** バス音 (= 入力中で最も低い実音のピッチクラス名) */
  bass: string;
  /** バスがルートと違う場合 true (= 転回形) */
  inverted: boolean;
  /** 表示用シンボル ("Cmaj" / "Cmaj/E" など) */
  symbol: string;
}

// ============================================================
// テンプレート
// ============================================================

const SEMITONE_NAMES = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
] as const;

const STEP_TO_SEMITONE: Record<HidePitch['step'], number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

/** ルートからの半音インターバル集合 (整数昇順) → quality */
const TRIAD_TEMPLATES: Array<{ quality: ChordQuality; intervals: number[] }> = [
  { quality: 'maj', intervals: [0, 4, 7] },
  { quality: 'min', intervals: [0, 3, 7] },
  { quality: 'dim', intervals: [0, 3, 6] },
  { quality: 'aug', intervals: [0, 4, 8] },
];

const SEVENTH_TEMPLATES: Array<{ quality: ChordQuality; intervals: number[] }> = [
  { quality: 'maj7',    intervals: [0, 4, 7, 11] },
  { quality: 'dom7',    intervals: [0, 4, 7, 10] },
  { quality: 'min7',    intervals: [0, 3, 7, 10] },
  { quality: 'm7b5',    intervals: [0, 3, 6, 10] },
  { quality: 'dim7',    intervals: [0, 3, 6, 9] },
  { quality: 'minMaj7', intervals: [0, 3, 7, 11] },
];

// ============================================================
// 公開API
// ============================================================

/**
 * `HidePitch[]` を 1 個の和音として分類する。
 *
 * 規則:
 *  - 0 個 / 1 個の distinct pitch class → null
 *  - 2 個 (dyad) → null (和音ではなく音程)
 *  - 3 個 → triad テンプレートのどれかに一致すれば返す
 *  - 4 個 → seventh テンプレートのどれかに一致すれば返す
 *  - 5 個以上 → null (テンション和音は v1 スコープ外)
 *
 * ルート決定:
 *  - 同じピッチクラス集合が複数のルートで一致しうる対称和音 (aug, dim7) は
 *    バス音 (実音上の最低音) に最も近いルートを優先する
 *
 * @param pitches `measureToChord(matrix, measure)` の出力など、ある時刻の全鳴音
 * @returns 分類結果。マッチしなければ null
 */
export function classifyChord(pitches: HidePitch[]): ChordLabel | null {
  if (pitches.length === 0) return null;

  // 1. distinct pitch class set (sorted)
  const pcSet = Array.from(new Set(pitches.map(pitchToSemitone))).sort((a, b) => a - b);
  if (pcSet.length < 3 || pcSet.length > 4) return null;

  // 2. バス (実音最低) のピッチクラス
  let bassPitch = pitches[0];
  let bassAbs = pitchToAbsolute(bassPitch);
  for (const p of pitches) {
    const a = pitchToAbsolute(p);
    if (a < bassAbs) { bassAbs = a; bassPitch = p; }
  }
  const bassPc = pitchToSemitone(bassPitch);

  // 3. ルート候補をバス優先で並べる (対称和音の tie break)
  const rootCandidates: number[] = [bassPc, ...pcSet.filter(p => p !== bassPc)];

  const templates = pcSet.length === 3 ? TRIAD_TEMPLATES : SEVENTH_TEMPLATES;

  for (const root of rootCandidates) {
    const rotated = rotateToRoot(pcSet, root);
    for (const tpl of templates) {
      if (intervalsEqual(rotated, tpl.intervals)) {
        const rootName = SEMITONE_NAMES[root];
        const bassName = SEMITONE_NAMES[bassPc];
        const inverted = bassPc !== root;
        return {
          root: rootName,
          quality: tpl.quality,
          bass: bassName,
          inverted,
          symbol: inverted ? `${rootName}${tpl.quality}/${bassName}` : `${rootName}${tpl.quality}`,
        };
      }
    }
  }
  return null;
}

/**
 * Matrix 全体を小節ごとに分類する高レベルヘルパー。
 *
 * @returns 各小節の `ChordLabel | null` を小節順で並べた配列。
 *          解析できない小節 (沈黙、5音以上、未知の組み合わせ) は null
 */
export function classifyMatrixMeasures(matrix: HideMatrix): Array<ChordLabel | null> {
  return matrix.measures.map(m => classifyChord(measureToChord(matrix, m)));
}

// ============================================================
// 内部ヘルパー
// ============================================================

function pitchToSemitone(p: HidePitch): number {
  const raw = STEP_TO_SEMITONE[p.step] + p.alter;
  return ((raw % 12) + 12) % 12;
}

function pitchToAbsolute(p: HidePitch): number {
  return p.octave * 12 + STEP_TO_SEMITONE[p.step] + p.alter;
}

/** pcSet をルート基準にずらしてソート (= ルートからのインターバル集合) */
function rotateToRoot(pcSet: number[], root: number): number[] {
  return pcSet
    .map(x => ((x - root) % 12 + 12) % 12)
    .sort((a, b) => a - b);
}

function intervalsEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
