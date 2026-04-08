/**
 * pdfHideNotehead.ts — PDF→.hide pipeline Phase 2b: notehead + pitch + duration の古典 OMR
 *
 * 1 つの cell (= 1 staff × 1 measure) を入力に取り、cell 内の notehead を検出して
 * pitch / accidental / 音価まで決定する。Phase 1 で求めた `clef` と `keyFifths` が
 * 入力のヒントとして必要。
 *
 * 設計:
 *  - 依存: `pdfHideImage.ts` + `pdfHideLayout.ts` + `pdfHideTemplates.ts` のみ
 *  - 出力 `Notehead` 1 つあたりに `confidence` を持たせ、低い物は Phase 3 (assemble) で
 *    `;low-confidence:cellId` マークし Phase 4 LLM に補完させる
 *  - **古典 OMR 単独の精度目標は設けない** (Plan H 方針): 自信あるセルを高信頼で確定し、
 *    残りは confidence を低く付けて LLM 補完路線に流す
 *  - 既知の単純化:
 *    - flag / beam による 8 分・16 分の区別はしない (filled+stem は default で quarter
 *      扱い、ただし stem 末端の暗 pixel が高い場合 8 分に格上げ)
 *    - 三連符 bracket / 装飾音 / トリル等は範囲外
 *    - tied / slur 検出は範囲外 (Phase 3 で `tiedSlurAmbiguous` diagnostic として扱う)
 *
 * 検出フロー:
 *   1. cell crop → grayscale → binarize
 *   2. connected components で blob 抽出 → size filter で候補
 *   3. 各候補で 4 種 notehead template (`noteheadBlack` / `noteheadHalf` /
 *      `noteheadWhole` / `noteheadXBlack`) を NCC でスコアリング → 最良 kind を選ぶ
 *   4. 候補位置 → diatonic step → MIDI pitch (clef + key signature)
 *   5. notehead 左の window で `accidentalSharp` / `accidentalFlat` / `accidentalNatural`
 *      template を NCC でスコアリング → 最良が threshold 超なら採用
 *   6. 同一 cell 内で accidental carry-over (letter+octave key)
 *   7. notehead 中心の上下に stem 走査 → presence + 上向き / 下向き
 *   8. duration = (filled/hollow) × (stem有/無) → durationUnits @ DIV 32
 */

import {
  binarize,
  connectedComponents,
  cropImage,
  toGrayscale,
} from './pdfHideImage';
import type { Component, PdfHideImage } from './pdfHideImage';
import type { CellBox, StaffBand } from './pdfHideLayout';
import type { PdfHideClefName } from './pdfHideMeta';
import { TEMPLATES, getTemplate } from './pdfHideTemplates';
import type { TemplateBitmap, TemplateName } from './pdfHideTemplates';

// ============================================================
// 公開型
// ============================================================

/** notehead の形状区分 */
export type NoteheadKind = 'filled' | 'hollow' | 'whole' | 'x';

/** stem 方向 */
export type StemDirection = 'up' | 'down' | 'none';

/** 音名 letter (A..G) */
export type PitchLetter = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';

/**
 * 1 つの notehead 検出結果。
 *
 * pixel 座標は元 page image の絶対座標 (cell crop した後の local 座標ではなく
 * 元の絶対座標に戻している)。
 *
 * `confidence` は notehead 形状判定の最良 NCC スコア (0..1)。
 * `pitchConfidence` は pitch 確信度の別物 (現状は固定で 1.0、将来 ledger line 安定度等を
 * 加味する想定)。
 *
 * accidental が template match で確定できなかった場合 (key signature 由来 default のみ)
 * は `accidentalSource = 'key'`、明示的に notehead 左で sharp/flat/natural が見つかった
 * 場合は `accidentalSource = 'explicit'`、carry-over なら `'carry'`。
 */
export interface Notehead {
  /** page image 絶対座標での重心 x */
  centroidX: number;
  /** page image 絶対座標での重心 y */
  centroidY: number;
  /** raster bbox 幅 (pixel) */
  width: number;
  /** raster bbox 高さ (pixel) */
  height: number;
  /** raster bbox 左端 x (page image 絶対座標、inclusive) */
  bboxX: number;
  /** raster bbox 上端 y (page image 絶対座標、inclusive) */
  bboxY: number;
  /** 構成 pixel 数 / bbox 面積 (filled vs hollow の切り分け補助) */
  fillRatio: number;
  /** 形状 (template match で決定) */
  kind: NoteheadKind;
  /** template match 最良 NCC スコア (0..1)。closer to 1 = 高信頼 */
  confidence: number;

  // ----- 音高 -----
  /** 音名 letter ('C'..'B')。percussion clef の場合は undefined */
  letter?: PitchLetter;
  /** octave (中央 C = C4 = 4)。percussion clef の場合は undefined */
  octave?: number;
  /** 半音オフセット (-2..+2)。flat = -1, sharp = +1, natural = 0, double sharp = +2, double flat = -2 */
  alter?: number;
  /** MIDI pitch (60 = C4)。alter 適用済み */
  midi?: number;
  /** どこから alter が来たか */
  accidentalSource?: 'key' | 'explicit' | 'carry' | 'none';

  // ----- 音価 -----
  /** stem 方向 (検出できなければ 'none') */
  stemDirection?: StemDirection;
  /** stem 検出スコア (0..1、stem の連続 pixel 比) */
  stemScore?: number;
  /** DIV=32 を前提とした units (whole=32, half=16, quarter=8, eighth=4, sixteenth=2)。判定不能なら undefined */
  durationUnits?: number;
  /** 付点フラグ (notehead 右の小さな dot blob を検出した場合) */
  dotted?: boolean;
}

/** detection 中の警告 (silent fill 禁止: assemble 段で diagnostic 化) */
export interface NoteheadWarning {
  kind:
    | 'cellEmpty'
    | 'lowConfidenceNotehead'
    | 'unknownDuration'
    | 'percussionInPitchedClef'
    | 'pitchedInPercussionClef'
    | 'manyCandidates';
  detail: string;
}

/**
 * `detectNoteheadsInCell` の入力。
 * accidental carry-over は cell 単位で完結する想定 (= matrix mode で 1 cell = 1 measure)。
 */
export interface NoteheadDetectionInput {
  pageImage: PdfHideImage;
  cell: CellBox;
  staffBand: StaffBand;
  /** 'TREBLE' | 'BASS' | 'ALTO' | 'TENOR' | 'PERCUSSION' 等 */
  clef: PdfHideClefName;
  /** -7..+7 */
  keyFifths: number;
  /** 検出パラメータ調整 */
  options?: NoteheadDetectionOptions;
}

/** detection の調整パラメータ。default は engraved PDF の典型値 */
export interface NoteheadDetectionOptions {
  /** notehead bbox 高さの許容範囲倍率 (lineSpacing 基準). default [0.6, 1.6] */
  noteheadHeightRange?: [number, number];
  /** notehead bbox 幅の許容範囲倍率 (lineSpacing 基準). default [0.7, 2.4] */
  noteheadWidthRange?: [number, number];
  /** template match の最低 score (これ未満は notehead 候補から棄却) */
  noteheadMinScore?: number;
  /** template match の高信頼 score (これ以上は confidence = 高) */
  noteheadHighScore?: number;
  /** accidental template match の最低 score */
  accidentalMinScore?: number;
  /** stem 検出の連続 pixel 比閾値 (lineSpacing*3 の column が何割黒なら stem 認定) */
  stemMinRatio?: number;
}

/** detection 結果 */
export interface NoteheadDetectionResult {
  /** 左→右 (centroidX 順) でソート済み */
  noteheads: Notehead[];
  /** 全 notehead の confidence 最小値。空のときは 1.0 */
  minConfidence: number;
  /** 検出中に発生した warnings */
  warnings: NoteheadWarning[];
}

// ============================================================
// 定数 / clef テーブル
// ============================================================

const DEFAULT_OPTIONS: Required<NoteheadDetectionOptions> = {
  noteheadHeightRange: [0.6, 1.6],
  noteheadWidthRange: [0.7, 2.4],
  noteheadMinScore: 0.55,
  noteheadHighScore: 0.85,
  accidentalMinScore: 0.6,
  stemMinRatio: 0.55,
};

/**
 * 各 clef における 「staff line[0] (= 最上線) の音高」 を diatonic step で表す表。
 * diatonic step は C4 = 0、上に 1 letter 進むごとに +1。
 * 例: TREBLE の最上線は F5 → letter F (5番目)、octave 5 → diatonic = (5-4)*7 + 3 = 10
 *
 *   C0=−28, …, C4=0, D4=1, E4=2, F4=3, G4=4, A4=5, B4=6, C5=7, …, F5=10
 */
const LETTER_INDEX: Record<PitchLetter, number> = {
  C: 0,
  D: 1,
  E: 2,
  F: 3,
  G: 4,
  A: 5,
  B: 6,
};

const LETTERS: readonly PitchLetter[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

/**
 * `letter`/`octave` から diatonic step への変換 (C4=0)。
 * 1 octave = 7 diatonic step。
 */
function letterOctToDiatonic(letter: PitchLetter, octave: number): number {
  return (octave - 4) * 7 + LETTER_INDEX[letter];
}

/** diatonic step (C4=0) → `{letter, octave}` */
function diatonicToLetterOct(d: number): { letter: PitchLetter; octave: number } {
  // d を 7 で割って商と余りに分解。負数も正しく処理する。
  const idx = ((d % 7) + 7) % 7;
  const oct = Math.floor(d / 7) + 4;
  return { letter: LETTERS[idx], octave: oct };
}

/**
 * 各 clef における 「staff の最上線 (lineYs[0]) の diatonic step」テーブル。
 * これにより `(refDiatonic) - halfStepsFromTop` で any pixel y → diatonic が出る。
 *
 * 'PERCUSSION' は pitched でない (出力 letter / midi は付かない)。
 */
const CLEF_TOP_DIATONIC: Record<string, number> = {
  TREBLE: letterOctToDiatonic('F', 5), // 10
  BASS: letterOctToDiatonic('A', 3), // -2
  ALTO: letterOctToDiatonic('G', 4), // 4
  TENOR: letterOctToDiatonic('E', 4), // 2
  SOPRANO: letterOctToDiatonic('B', 4), // 6 (C clef on bottom line)
  MEZZO: letterOctToDiatonic('A', 4), // 5 (C clef on line 2)
  TREBLE_8VA: letterOctToDiatonic('F', 6),
  TREBLE_8VB: letterOctToDiatonic('F', 4),
  BASS_8VA: letterOctToDiatonic('A', 4),
  BASS_8VB: letterOctToDiatonic('A', 2),
};

/**
 * 各 letter (C..B) の中央 C オクターブ (= C4 = MIDI 60) における MIDI 値。
 * MIDI = (octave + 1) * 12 + semitoneOffset
 */
const LETTER_TO_SEMITONE: Record<PitchLetter, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

function letterOctToMidi(letter: PitchLetter, octave: number, alter: number): number {
  return (octave + 1) * 12 + LETTER_TO_SEMITONE[letter] + alter;
}

/**
 * key signature の fifths から、各 letter の default alter を求める。
 * sharp 順: F C G D A E B (fifths +1 = F#, +2 = F#C#, ...)
 * flat 順: B E A D G C F (fifths -1 = Bb, -2 = BbEb, ...)
 */
function keyDefaultAlter(letter: PitchLetter, fifths: number): number {
  const SHARP_ORDER: PitchLetter[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const FLAT_ORDER: PitchLetter[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
  if (fifths > 0) {
    const idx = SHARP_ORDER.indexOf(letter);
    if (idx >= 0 && idx < fifths) return 1;
    return 0;
  } else if (fifths < 0) {
    const idx = FLAT_ORDER.indexOf(letter);
    if (idx >= 0 && idx < -fifths) return -1;
    return 0;
  }
  return 0;
}

// ============================================================
// メインエントリ
// ============================================================

/**
 * 1 つの cell から notehead を検出する。
 *
 * - 出力 `noteheads` は centroidX 順 (左→右)
 * - 同一 measure 内の accidental carry-over は cell 内で閉じる (matrix mode 前提)
 */
export function detectNoteheadsInCell(
  input: NoteheadDetectionInput,
): NoteheadDetectionResult {
  const opts: Required<NoteheadDetectionOptions> = {
    ...DEFAULT_OPTIONS,
    ...(input.options ?? {}),
  };

  const { pageImage, cell, staffBand, clef, keyFifths } = input;
  const lineSpacing = staffBand.lineSpacing;
  const warnings: NoteheadWarning[] = [];

  if (lineSpacing <= 0) {
    warnings.push({
      kind: 'cellEmpty',
      detail: `staffBand.lineSpacing = ${lineSpacing} (cannot detect)`,
    });
    return { noteheads: [], minConfidence: 1.0, warnings };
  }

  // ----- 1. cell crop + 上下に ledger line 用の padding -----
  // ledger line 域は staff の上下 ~ 4 line 分まで使える ようにする (高い/低い ledger まで対応)
  const padPx = Math.round(lineSpacing * 4);
  const cropBox = {
    x: Math.max(0, Math.floor(cell.x)),
    y: Math.max(0, Math.floor(cell.y - padPx)),
    width: Math.ceil(cell.width),
    height: Math.ceil(cell.height + padPx * 2),
  };
  const cropped = cropImage(pageImage, cropBox);
  if (cropped.width === 0 || cropped.height === 0) {
    warnings.push({ kind: 'cellEmpty', detail: 'crop empty' });
    return { noteheads: [], minConfidence: 1.0, warnings };
  }

  const gray = toGrayscale(cropped);
  const bin = binarize(gray, cropped.width, cropped.height);

  // ----- 1b. staff line を除去 (notehead と staff line が 4-connectivity で
  // 繋がって 1 つの巨大 blob になるのを防ぐ) -----
  // 既知の staffBand.lineYs を local 座標に変換し、各 line row に対し:
  //   その pixel の上下 ±2 px に黒 pixel が無ければ「純粋な水平 staff line pixel」
  //   と判断して背景化する。notehead や stem が staff line を縦断する位置では
  //   上下に黒があるので保持される。
  // padPx 上に少し余裕がある (cell より広い) ため、lineYs の crop 外れチェック必要。
  for (const lineYAbs of staffBand.lineYs) {
    const ly = Math.round(lineYAbs - cropBox.y);
    if (ly < 0 || ly >= cropped.height) continue;
    for (let x = 0; x < cropped.width; x++) {
      if (bin[ly * cropped.width + x] !== 1) continue;
      const above2 = ly - 2 >= 0 && bin[(ly - 2) * cropped.width + x] === 1;
      const below2 = ly + 2 < cropped.height && bin[(ly + 2) * cropped.width + x] === 1;
      if (!above2 && !below2) {
        bin[ly * cropped.width + x] = 0;
      }
    }
  }

  // ----- 2. connected components → 候補抽出 -----
  // CC で blob を取り、各 blob 内で「最も dense な lineSpacing*1.4 高さの strip」を
  // notehead 候補として切り出す。これにより notehead+stem の縦長 blob でも、
  // 純 notehead 部分が candidate として残る。
  // 削除: erosion 方式は hollow / whole / × notehead や accidental を破壊する。
  const allComponents = connectedComponents(bin, cropped.width, cropped.height);
  const [hMin, hMax] = opts.noteheadHeightRange;
  const [wMin, wMax] = opts.noteheadWidthRange;
  const minH = lineSpacing * hMin;
  const maxH = lineSpacing * hMax;
  const minW = lineSpacing * wMin;
  const maxW = lineSpacing * wMax;
  // 各 blob の densest strip → candidate region
  const candidates: HeadCandidate[] = [];
  for (const comp of allComponents) {
    const blobW = comp.maxX - comp.minX + 1;
    const blobH = comp.maxY - comp.minY + 1;
    // 完全に範囲外の blob (極端に大きい / 小さい) は早期 reject
    if (blobW < minW * 0.6 || blobW > Math.max(maxW * 1.5, lineSpacing * 4)) continue;
    if (comp.area < lineSpacing * lineSpacing * 0.15) continue;
    // ledger / barline 等の極端に縦長 (高さ > 8 lineSpacing) はスキップ
    if (blobH > lineSpacing * 8) continue;
    // blob 内で densest strip を見つける
    const head = findDensestStrip(bin, cropped.width, comp, lineSpacing);
    if (head === undefined) continue;
    const hw = head.maxX - head.minX + 1;
    const hh = head.maxY - head.minY + 1;
    if (hw < minW || hw > maxW) continue;
    if (hh < minH || hh > maxH) continue;
    candidates.push(head);
  }

  if (candidates.length === 0) {
    warnings.push({ kind: 'cellEmpty', detail: 'no notehead candidates after size filter' });
    return { noteheads: [], minConfidence: 1.0, warnings };
  }
  if (candidates.length > 64) {
    warnings.push({
      kind: 'manyCandidates',
      detail: `${candidates.length} candidates (likely noisy or ledger line dense)`,
    });
  }

  // ----- 3. 各候補で template match → kind 判定 -----
  const isPercussion = clef.toUpperCase() === 'PERCUSSION';
  const noteheadKinds: { name: TemplateName; kind: NoteheadKind }[] = [
    { name: 'noteheadBlack', kind: 'filled' },
    { name: 'noteheadHalf', kind: 'hollow' },
    { name: 'noteheadWhole', kind: 'whole' },
    { name: 'noteheadXBlack', kind: 'x' },
  ];
  const noteheads: Notehead[] = [];

  for (const cand of candidates) {
    // 重心位置で template match (matched と本体の位置ズレを許す)
    let bestScore = -Infinity;
    let bestKind: NoteheadKind = 'filled';
    let bestTemplate: TemplateBitmap | undefined;
    for (const { name, kind } of noteheadKinds) {
      const tmpl = getTemplate(name, lineSpacing);
      if (!tmpl) continue;
      const score = templateMatchAtCentroid(bin, cropped.width, cropped.height, cand, tmpl);
      if (score > bestScore) {
        bestScore = score;
        bestKind = kind;
        bestTemplate = tmpl;
      }
    }
    if (bestScore < opts.noteheadMinScore || bestTemplate === undefined) {
      // 候補だが template に合わない → 棄却 (false positive 抑制)
      continue;
    }

    const w = cand.maxX - cand.minX + 1;
    const h = cand.maxY - cand.minY + 1;
    const fillRatio = cand.area / (w * h);
    // page 絶対座標
    const cx = cand.centroidX + cropBox.x;
    const cy = cand.centroidY + cropBox.y;
    const bboxXAbs = cand.minX + cropBox.x;
    const bboxYAbs = cand.minY + cropBox.y;

    // pitch 計算
    let letter: PitchLetter | undefined;
    let octave: number | undefined;
    let baseAlter = 0;
    let accidentalSource: Notehead['accidentalSource'] = 'none';
    let midi: number | undefined;
    if (!isPercussion && bestKind !== 'x') {
      const diatonic = pixelYToDiatonic(cy, staffBand, clef);
      if (diatonic !== undefined) {
        const lo = diatonicToLetterOct(diatonic);
        letter = lo.letter;
        octave = lo.octave;
        baseAlter = keyDefaultAlter(letter, keyFifths);
        accidentalSource = baseAlter !== 0 ? 'key' : 'none';
        midi = letterOctToMidi(letter, octave, baseAlter);
      }
    }

    // confidence: template score を 0..1 にクリップ
    const confidence = Math.max(0, Math.min(1, bestScore));
    if (confidence < opts.noteheadHighScore) {
      warnings.push({
        kind: 'lowConfidenceNotehead',
        detail: `score=${confidence.toFixed(2)} < ${opts.noteheadHighScore} at (${cx.toFixed(0)},${cy.toFixed(0)})`,
      });
    }

    if (isPercussion && bestKind !== 'x') {
      warnings.push({
        kind: 'pitchedInPercussionClef',
        detail: `kind=${bestKind} at (${cx.toFixed(0)},${cy.toFixed(0)})`,
      });
    }
    if (!isPercussion && bestKind === 'x') {
      warnings.push({
        kind: 'percussionInPitchedClef',
        detail: `× notehead at (${cx.toFixed(0)},${cy.toFixed(0)})`,
      });
    }

    noteheads.push({
      centroidX: cx,
      centroidY: cy,
      width: w,
      height: h,
      bboxX: bboxXAbs,
      bboxY: bboxYAbs,
      fillRatio,
      kind: bestKind,
      confidence,
      letter,
      octave,
      alter: letter !== undefined ? baseAlter : undefined,
      midi,
      accidentalSource,
    });
  }

  // ----- 4. centroid X 順にソート -----
  noteheads.sort((a, b) => a.centroidX - b.centroidX);

  // ----- 5. 各 notehead について accidental template match (左 window) -----
  // 左 window: notehead の左端から lineSpacing*0.4 ~ lineSpacing*2 の範囲
  const accidentalKinds: { name: TemplateName; alter: number }[] = [
    { name: 'accidentalSharp', alter: 1 },
    { name: 'accidentalFlat', alter: -1 },
    { name: 'accidentalNatural', alter: 0 },
    { name: 'accidentalDoubleSharp', alter: 2 },
    { name: 'accidentalDoubleFlat', alter: -2 },
  ];
  // accidental carry-over: key = "letter+octave", value = alter
  const carry = new Map<string, number>();
  for (const nh of noteheads) {
    if (nh.letter === undefined || nh.octave === undefined) continue;
    const key = `${nh.letter}${nh.octave}`;
    // 左 window で 5 種 accidental template を順に試し、最良を選ぶ
    let bestAccScore = -Infinity;
    let bestAccAlter = 0;
    let bestAccName: TemplateName | undefined;
    for (const { name, alter } of accidentalKinds) {
      const tmpl = getTemplate(name, lineSpacing);
      if (!tmpl) continue;
      const sc = scanAccidentalLeftOf(bin, cropped.width, cropped.height, nh, cropBox, tmpl, lineSpacing);
      if (sc > bestAccScore) {
        bestAccScore = sc;
        bestAccAlter = alter;
        bestAccName = name;
      }
    }
    if (bestAccScore >= opts.accidentalMinScore && bestAccName !== undefined) {
      // 明示的 accidental: alter を上書き
      nh.alter = bestAccAlter;
      nh.accidentalSource = 'explicit';
      carry.set(key, bestAccAlter);
    } else if (carry.has(key)) {
      // carry-over: 同 measure で先行 note と同じ alter
      nh.alter = carry.get(key)!;
      nh.accidentalSource = 'carry';
    }
    // alter を MIDI に反映
    if (nh.letter !== undefined && nh.octave !== undefined) {
      nh.midi = letterOctToMidi(nh.letter, nh.octave, nh.alter ?? 0);
    }
  }

  // ----- 6. stem 検出 + duration 推定 -----
  for (const nh of noteheads) {
    const stemInfo = detectStem(bin, cropped.width, cropped.height, nh, cropBox, lineSpacing, opts.stemMinRatio);
    nh.stemDirection = stemInfo.direction;
    nh.stemScore = stemInfo.score;
    nh.durationUnits = inferDuration(nh.kind, stemInfo.direction);
    if (nh.durationUnits === undefined) {
      warnings.push({
        kind: 'unknownDuration',
        detail: `kind=${nh.kind} stem=${stemInfo.direction} at (${nh.centroidX.toFixed(0)},${nh.centroidY.toFixed(0)})`,
      });
    }
  }

  const minConfidence =
    noteheads.length === 0 ? 1.0 : Math.min(...noteheads.map((n) => n.confidence));

  return { noteheads, minConfidence, warnings };
}

// ============================================================
// helpers: candidate region (densest strip)
// ============================================================

/**
 * 1 つの blob 内で見つかった「notehead 候補領域」。Component 風の bbox/centroid/area を持つ。
 * (notehead+stem 統合 blob でも notehead 部分だけを切り出せる)
 */
interface HeadCandidate {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  area: number;
  centroidX: number;
  centroidY: number;
}

/**
 * Component (CC blob) 内で「lineSpacing*1.4 高さ × 全幅」の strip を上から下にスライドし、
 * 最も多く前景 pixel を含む strip を notehead 候補として返す。
 *
 * - notehead 単体の blob: densest strip = blob 全体に近い
 * - notehead + stem の縦長 blob: densest strip = notehead 部分のみ (stem は 1 column 1px/row しか
 *   寄与しないため densest にならない)
 * - sharp / flat / × など notehead でない blob: densest strip も小さく、後段の template match で reject
 *
 * 戻り値の bbox/centroid は densest strip 内の前景 pixel から計算する (= notehead の真の centroid)。
 */
function findDensestStrip(
  bin: Uint8Array,
  width: number,
  comp: { minX: number; maxX: number; minY: number; maxY: number; area: number; centroidX: number; centroidY: number },
  lineSpacing: number,
): HeadCandidate | undefined {
  const stripH = Math.max(1, Math.round(lineSpacing * 1.4));
  const blobH = comp.maxY - comp.minY + 1;
  // strip が blob より大きい時は blob 全体を strip とする
  const effectiveStripH = Math.min(stripH, blobH);

  // y を 1 px 刻みでスライドして foreground 数を最大化
  let bestY = comp.minY;
  let bestCount = -1;
  const lastTopY = comp.maxY - effectiveStripH + 1;
  for (let yy = comp.minY; yy <= lastTopY; yy++) {
    let count = 0;
    for (let y = yy; y < yy + effectiveStripH; y++) {
      const rowStart = y * width;
      for (let x = comp.minX; x <= comp.maxX; x++) {
        if (bin[rowStart + x] === 1) count++;
      }
    }
    if (count > bestCount) {
      bestCount = count;
      bestY = yy;
    }
  }

  // best strip 内の前景 pixel から centroid / bbox を再計算
  let sumX = 0;
  let sumY = 0;
  let area = 0;
  let mnX = width;
  let mxX = -1;
  let mnY = bestY + effectiveStripH;
  let mxY = -1;
  for (let y = bestY; y < bestY + effectiveStripH; y++) {
    const rowStart = y * width;
    for (let x = comp.minX; x <= comp.maxX; x++) {
      if (bin[rowStart + x] === 1) {
        sumX += x;
        sumY += y;
        area++;
        if (x < mnX) mnX = x;
        if (x > mxX) mxX = x;
        if (y < mnY) mnY = y;
        if (y > mxY) mxY = y;
      }
    }
  }
  if (area === 0) return undefined;
  return {
    minX: mnX,
    maxX: mxX,
    minY: mnY,
    maxY: mxY,
    area,
    centroidX: sumX / area,
    centroidY: sumY / area,
  };
}

// ============================================================
// helpers: pitch
// ============================================================

/**
 * pixel y → diatonic step (C4=0)。
 * staffBand.lineYs[0] が staff 最上線 = clef ごとに決まる pitch。
 *
 * 1 line / space step = lineSpacing / 2 px。整数 round で最近傍 line/space に snap する。
 *
 * percussion clef の場合は pitch 概念がないので undefined を返す。
 */
function pixelYToDiatonic(
  y: number,
  staff: StaffBand,
  clef: PdfHideClefName,
): number | undefined {
  const cu = clef.toUpperCase();
  if (cu === 'PERCUSSION') return undefined;
  const top = CLEF_TOP_DIATONIC[cu];
  if (top === undefined) return undefined;
  const lineSpacingHalf = staff.lineSpacing / 2;
  if (lineSpacingHalf <= 0) return undefined;
  // y が小さい (上) ほど diatonic は大きい (高い) → 引き算
  const halfSteps = (y - staff.lineYs[0]) / lineSpacingHalf;
  return top - Math.round(halfSteps);
}

// ============================================================
// helpers: template match
// ============================================================

/**
 * Candidate の重心を中心として template を当て、Jaccard 係数 (前景の IoU) を返す。
 *
 * Jaccard = |img∩tpl| / |img∪tpl|
 *   - 完全一致: 1.0
 *   - 全 mismatch: 0.0
 *   - 部分一致: 中間値
 *
 * **背景同士の一致 (0=0) は無視する** のがポイント。
 * 単純な「両方一致」スコアだと sharp の小片を notehead 領域に置いた時、
 * 背景 pixel 同士の一致が score を底上げして false positive になる。
 * Jaccard は前景の重なりだけを見るので、形が違えば score が低くなる。
 *
 * notehead 検出は ±1 px の位置ズレを許すため、(cx, cy) の周辺 3×3 で評価し最良を返す。
 */
function templateMatchAtCentroid(
  bin: Uint8Array,
  width: number,
  height: number,
  cand: HeadCandidate,
  template: TemplateBitmap,
): number {
  const tw = template.width;
  const th = template.height;
  let best = 0;
  // ±2 px の位置ズレを試す (notehead 内部で centroid が微妙に偏っても拾える)
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const cxp = cand.centroidX + dx;
      const cyp = cand.centroidY + dy;
      const sx = Math.round(cxp - tw / 2);
      const sy = Math.round(cyp - th / 2);
      let inter = 0;
      let union = 0;
      for (let ty = 0; ty < th; ty++) {
        const iy = sy + ty;
        if (iy < 0 || iy >= height) {
          // template 側の前景 pixel だけ union に加算 (image 側は 0)
          for (let tx = 0; tx < tw; tx++) {
            if (template.data[ty * tw + tx] === 1) union++;
          }
          continue;
        }
        for (let tx = 0; tx < tw; tx++) {
          const ix = sx + tx;
          const tp = template.data[ty * tw + tx];
          if (ix < 0 || ix >= width) {
            if (tp === 1) union++;
            continue;
          }
          const ip = bin[iy * width + ix];
          if (tp === 1 && ip === 1) {
            inter++;
            union++;
          } else if (tp === 1 || ip === 1) {
            union++;
          }
        }
      }
      const score = union === 0 ? 0 : inter / union;
      if (score > best) best = score;
    }
  }
  return best;
}

/**
 * notehead の左に accidental template があるかをスキャンする。
 *
 * window: notehead 左端 - 2*lineSpacing ~ notehead 左端 - 0.4*lineSpacing
 * 各 x 位置で accidental template を当て、垂直方向は notehead 中心 ±lineSpacing で
 * 1 px 刻みに走査して最良を返す。
 *
 * 戻り値 0..1。
 */
function scanAccidentalLeftOf(
  bin: Uint8Array,
  width: number,
  height: number,
  nh: Notehead,
  cropBox: { x: number; y: number },
  template: TemplateBitmap,
  lineSpacing: number,
): number {
  // 入力 nh は page absolute 座標、bin は cropped 座標 → 引き算で local 化
  const localCy = nh.centroidY - cropBox.y;
  const localBboxLeft = nh.bboxX - cropBox.x;
  const tw = template.width;
  const th = template.height;
  // notehead bbox 左端 から 0.4..2.0 lineSpacing 左の範囲を走査
  const xMin = Math.round(localBboxLeft - lineSpacing * 2);
  const xMax = Math.round(localBboxLeft - lineSpacing * 0.4);
  const yMin = Math.round(localCy - lineSpacing * 1.0);
  const yMax = Math.round(localCy + lineSpacing * 1.0);
  let best = 0;
  for (let cy = yMin; cy <= yMax; cy++) {
    for (let cxp = xMin; cxp <= xMax; cxp++) {
      // template の中心が (cxp, cy)
      const sx = cxp - Math.floor(tw / 2);
      const sy = cy - Math.floor(th / 2);
      let agree = 0;
      let total = 0;
      let tplFg = 0;
      for (let ty = 0; ty < th; ty++) {
        const iy = sy + ty;
        if (iy < 0 || iy >= height) {
          total += tw;
          continue;
        }
        for (let txp = 0; txp < tw; txp++) {
          const ix = sx + txp;
          if (ix < 0 || ix >= width) {
            total += 1;
            continue;
          }
          const tp = template.data[ty * tw + txp];
          const ip = bin[iy * width + ix];
          if (tp === 1) tplFg++;
          if (tp === ip) agree += 1;
          total += 1;
        }
      }
      // false positive 抑制: 全 0 の領域に template を当てると "両方背景一致" で
      // score が高くなる → template の前景 pixel が一定数 image 側でも当たることを要求
      if (tplFg === 0) continue;
      let imgFgInTpl = 0;
      for (let ty = 0; ty < th; ty++) {
        const iy = sy + ty;
        if (iy < 0 || iy >= height) continue;
        for (let txp = 0; txp < tw; txp++) {
          const ix = sx + txp;
          if (ix < 0 || ix >= width) continue;
          if (template.data[ty * tw + txp] === 1 && bin[iy * width + ix] === 1) {
            imgFgInTpl++;
          }
        }
      }
      const fgCoverage = imgFgInTpl / tplFg;
      // template の前景 pixel に対する image 側 hit 率が低いと棄却
      if (fgCoverage < 0.5) continue;
      const score = total === 0 ? 0 : agree / total;
      if (score > best) best = score;
    }
  }
  return best;
}

// ============================================================
// helpers: stem 検出 + duration
// ============================================================

interface StemInfo {
  direction: StemDirection;
  score: number;
}

/**
 * notehead 中心の上下に stem を探す。
 *
 * 上向き: notehead 右端の少し内側から上方向 lineSpacing*3.5 pixel の column を走査、
 *         黒 pixel 比が `stemMinRatio` 以上なら up 認定。
 * 下向き: notehead 左端の少し内側から下方向 lineSpacing*3.5 pixel の column を走査、
 *         黒 pixel 比が `stemMinRatio` 以上なら down 認定。
 * 両方ヒット → score の高い方。両方棄却 → 'none'。
 */
function detectStem(
  bin: Uint8Array,
  width: number,
  height: number,
  nh: Notehead,
  cropBox: { x: number; y: number },
  lineSpacing: number,
  minRatio: number,
): StemInfo {
  // bbox の実際の角を使う (centroid ± width/2 では非対称 blob で 1 px ずれる)
  const localBboxLeft = nh.bboxX - cropBox.x;
  const localBboxRight = localBboxLeft + nh.width - 1;
  const localBboxTop = nh.bboxY - cropBox.y;
  const localBboxBottom = localBboxTop + nh.height - 1;
  const stemLen = Math.round(lineSpacing * 3.5);

  // 走査 column 候補: 端から 0..2 px 内側の 3 列を試して最良を取る (1 px ズレ吸収)
  const upXs = [localBboxRight, localBboxRight - 1, localBboxRight - 2];
  const downXs = [localBboxLeft, localBboxLeft + 1, localBboxLeft + 2];
  const yTopStart = localBboxTop;
  const yBottomStart = localBboxBottom;

  let upScore = 0;
  for (const xUp of upXs) {
    const s = scanColumn(bin, width, height, xUp, yTopStart, -1, stemLen);
    if (s > upScore) upScore = s;
  }
  let downScore = 0;
  for (const xDown of downXs) {
    const s = scanColumn(bin, width, height, xDown, yBottomStart, +1, stemLen);
    if (s > downScore) downScore = s;
  }

  if (upScore < minRatio && downScore < minRatio) {
    return { direction: 'none', score: Math.max(upScore, downScore) };
  }
  if (upScore >= downScore) {
    return { direction: 'up', score: upScore };
  }
  return { direction: 'down', score: downScore };
}

/**
 * (x, y) から (x, y + step*length-1) までの column の黒 pixel 比を返す。
 * column が画像外に出たらその分は背景扱い (= 0 と仮定)。
 */
function scanColumn(
  bin: Uint8Array,
  width: number,
  height: number,
  x: number,
  yStart: number,
  step: number,
  length: number,
): number {
  if (x < 0 || x >= width || length <= 0) return 0;
  let fg = 0;
  for (let i = 0; i < length; i++) {
    const y = yStart + step * i;
    if (y < 0 || y >= height) continue;
    if (bin[y * width + x] === 1) fg++;
  }
  return fg / length;
}

/**
 * 形状 + stem 有無 → DIV=32 unit 数。
 * 不明な組合せは undefined (warnings に格納される想定)。
 */
function inferDuration(kind: NoteheadKind, stem: StemDirection): number | undefined {
  if (kind === 'whole') return 32;
  if (kind === 'hollow') {
    // half note: stem 有が default。stem 無しの hollow は notehead 形状判定が
    // 怪しいので unknown 扱い (whole と紛れる可能性あり)
    if (stem === 'none') return undefined;
    return 16;
  }
  if (kind === 'filled') {
    if (stem === 'none') return undefined;
    return 8; // quarter note default。flag 検出を経てから 8th/16th に下げる予定
  }
  // x notehead: percussion、durationUnits は形状単独では決められない
  // とりあえず quarter (8 unit) を返す
  if (kind === 'x') {
    if (stem === 'none') return 32; // whole rest 相当の long
    return 8;
  }
  return undefined;
}
