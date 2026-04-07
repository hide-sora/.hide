/**
 * hideVoiceLeading.ts — v1.9 matrix mode の上に乗る声部進行解析レイヤー
 *
 * 仕様: README §4 "Matrix mode" の自然な consumer (hideChord と並ぶ第2の解析モジュール)。
 *
 * 入力は HideMatrix。隣接小節間の各パートの voice motion を解析し、
 * 古典和声で「避けられる」とされる動きを **caution (注意)** として浮上させる:
 *  - 平行 5/8 度 (parallelFifths / parallelOctaves)
 *  - 直行 (隠伏) 5/8 度 (directFifths / directOctaves)
 *  - 声部交差 (voiceCrossing) — 宣言順で上にあるはずのパートが下にいる
 *  - 過大跳躍 (largeLeap) — 単一パートの |delta| > 12 半音 (= 1 オクターブ超)
 *
 * **重要 — Hamoren ジャンルとの関係**:
 * Hamoren が対象とする音楽は **ポップ/現代アカペラ** であり、上記はいずれも
 * **古典和声では「避けられる」とされる** 動きだが、**ポップでは絶対禁則ではない**:
 *  - 平行 5/8 度 → パワーコード/オクターブダブリングで意図的に多用される
 *  - 声部交差 → ジャズ/ポップで普通に起こる
 *  - 大跳躍 → メリスマ/エフェクトで使われる
 *  - 直行 5/8 度 → ほぼクラシック特有の概念
 * よってこのモジュールは **「注意」を浮上させるだけ** であり、検出 = エラー
 * ではない。下流 consumer (LLM ハモり提案、編曲検証 UI) が文脈で解釈する。
 *
 * 各セルの "代表ピッチ" は **「セル内最初の note の最低音」** (= bass-of-cell-onset)
 * を採用する。a-cappella で各セルが whole-note 単音となるケースに最適化。
 * 複雑なメロディを持つセルの voice leading 解析は future work。
 *
 * パートペア (= 2 パートの組合せ) は **全組合せ C(N,2)** をチェックする。
 * 例: 5 パートなら 4+3+2+1 = 10 通り。
 *
 * スコープ外 (意図的):
 *  - 旋律内 (セル内) の跳躍進行解析
 *  - キー中心の機能解析 (ドミナントの解決義務など)
 *  - リズム的 voice leading (アタックポイントを跨ぐ解析)
 *  - 同時並行検出 (同じパートの和音内の声部割り当て)
 */

import type { HidePitch, HideToken } from './hideTypes';
import type { HideMatrix, HideMatrixCell, HideMatrixMeasure } from './hideMatrix';

// ============================================================
// 公開型
// ============================================================

export type VoiceLeadingObservationKind =
  | 'parallelFifths'
  | 'parallelOctaves'
  | 'directFifths'
  | 'directOctaves'
  | 'voiceCrossing'
  | 'largeLeap';

/**
 * 検出された観察事項 (caution) の 1 件。
 *
 * これは「禁則」ではなく **「古典和声でなら避けられる動き」をフラグした注意** に過ぎない。
 * ポップ/現代アカペラでは多くがむしろ常用される (parallel 5/8 度のパワーコード等)。
 * 下流 consumer (LLM ハモり提案、編曲検証 UI) が文脈で解釈する。
 *
 * - transition 系 (parallel/direct/largeLeap): fromMeasureIndex = i, toMeasureIndex = i+1
 * - measure-bound 系 (voiceCrossing): fromMeasureIndex = toMeasureIndex = 発生小節
 */
export interface VoiceLeadingObservation {
  kind: VoiceLeadingObservationKind;
  fromMeasureIndex: number;
  toMeasureIndex: number;
  /** 関連パート (largeLeap は 1 個、それ以外は 2 個) */
  parts: string[];
  message: string;
}

/**
 * 1 つの小節遷移 (i → i+1) における各パートの動き。
 */
export interface VoiceLeadingTransition {
  fromMeasureIndex: number;
  toMeasureIndex: number;
  /** 各パートの semitone delta (signed: 正 = 上行)。代表音が取れなかったパートは未収録 */
  voiceDeltas: Map<string, number>;
}

export interface VoiceLeadingAnalysis {
  /** 隣接小節遷移ごとの voice motion 情報 */
  transitions: VoiceLeadingTransition[];
  /** 浮上した caution (注意) 観察の一覧。「禁則」ではない */
  observations: VoiceLeadingObservation[];
}

// ============================================================
// 公開API
// ============================================================

/** 過大跳躍とみなす閾値 (半音単位、|delta| > これで observation を浮上させる) */
const LARGE_LEAP_THRESHOLD = 12;

/**
 * Matrix 全体の voice leading を解析する。
 *
 * @example
 *   const { matrix } = analyzeMatrix(source);
 *   const { transitions, observations } = analyzeVoiceLeading(matrix);
 *   for (const obs of observations) console.log(obs.kind, obs.message);
 */
export function analyzeVoiceLeading(matrix: HideMatrix): VoiceLeadingAnalysis {
  const transitions: VoiceLeadingTransition[] = [];
  const observations: VoiceLeadingObservation[] = [];

  // 1. 各小節 × 各パートの代表音 (絶対半音) を事前計算
  const repByMeasure: Array<Map<string, number>> = matrix.measures.map(m =>
    extractRepresentativePitches(matrix.partLabels, m),
  );

  // 2. 各小節について voice crossing を検出 (= 宣言順に絶対音高が降順になっていない)
  for (let mi = 0; mi < matrix.measures.length; mi++) {
    detectVoiceCrossing(matrix.partLabels, repByMeasure[mi], mi, observations);
  }

  // 3. 隣接小節ペアについて voice motion + 平行/直行 5/8 度 + 跳躍を解析
  for (let mi = 0; mi < matrix.measures.length - 1; mi++) {
    const repA = repByMeasure[mi];
    const repB = repByMeasure[mi + 1];

    // 3a. voice deltas (signed semitones)
    const voiceDeltas = new Map<string, number>();
    for (const label of matrix.partLabels) {
      const a = repA.get(label);
      const b = repB.get(label);
      if (a === undefined || b === undefined) continue;
      voiceDeltas.set(label, b - a);
    }
    transitions.push({
      fromMeasureIndex: mi,
      toMeasureIndex: mi + 1,
      voiceDeltas,
    });

    // 3b. 過大跳躍検出 (|delta| > 1 オクターブ)
    for (const [label, delta] of voiceDeltas) {
      if (Math.abs(delta) > LARGE_LEAP_THRESHOLD) {
        observations.push({
          kind: 'largeLeap',
          fromMeasureIndex: mi,
          toMeasureIndex: mi + 1,
          parts: [label],
          message: `小節 ${mi + 1} → ${mi + 2}: パート [${label}] が ${delta > 0 ? '+' : ''}${delta} 半音の跳躍 (1 オクターブ超)`,
        });
      }
    }

    // 3c. 平行/直行 5/8 度検出 (全パートペア × 同方向 motion)
    const labels = matrix.partLabels;
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const labelA = labels[i];
        const labelB = labels[j];
        const aA = repA.get(labelA);
        const aB = repA.get(labelB);
        const bA = repB.get(labelA);
        const bB = repB.get(labelB);
        if (aA === undefined || aB === undefined || bA === undefined || bB === undefined) continue;

        const deltaA = bA - aA;
        const deltaB = bB - aB;

        // どちらかが静止 = oblique → 安全 (古典和声の定説)
        if (deltaA === 0 || deltaB === 0) continue;
        // 反進行 = contrary → 平行/直行 5/8 度の対象外
        if (Math.sign(deltaA) !== Math.sign(deltaB)) continue;

        // similar motion (or strict parallel motion). interval は mod 12 の harmonic interval。
        const intervalI = Math.abs(aA - aB) % 12;
        const intervalJ = Math.abs(bA - bB) % 12;

        if (intervalI === 7 && intervalJ === 7) {
          observations.push({
            kind: 'parallelFifths',
            fromMeasureIndex: mi,
            toMeasureIndex: mi + 1,
            parts: [labelA, labelB],
            message: `小節 ${mi + 1} → ${mi + 2}: パート [${labelA}] と [${labelB}] が平行 5 度`,
          });
        } else if (intervalJ === 7) {
          // intervalI != 7 だが着地が完全 5 度 → 直行 (隠伏) 5 度
          observations.push({
            kind: 'directFifths',
            fromMeasureIndex: mi,
            toMeasureIndex: mi + 1,
            parts: [labelA, labelB],
            message: `小節 ${mi + 1} → ${mi + 2}: パート [${labelA}] と [${labelB}] が直行 5 度 (隠伏 5 度)`,
          });
        }

        if (intervalI === 0 && intervalJ === 0) {
          observations.push({
            kind: 'parallelOctaves',
            fromMeasureIndex: mi,
            toMeasureIndex: mi + 1,
            parts: [labelA, labelB],
            message: `小節 ${mi + 1} → ${mi + 2}: パート [${labelA}] と [${labelB}] が平行 8 度`,
          });
        } else if (intervalJ === 0) {
          observations.push({
            kind: 'directOctaves',
            fromMeasureIndex: mi,
            toMeasureIndex: mi + 1,
            parts: [labelA, labelB],
            message: `小節 ${mi + 1} → ${mi + 2}: パート [${labelA}] と [${labelB}] が直行 8 度 (隠伏 8 度)`,
          });
        }
      }
    }
  }

  return { transitions, observations };
}

// ============================================================
// 内部ヘルパー
// ============================================================

const STEP_TO_SEMITONE: Record<HidePitch['step'], number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

function pitchToAbsolute(p: HidePitch): number {
  return p.octave * 12 + STEP_TO_SEMITONE[p.step] + p.alter;
}

/**
 * セルの "代表音" (= bass-of-cell-onset)。
 * セル内最初の note の中で最低のピッチを返す。note が無ければ undefined。
 * 反復・連符の中も再帰的に走査する。
 */
function findFirstNoteLowestPitch(body: HideToken[]): number | undefined {
  for (const tok of body) {
    if (tok.kind === 'note' && tok.pitches.length > 0) {
      let lo = pitchToAbsolute(tok.pitches[0]);
      for (const p of tok.pitches) {
        const a = pitchToAbsolute(p);
        if (a < lo) lo = a;
      }
      return lo;
    }
    if (tok.kind === 'tuplet') {
      for (const m of tok.members) {
        if (m.kind === 'note' && m.pitches.length > 0) {
          let lo = pitchToAbsolute(m.pitches[0]);
          for (const p of m.pitches) {
            const a = pitchToAbsolute(p);
            if (a < lo) lo = a;
          }
          return lo;
        }
      }
    }
    if (tok.kind === 'repeat') {
      const r = findFirstNoteLowestPitch(tok.body);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

function cellRepresentative(cell: HideMatrixCell): number | undefined {
  return findFirstNoteLowestPitch(cell.body);
}

function extractRepresentativePitches(
  partLabels: string[],
  measure: HideMatrixMeasure,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const label of partLabels) {
    const cell = measure.cells.get(label);
    if (!cell) continue;
    const rep = cellRepresentative(cell);
    if (rep !== undefined) out.set(label, rep);
  }
  return out;
}

/**
 * 1 小節での声部交差検出。
 * 宣言順に並べたパートの絶対音高が「上から下」(= 降順) になっていないペアを検出する。
 *
 * 例: partLabels = ['1','2','3','4'] のとき、[1] の音高 ≥ [2] ≥ [3] ≥ [4] となるべき。
 * [1] が [2] より低かった場合は voice crossing。
 *
 * 隣接ペア間 (= [1]-[2], [2]-[3], [3]-[4]) のみチェックする。
 * (非隣接ペアの "voice overlap" は別概念で、必要なら future work)
 */
function detectVoiceCrossing(
  partLabels: string[],
  rep: Map<string, number>,
  measureIndex: number,
  observations: VoiceLeadingObservation[],
): void {
  for (let i = 0; i < partLabels.length - 1; i++) {
    const upper = partLabels[i];
    const lower = partLabels[i + 1];
    const u = rep.get(upper);
    const l = rep.get(lower);
    if (u === undefined || l === undefined) continue;
    if (u < l) {
      observations.push({
        kind: 'voiceCrossing',
        fromMeasureIndex: measureIndex,
        toMeasureIndex: measureIndex,
        parts: [upper, lower],
        message: `小節 ${measureIndex + 1}: パート [${upper}] がパート [${lower}] より下にある (声部交差)`,
      });
    }
  }
}
