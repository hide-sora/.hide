/**
 * hideMatrix.ts — v1.9 matrix mode (grid-aligned multi-voice analysis)
 *
 * 仕様: README §4 "Matrix mode" を参照。
 *
 * 多声音楽を「時間軸 × 声部軸」の二次元グリッドとしてアクセスするための
 * 追加レイヤー。.hide v1.8 の lexer がすでに `|` を読めるよう変更したので
 * (hideLexer.ts の HideBarlineRawToken)、ここでは AST を全く書き換えずに
 *
 *   1. パート毎にトークンを barline で「小節セル」に分割
 *   2. 各小節の duration が全パートで一致しているかチェック
 *   3. iterateMeasures() で時間整列した小節を順に取り出す API を提供
 *
 * を追加する。stream mode (compileHide) の挙動は一切変えない。
 *
 * 設計指針:
 *  - matrix mode は「読み取り専用の解析レイヤー」であり、MusicXML 出力は
 *    既存の compileHide が担う。
 *  - 同じソースを stream mode と matrix mode の両方で読めるべき (=「v1.8 と
 *    後方互換」)。
 *  - LLM が iterateMeasures() の出力をそのまま受け取って和音抽出・声部進行
 *    解析・ハモり提案などを O(1) で行える形にする。
 *  - パート数は `[1]..[N]+[P]` の宣言から自動的に分かるので、`[GRID N]` の
 *    ような strict mode 宣言は不要 (v1.9 で削除済み)。
 */

import type {
  HideHeader,
  HideToken,
  HidePitch,
  HideClef,
  PartMeta,
} from './hideTypes';
import { getPartMeta } from './hideTypes';
import { tokenize } from './hideLexer';
import type { HideRawToken, HideLexResult } from './hideLexer';
import { parse } from './hideParser';
import type { HideSourcePosition } from './hideErrors';
import { HideParseError } from './hideErrors';

// ============================================================
// 公開型
// ============================================================

/**
 * 1パート × 1小節 = 1セル。matrix の (row, measure) 要素。
 */
export interface HideMatrixCell {
  /** パートラベル (例: "1", "2", "P") */
  partLabel: string;
  /** 小節インデックス (0-based) */
  measureIndex: number;
  /** このセル内の構造化トークン (反復・連符は parse 済みだが未展開) */
  body: HideToken[];
  /**
   * このセル内の全ピッチを source 順に展開して並べたもの。
   * 和音はインライン展開し、反復は展開後の演奏順で並べる。休符は除外。
   */
  pitches: HidePitch[];
  /**
   * このセルの総演奏時間 (unit)。
   * 反復・連符は展開後 (= 実際の演奏時間) で計算する。
   */
  durationUnits: number;
}

/**
 * 1小節 (時間方向で整列したスライス)。パートラベル → セル の Map を持つ。
 */
export interface HideMatrixMeasure {
  /** 0-based 小節インデックス */
  index: number;
  /** パートラベル → セル */
  cells: Map<string, HideMatrixCell>;
  /** この小節で観測された duration (一致していれば全パート同じ。不一致時は最初に見つかった値) */
  durationUnits: number;
}

/**
 * Matrix 全体。analyzeMatrix() の中心成果物。
 */
export interface HideMatrix {
  /** ヘッダー (lex 結果から引き継ぐ) */
  header: HideHeader;
  /** パートラベルを宣言順に並べたもの */
  partLabels: string[];
  /** パートメタ情報 (displayName, midiProgram, partId) */
  partMetas: Map<string, PartMeta>;
  /**
   * パートラベル → 譜表記号 のマップ (v1.9 後期)
   *
   * `[1T][2B][3T8][4T-8]` のインライン譜表宣言および中盤の `[B]` のような
   * clefChange を LAST-WINS で適用した結果。未宣言のパートは含まれない
   * (呼び出し側は header.clef もしくは 'TREBLE' をデフォルトとして使う)。
   *
   *  - `[1T]` → partClefs['1'] = 'TREBLE'
   *  - `[2B]` → partClefs['2'] = 'BASS'
   *  - `[3T8]` → partClefs['3'] = 'TREBLE_8VA' (オクターブ上)
   *  - `[4T-8]` → partClefs['4'] = 'TREBLE_8VB' (オクターブ下)
   *  - 中盤の `[B]` → 現在のパートの値を 'BASS' に上書き
   */
  partClefs: Record<string, HideClef>;
  /** 小節の配列 (時間順) */
  measures: HideMatrixMeasure[];
}

/** 警告・エラーの種別 */
export type HideMatrixIssueKind =
  | 'measureCountMismatch'      // パートごとの小節数が違う
  | 'measureDurationMismatch'   // 同じ小節で duration が違う
  | 'cellParseError';           // セル単体のパースに失敗

export interface HideMatrixIssue {
  kind: HideMatrixIssueKind;
  message: string;
  /** 関連する小節 (0-based) */
  measureIndex?: number;
  /** 関連するパートラベル */
  partLabel?: string;
}

export interface HideMatrixResult {
  matrix: HideMatrix;
  /** 小節構造に関する警告 */
  issues: HideMatrixIssue[];
}

// ============================================================
// 公開API
// ============================================================

/**
 * .hide ソースを matrix mode で解析する。
 *
 * @param source .hide ソーステキスト
 * @returns 行=パート / 列=barline 区切り小節セル の二次元構造 + 警告
 *
 * @example
 *   const { matrix, issues } = analyzeMatrix(`
 *     [1]| C5k | E5k | G5k |
 *     [2]| G4k | G4k | G4k |
 *     [3]| E4k | C4k | E4k |
 *     [4]| C3k | C3k | C3k |
 *   `);
 *   for (const m of iterateMeasures(matrix)) {
 *     console.log(m.index, [...m.cells.entries()]);
 *   }
 */
export function analyzeMatrix(source: string): HideMatrixResult {
  const lex = tokenize(source);
  return analyzeMatrixFromLex(lex);
}

/**
 * 既に lex 済みの結果から matrix mode を構築する低レベル API。
 *
 * compileHide() と analyzeMatrix() を1パスで呼びたい消費者向け
 * (lex は冪等なのでコストは高くないが、無駄を省きたい場合に使う)。
 */
export function analyzeMatrixFromLex(lex: HideLexResult): HideMatrixResult {
  const issues: HideMatrixIssue[] = [];

  // 1. パート毎の生トークンに分割
  const { partOrder, partTokens, partClefs } = splitTokensByPart(lex.tokens);

  // パートが1つも宣言されていない場合: ソース全体を単一パート "M" として
  // 扱う (compileHide のデフォルトと揃える)。
  if (partOrder.length === 0) {
    partOrder.push('M');
    partTokens.set('M', lex.tokens.slice());
  }

  // 2. 1 小節あたりの期待 unit 数を header から計算
  //    例: TIME=4/4, DIV=32 → unitsPerMeasure = 32u
  //    auto-bucketing と duration consistency 検証の両方で使う。
  const unitsPerMeasure = Math.round(
    (lex.header.timeNum / lex.header.timeDen) * lex.header.div,
  );

  // 3. 各パートをセルに分割し、各セルをパースして body/pitches/duration を計算
  //    `|` を一切書かないユーザーへの配慮: パース後のセルが unitsPerMeasure より長ければ
  //    自動的に小節サイズ単位で splitCellByMeasure する (compileHide の bucketize と同等)。
  const cellsByPart = new Map<string, HideMatrixCell[]>();
  let maxMeasureCount = 0;
  for (const label of partOrder) {
    const tokens = partTokens.get(label)!;
    const rawCells = splitTokensIntoCells(tokens);
    const matrixCells: HideMatrixCell[] = [];
    for (let mi = 0; mi < rawCells.length; mi++) {
      const cell = parseMatrixCell(label, mi, rawCells[mi], lex, issues);
      // auto-bucket: ユーザーが `|` を省略した場合、cell が unitsPerMeasure より
      // 長くなるので、ここで小節サイズ単位に再分割する。連符・反復は atomic として扱う。
      if (
        unitsPerMeasure > 0 &&
        cell.durationUnits > unitsPerMeasure
      ) {
        const subCells = splitCellByMeasure(cell, unitsPerMeasure);
        for (const sub of subCells) {
          sub.measureIndex = matrixCells.length;
          matrixCells.push(sub);
        }
      } else {
        cell.measureIndex = matrixCells.length;
        matrixCells.push(cell);
      }
    }
    cellsByPart.set(label, matrixCells);
    if (matrixCells.length > maxMeasureCount) maxMeasureCount = matrixCells.length;
  }

  // 4. 小節数の不一致を検出
  for (const label of partOrder) {
    const cells = cellsByPart.get(label)!;
    if (cells.length !== maxMeasureCount) {
      issues.push({
        kind: 'measureCountMismatch',
        message: `パート [${label}] の小節数は ${cells.length}、最大は ${maxMeasureCount}`,
        partLabel: label,
      });
    }
  }

  // 5. 小節を構築 + duration consistency チェック (小節単位)
  //    空セル (`[1]| C4m | | E4m |` の中央) は durationUnits=0 になるので必ずここで弾かれる。
  const measures: HideMatrixMeasure[] = [];
  for (let mi = 0; mi < maxMeasureCount; mi++) {
    const measureCells = new Map<string, HideMatrixCell>();
    let referenceDuration: number | undefined;
    let referencePart: string | undefined;
    for (const label of partOrder) {
      const partCells = cellsByPart.get(label)!;
      const cell = partCells[mi];
      if (!cell) continue;
      measureCells.set(label, cell);
      // (a) header の time signature × DIV と一致するか
      if (cell.durationUnits !== unitsPerMeasure) {
        issues.push({
          kind: 'measureDurationMismatch',
          message: `小節 ${mi + 1}: パート [${label}] の duration は ${cell.durationUnits}u、ヘッダー (${lex.header.timeNum}/${lex.header.timeDen}, DIV=${lex.header.div}) の期待値 ${unitsPerMeasure}u と一致しません`,
          measureIndex: mi,
          partLabel: label,
        });
      }
      // (b) 同じ小節内で他パートと一致するか (header check が両方失敗するケースのために残す)
      if (referenceDuration === undefined) {
        referenceDuration = cell.durationUnits;
        referencePart = label;
      } else if (cell.durationUnits !== referenceDuration) {
        issues.push({
          kind: 'measureDurationMismatch',
          message: `小節 ${mi + 1}: パート [${label}] の duration は ${cell.durationUnits}u、[${referencePart}] の ${referenceDuration}u と一致しません`,
          measureIndex: mi,
          partLabel: label,
        });
      }
    }
    measures.push({ index: mi, cells: measureCells, durationUnits: referenceDuration ?? 0 });
  }

  // 5. パートメタ情報を構築 (getPartMeta は番号付き/[P]/フォールバックを動的に処理)
  const partMetas = new Map<string, PartMeta>();
  for (const label of partOrder) {
    if (label === 'M') {
      // hideExpander.ts と揃える: 単一パート時のデフォルトラベル
      partMetas.set(label, { partId: 'P_M', displayName: 'Voice', midiProgram: 53 });
    } else {
      partMetas.set(label, getPartMeta(label));
    }
  }

  const matrix: HideMatrix = {
    header: lex.header,
    partLabels: partOrder,
    partMetas,
    partClefs,
    measures,
  };

  return { matrix, issues };
}

/**
 * matrix.measures を順に yield する。
 *
 * @example
 *   for (const m of iterateMeasures(matrix)) {
 *     // m.cells: Map<partLabel, HideMatrixCell>
 *     const allPitches = [...m.cells.values()].flatMap(c => c.pitches);
 *     // → この小節の和音 (= 全パートのその時点ピッチ)
 *   }
 */
export function* iterateMeasures(matrix: HideMatrix): Generator<HideMatrixMeasure> {
  for (const m of matrix.measures) {
    yield m;
  }
}

/**
 * 小節を「和音」として返す簡便ヘルパー。
 * 各小節で全パートのピッチを (パート宣言順 × セル内 source 順) で連結したフラットな配列を返す。
 *
 * 用途: ハモり提案・和声分析・LLM プロンプト生成のための「時刻 t での全鳴音」抽出。
 */
export function measureToChord(matrix: HideMatrix, measure: HideMatrixMeasure): HidePitch[] {
  const out: HidePitch[] = [];
  for (const label of matrix.partLabels) {
    const cell = measure.cells.get(label);
    if (!cell) continue;
    for (const p of cell.pitches) out.push(p);
  }
  return out;
}

// ============================================================
// 内部ヘルパー
// ============================================================

/**
 * 生トークン列をパート毎に振り分ける。
 *
 * - 最初の partSwitch に出会うまでのトークンは「pre-amble」として捨てる
 *   (matrix mode はパート宣言後のセルだけを扱う設計。preamble にある
 *    [T120] などは stream mode の compileHide で処理されるべき)
 * - partLabel が再出現した場合、同じパートの末尾に append する
 *   (例: `[1]C4k[2]E4k[1]D4k` で part 1 = [C4k, D4k])
 * - partSwitch が `[1T]` `[2B]` のように clef を伴っていれば partClefs に
 *   記録する (LAST-WINS)。単独 `[T]` `[B]` の clefChange も同様に現在パート
 *   の clef を上書きする。
 */
function splitTokensByPart(rawTokens: HideRawToken[]): {
  partOrder: string[];
  partTokens: Map<string, HideRawToken[]>;
  partClefs: Record<string, HideClef>;
} {
  const partTokens = new Map<string, HideRawToken[]>();
  const partOrder: string[] = [];
  const partClefs: Record<string, HideClef> = {};
  let currentPart: string | null = null;

  for (const tok of rawTokens) {
    if (tok.kind === 'meta' && tok.type === 'partSwitch' && tok.partLabel) {
      currentPart = tok.partLabel;
      if (!partTokens.has(currentPart)) {
        partTokens.set(currentPart, []);
        partOrder.push(currentPart);
      }
      // [1T] のように clef 付きならパートの clef を更新 (LAST-WINS)
      if (tok.clef) {
        partClefs[currentPart] = tok.clef;
      }
      continue;
    }
    // 単独 [T] [B] [T8] [T-8] は現在パートの clef を上書き (LAST-WINS)
    if (tok.kind === 'meta' && tok.type === 'clefChange' && tok.clef) {
      if (currentPart !== null) {
        partClefs[currentPart] = tok.clef;
      }
      continue;
    }
    if (currentPart === null) continue; // pre-amble: ignore
    partTokens.get(currentPart)!.push(tok);
  }

  return { partOrder, partTokens, partClefs };
}

/**
 * 生トークン列を「小節区切り」で小節セルに分割する。
 *
 * セル区切りとして認識するもの:
 *  - `|` (barline) — v1.8 からの grid form 区切り
 *  - `.` 系 (measureBarrier, 通常/複/終止/repeatEnd) — v1.9 で導入された stream form 区切り
 *    `.:` (repeatStart) は次の小節の左端マーカーであり区切りそのものではないため除外
 *
 * 空セルの扱い:
 *  - 先頭・末尾の完全空セルは捨てる (`[1]| C4k | D4k |` → 2セル)
 *  - **同種連続** `| |` や `. .` の間の空セルは「明示的な空小節」として残す
 *    (例: `[1]| C4k | | D4k |` → 3セル、中央は duration=0 の空セル)
 *  - **異種連続** `| .` や `. |` は round-trip 出力由来の冗長境界 (= grid form の `|`
 *    と barline style の `.` 系を併記したケース) なので 1 つの境界として潰す
 *    cf. musicXmlToHide.ts の `convertMeasureToHide` がセル末尾に `.` 系を付加する
 */
function splitTokensIntoCells(tokens: HideRawToken[]): HideRawToken[][] {
  const cells: HideRawToken[][] = [];
  let current: HideRawToken[] = [];
  // 直前に見た区切りの種類 (note/rest が来たら null にリセット)
  let lastSeparatorKind: 'barline' | 'measureBarrier' | null = null;
  for (const tok of tokens) {
    const isBarline = tok.kind === 'barline';
    const isBarrier = tok.kind === 'measureBarrier' && tok.style !== 'repeatStart';
    if (isBarline || isBarrier) {
      const thisKind: 'barline' | 'measureBarrier' = isBarline ? 'barline' : 'measureBarrier';
      // 異種連続 (`| .` や `. |`) で間に演奏要素がなければ「同じ境界の二重表現」
      // とみなし、既に push 済みの境界を再利用する。
      if (
        lastSeparatorKind !== null &&
        lastSeparatorKind !== thisKind &&
        isCellPlayablyEmpty(current)
      ) {
        current = [];
        lastSeparatorKind = thisKind;
        continue;
      }
      cells.push(current);
      current = [];
      lastSeparatorKind = thisKind;
    } else {
      current.push(tok);
      // 演奏要素 (note/rest) が現れたら異種コアレッシング対象から外れる
      // (lyric/tie/repeatStart は「ほぼ空」とみなして lastSeparatorKind を維持)
      if (tok.kind === 'note' || tok.kind === 'rest') {
        lastSeparatorKind = null;
      }
    }
  }
  cells.push(current);
  // 先頭・末尾の完全空セルだけ削る (内部空セルは残す)
  while (cells.length > 0 && isCellPlayablyEmpty(cells[0])) cells.shift();
  while (cells.length > 0 && isCellPlayablyEmpty(cells[cells.length - 1])) cells.pop();
  return cells;
}

/**
 * セルが演奏要素 (note/rest/tuplet/repeat) を含まないかを判定。
 * 歌詞・タイ・メタだけのセルは「空」とみなす。
 */
function isCellPlayablyEmpty(tokens: HideRawToken[]): boolean {
  for (const t of tokens) {
    if (t.kind === 'note' || t.kind === 'rest') return false;
    if (t.kind === 'tupletOpen' || t.kind === 'tupletClose') return false;
    if (t.kind === 'repeatBoundary') return false;
  }
  return true;
}

/** セル単位で再パースして body / duration / pitches を計算 */
function parseMatrixCell(
  partLabel: string,
  measureIndex: number,
  cellTokens: HideRawToken[],
  outerLex: HideLexResult,
  issues: HideMatrixIssue[],
): HideMatrixCell {
  // 合成 lex result を組み立てる (positions は cell の中での相対位置がないため
  // ダミーで埋める。エラーメッセージ用なので "cell スコープ内" であることが分かれば十分)
  const dummyPos: HideSourcePosition = { offset: 0, line: 1, column: 1 };
  const positions: HideSourcePosition[] = cellTokens.map(() => dummyPos);
  const cellLex: HideLexResult = {
    header: outerLex.header,
    tokens: cellTokens,
    positions,
    source: outerLex.source,
  };
  let body: HideToken[] = [];
  try {
    const parseResult = parse(cellLex);
    body = parseResult.ast.body;
  } catch (e) {
    if (e instanceof HideParseError) {
      issues.push({
        kind: 'cellParseError',
        message: `パート [${partLabel}] 小節 ${measureIndex + 1} のセルパースに失敗: ${e.message}`,
        partLabel,
        measureIndex,
      });
    } else {
      throw e;
    }
  }
  return {
    partLabel,
    measureIndex,
    body,
    pitches: collectPitches(body),
    durationUnits: computeBodyDuration(body),
  };
}

/**
 * 1セルが unitsPerMeasure より長い場合、複数の小節セルに自動分割する。
 *
 * 動機: ユーザーが `|` を一切書かずに `[1] C4k C4k C4k C4k C4k C4k C4k C4k`
 * のように flat に並べた場合でも、4/4 拍子なら自動的に 2 小節に分割して
 * 描画したい。stream mode の compileHide → bucketize() と同じ振る舞いを
 * matrix mode にも持たせるための再分割パス。
 *
 *  - note / rest: durationUnits を累積。`current + dur > unitsPerMeasure` で次セルへ。
 *  - tuplet     : targetUnits を累積。atomic 扱い (中で割らない)。
 *  - repeat     : 展開後の総演奏時間を累積。atomic 扱い。
 *  - meta       : duration 0。current にぶら下げて流す (頭出しテンポ等)。
 *
 * tuplet/repeat の途中で小節境界を跨ぐケースは現状で警告を出さないが、
 * `|` を明示する書き方が必要なケースとしてユーザーに任せる。
 */
function splitCellByMeasure(
  cell: HideMatrixCell,
  unitsPerMeasure: number,
): HideMatrixCell[] {
  if (cell.durationUnits <= unitsPerMeasure || unitsPerMeasure <= 0) {
    return [cell];
  }
  const subBodies: HideToken[][] = [];
  let current: HideToken[] = [];
  let currentUnits = 0;
  for (const tok of cell.body) {
    let dur = 0;
    if (tok.kind === 'note' || tok.kind === 'rest') {
      dur = tok.durationUnits;
    } else if (tok.kind === 'tuplet') {
      dur = tok.targetUnits;
    } else if (tok.kind === 'repeat') {
      dur =
        computeBodyDuration(tok.body) * Math.max(1, Math.floor(tok.count));
    }
    // 次のトークンを current に積むと unitsPerMeasure を超えるなら、
    // 先に current を閉じて新しい sub-cell を開く (current が空の時は閉じない)
    if (
      dur > 0 &&
      currentUnits > 0 &&
      currentUnits + dur > unitsPerMeasure
    ) {
      subBodies.push(current);
      current = [];
      currentUnits = 0;
    }
    current.push(tok);
    currentUnits += dur;
    // ぴったり 1 小節分埋まったら閉じる
    if (currentUnits >= unitsPerMeasure && currentUnits > 0) {
      subBodies.push(current);
      current = [];
      currentUnits = 0;
    }
  }
  if (current.length > 0) subBodies.push(current);

  return subBodies.map((body, i) => ({
    partLabel: cell.partLabel,
    measureIndex: cell.measureIndex + i, // caller が再採番する
    body,
    pitches: collectPitches(body),
    durationUnits: computeBodyDuration(body),
  }));
}

/**
 * AST body の総演奏時間を unit 単位で計算する (反復・連符を展開後)。
 * メタ・歌詞・タイは 0 を寄与する。
 */
function computeBodyDuration(body: HideToken[]): number {
  let sum = 0;
  for (const tok of body) {
    if (tok.kind === 'note' || tok.kind === 'rest') {
      sum += tok.durationUnits;
    } else if (tok.kind === 'tuplet') {
      sum += tok.targetUnits;
    } else if (tok.kind === 'repeat') {
      sum += computeBodyDuration(tok.body) * Math.max(1, Math.floor(tok.count));
    }
  }
  return sum;
}

/**
 * AST body から全ピッチを source 順 (反復は演奏順、和音はインライン) で収集する。
 * 休符は含めない (matrix mode の典型用途は和音抽出なので)。
 */
function collectPitches(body: HideToken[]): HidePitch[] {
  const out: HidePitch[] = [];
  for (const tok of body) {
    if (tok.kind === 'note') {
      for (const p of tok.pitches) out.push(p);
    } else if (tok.kind === 'tuplet') {
      for (const m of tok.members) {
        if (m.kind === 'note') for (const p of m.pitches) out.push(p);
      }
    } else if (tok.kind === 'repeat') {
      const inner = collectPitches(tok.body);
      const count = Math.max(1, Math.floor(tok.count));
      for (let i = 0; i < count; i++) for (const p of inner) out.push(p);
    }
  }
  return out;
}
