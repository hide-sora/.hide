/**
 * musicXmlToHide.ts (M2H) — MusicXML を .hide v2.1 ソースに完全変換する
 *
 * v2.1 (M2H):
 *  - v2.0 全機能 + Finale Broadway 全グリフ対応
 *  - DIV=64 ベース (g-n 8段階)
 *  - 臨時記号: # b * x bb (ダブルシャープ/ダブルフラット対応)
 *  - アーティキュレーション: s S > - ~ ~s ~l ^ V W O X T
 *  - オーナメント: tr mr MR tn TN z1-z3 ar gl vb bn
 *  - ジャズ: jf jd jp js (fall/doit/plop/scoop)
 *  - ノートヘッド: !d !x !/ !t
 *  - メタ: segno, coda, jump, rehearsal, text, expression, ottava, pedal,
 *          chord, breath, caesura, fingering, string, swing/straight, mmr
 *  - 小節線: , ,, ,,, ,: :, ,- ,.
 *  - 音部記号: SOPRANO, BARITONE, TREBLE_8VA, TREBLE_8VB
 *  - 非標準 duration → tied chain 分解 (近似廃止)
 *  - パート名抽出 (<part-name> → [1:Piano])
 *  - マイナーキー対応 (<mode>minor → KEY:Am)
 */

import type { HidePitch, HideBarlineStyle } from './hideTypes';

// ============================================================
// 公開型
// ============================================================

export interface MusicXmlToHideOptions {
  /**
   * パートラベル割り当て方式。
   *  - 'numbered' (default): 上から `[1] [2] [3] ...`
   *  - カスタム配列: 順番にラベルを使う (例: `['1', '2', '3', '4']`)
   *    部分数が不足する場合は残りを numbered で補完。
   */
  partLabels?: string[];
  /**
   * 末尾改行 / セル間スペース等の整形オプション。
   * 無指定なら "humanReadable" 風 (整列・1パート1行)。
   */
  pretty?: boolean;
}

/**
 * 逆変換中に検出した構造化された不整合・省略・近似情報。
 *
 * **設計意図:** PDF→MusicXML→.hide pipeline では下流に LLM レビュー層を置き、
 * 生 PDF 画像と照合して構造的におかしい箇所を判定させる。そのため
 * silent fill / silent normalize は **しない** — 不整合をそのまま LLM の
 * attention 候補リストとして渡せるよう、構造化された discriminated union
 * で emit する。`warnings: string[]` は人間ログ用にそのまま残るが、
 * LLM プロンプト生成は必ず `diagnostics` を消費すること。
 *
 * 各 kind は「外部 MusicXML データ起因」の問題のみ。.hide 側の構造的
 * 整合性 (cell duration や measure count の不一致) は `analyzeMatrix(hideSource)`
 * 側の `HideMatrixIssue` に任せる (二重実装しない)。
 */
export type MusicXmlToHideDiagnostic =
  | {
      /** あるパートの `<measure>` 数が他パートと異なる */
      kind: 'partMeasureCountMismatch';
      partIndex: number;
      partLabel: string;
      got: number;
      expected: number;
    }
  | {
      /** `<attributes>` ブロックが複数 (= 拍子・調号の中途変更を検出・変換済み) */
      kind: 'multipleAttributes';
      partIndex: number;
    }
  | {
      /** 1 パート内に複数 `<voice>` (= 多声 1 パート、voice=1 のみ採用) */
      kind: 'multipleVoices';
      partIndex: number;
      measureIndex: number;
      voices: number[];
    }
  | {
      /** 標準長さ (h/i/j/k/l/m) にマッチしない duration — 最近接で近似 */
      kind: 'nonStandardDuration';
      partIndex: number;
      measureIndex: number;
      durationUnits: number;
    };

export interface MusicXmlToHideResult {
  /** 変換済みの .hide ソーステキスト */
  hideSource: string;
  /** ヘッダーから抽出した値 (デバッグ用) */
  header: {
    timeNum: number;
    timeDen: number;
    keyFifths: number;
    div: number;
    clef: string;
  };
  /** 変換中に検出した警告 (人間ログ用、文字列。`diagnostics` と同じ事象を別フォーマットで含む) */
  warnings: string[];
  /**
   * 構造化された不整合・省略・近似情報。LLM レビュー層用。
   * `warnings` と意味的に同じ事象を含むが、kind 付きの discriminated union なので
   * プログラマブルに扱える。
   */
  diagnostics: MusicXmlToHideDiagnostic[];
  /** パート数 (= MusicXML の `<part>` 数) */
  partsCount: number;
  /** 小節数 (= 最大パートの `<measure>` 数) */
  measuresCount: number;
}

// ============================================================
// 公開API
// ============================================================

/**
 * MusicXML 文字列を .hide ソース文字列に変換する。
 *
 * @example
 *   const xml = readBachChorale001();
 *   const { hideSource } = musicXmlToHide(xml);
 *   const { matrix } = analyzeMatrix(hideSource);
 *   for (const m of iterateMeasures(matrix)) { ... }
 */
export function musicXmlToHide(
  xml: string,
  opts: MusicXmlToHideOptions = {},
): MusicXmlToHideResult {
  const warnings: string[] = [];
  const diagnostics: MusicXmlToHideDiagnostic[] = [];

  // 1. コメント除去
  let stripped = xml.replace(/<!--[\s\S]*?-->/g, '');

  // 1b. score-timewise → score-partwise 変換
  if (/<score-timewise/.test(stripped)) {
    stripped = timewiseToPartwise(stripped);
  }

  // 2. <part> ブロック抽出 (ID 付き)
  const parts = extractParts(stripped);
  if (parts.length === 0) {
    throw new Error('musicXmlToHide: no <part> elements found');
  }

  // 2b. <part-list> からパート名を抽出 (M2H: [1:Piano] 形式)
  const partNames = extractPartNames(stripped, parts);

  // 3. 1小節目の <attributes> からヘッダーを抽出 (最初のパート優先)
  const header = extractHeader(parts[0].body, warnings, diagnostics, 0);

  // 4. 小節番号ベースで全パートを揃えて変換（欠落小節は全休符で補完）
  const partLabels = assignPartLabels(parts.length, opts.partLabels, partNames);
  const partOutputs = convertAllPartsAligned(parts, header, warnings, diagnostics, partLabels);
  const maxMeasureCount = partOutputs.length > 0 ? partOutputs[0].length : 0;

  // 4b. パートごとの clef を抽出 (header とは独立)
  const partClefs = extractPartClefs(parts, header);

  // 5. .hide ソース組み立て (grid form)
  const lines: string[] = [];

  // ヘッダー行
  lines.push(formatHeader(header));

  // 各パートを 1 行で出力 (インライン形式: barline トークンのみで小節区切り)
  const clefAbbr: Record<string, string> = {
    TREBLE: 'T', TREBLE_8VA: 'T8', TREBLE_8VB: 'T-8', BASS: 'B',
    ALTO: 'A', TENOR: 'Te', PERCUSSION: 'Pe', SOPRANO: 'So', BARITONE: 'Br',
  };
  for (let pi = 0; pi < parts.length; pi++) {
    const label = partLabels[pi];
    const cells = partOutputs[pi];
    // パートの clef がヘッダーと異なる場合、ラベルに clef 略称を付加 (例: [5Pe])
    // [N:Name] 形式の場合は [NClef:Name] にする (例: [2Pe:Drums])
    const partClef = partClefs[pi];
    const clefSuffix = (partClef && partClef !== header.clef) ? (clefAbbr[partClef] || '') : '';
    let fullLabel: string;
    if (clefSuffix && label.includes(':')) {
      // [2:Drums] + Pe → [2Pe:Drums]
      const colonIdx = label.indexOf(':');
      fullLabel = label.slice(0, colonIdx) + clefSuffix + label.slice(colonIdx);
    } else {
      fullLabel = label + clefSuffix;
    }
    lines.push(`[${fullLabel}]| ${cells.join(' | ')} |`);
  }

  return {
    hideSource: lines.join('\n'),
    header,
    warnings,
    diagnostics,
    partsCount: parts.length,
    measuresCount: maxMeasureCount,
  };
}

// ============================================================
// 内部: <part> 抽出
// ============================================================

interface RawPart {
  id: string;
  body: string;
}

function extractParts(xml: string): RawPart[] {
  const out: RawPart[] = [];
  // <part id="X"> ... </part> を非貪欲に拾う（シングル/ダブルクォート、スペース対応）
  const re = /<part\s+id\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/part>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push({ id: m[1], body: m[2] });
  }
  return out;
}

/** score-timewise 形式を score-partwise 形式に変換 */
function timewiseToPartwise(xml: string): string {
  const measureRe = /<measure\b([^>]*?)>([\s\S]*?)<\/measure>/g;
  const partMap = new Map<string, string[]>();
  const partOrder: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = measureRe.exec(xml)) !== null) {
    const numMatch = /number\s*=\s*["']([^"']*)["']/.exec(m[1]);
    const num = numMatch ? numMatch[1] : String(partOrder.length + 1);
    const measureInner = m[2];

    // 各 <measure> 内の <part> を抽出
    const partRe = /<part\s+id\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/part>/g;
    let pm: RegExpExecArray | null;
    while ((pm = partRe.exec(measureInner)) !== null) {
      const pid = pm[1];
      if (!partMap.has(pid)) {
        partMap.set(pid, []);
        partOrder.push(pid);
      }
      partMap.get(pid)!.push(`<measure number="${num}">${pm[2]}</measure>`);
    }
  }

  // partwise 形式として再構築
  const partsXml = partOrder
    .map(id => `<part id="${id}">${partMap.get(id)!.join('')}</part>`)
    .join('');
  return `<score-partwise>${partsXml}</score-partwise>`;
}

// ============================================================
// 内部: ヘッダー抽出
// ============================================================

interface ParsedHeader {
  timeNum: number;
  timeDen: number;
  keyFifths: number;
  keyMode: 'major' | 'minor';
  div: number;
  divisionsXml: number;
  clef: string;
}

function extractHeader(
  partBody: string,
  warnings: string[],
  diagnostics: MusicXmlToHideDiagnostic[],
  partIndex: number,
): ParsedHeader {
  // 最初の <attributes> ブロックだけを見る
  const attrMatch = /<attributes>([\s\S]*?)<\/attributes>/.exec(partBody);
  const attrBody = attrMatch ? attrMatch[1] : '';

  const divisionsXml = parseIntFromTag(attrBody, 'divisions') ?? 8;
  const fifths = parseIntFromTag(attrBody, 'fifths') ?? 0;
  const beats = parseIntFromTag(attrBody, 'beats') ?? 4;
  const beatType = parseIntFromTag(attrBody, 'beat-type') ?? 4;
  // v2.1: minor key detection
  const modeMatch = /<mode>(\w+)<\/mode>/.exec(attrBody);
  const keyMode: 'major' | 'minor' = modeMatch?.[1]?.toLowerCase() === 'minor' ? 'minor' : 'major';

  // <clef><sign>X</sign><line>N</line></clef> → 我々の HideClef
  const clefSign = /<sign>(\w+)<\/sign>/.exec(attrBody)?.[1];
  const clefLine = parseIntFromTag(attrBody, 'line');
  const clefOctaveChange = parseIntFromTag(attrBody, 'clef-octave-change');
  const clef = inferClef(clefSign, clefLine, clefOctaveChange);

  // div: MusicXML の divisions = quarter note 1個あたりの単位
  //      → 全音符 = 4 * divisions = .hide の DIV
  const div = divisionsXml * 4;

  // 中途変更検出 (簡易: 2個目以降の <attributes> の有無)
  const attrCount = (partBody.match(/<attributes>/g) ?? []).length;
  if (attrCount > 1) {
    warnings.push('複数の <attributes> ブロックを検出しました (拍子・調号の中途変更を検出・変換済み)');
    diagnostics.push({ kind: 'multipleAttributes', partIndex });
  }

  return {
    timeNum: beats,
    timeDen: beatType,
    keyFifths: fifths,
    keyMode,
    div,
    divisionsXml,
    clef,
  };
}

/**
 * 各パートの <attributes> から clef を抽出する。
 * MIDI channel 10 のパートも percussion と見なす。
 */
function extractPartClefs(parts: RawPart[], header: ParsedHeader): (string | undefined)[] {
  return parts.map((p, pi) => {
    if (pi === 0) return header.clef; // 最初のパートは header と同一
    const attrMatch = /<attributes>([\s\S]*?)<\/attributes>/.exec(p.body);
    if (!attrMatch) return undefined;
    const attrBody = attrMatch[1];
    const clefSign = /<sign>(\w+)<\/sign>/.exec(attrBody)?.[1];
    if (!clefSign) return undefined;
    const clefLine = parseIntFromTag(attrBody, 'line');
    const clefOctaveChange = parseIntFromTag(attrBody, 'clef-octave-change');
    return inferClef(clefSign, clefLine, clefOctaveChange);
  });
}

function parseIntFromTag(xml: string, tag: string): number | undefined {
  const re = new RegExp(`<${tag}>(-?\\d+)<\\/${tag}>`);
  const m = re.exec(xml);
  return m ? parseInt(m[1], 10) : undefined;
}

function parseFloatFromTag(xml: string, tag: string): number | undefined {
  const re = new RegExp(`<${tag}>(-?[\\d.]+)<\\/${tag}>`);
  const m = re.exec(xml);
  return m ? parseFloat(m[1]) : undefined;
}

function inferClef(
  sign: string | undefined,
  line: number | undefined,
  octaveChange?: number,
): string {
  if (!sign) return 'TREBLE';
  const s = sign.toUpperCase();
  if (s === 'G') {
    if (octaveChange === 1) return 'TREBLE_8VA';
    if (octaveChange === -1) return 'TREBLE_8VB';
    return 'TREBLE';
  }
  if (s === 'F') {
    if (line === 3) return 'BARITONE';
    return 'BASS';
  }
  if (s === 'C') {
    if (line === 1) return 'SOPRANO';
    if (line === 4) return 'TENOR';
    return 'ALTO'; // default C clef = alto (line 3)
  }
  if (s === 'PERCUSSION') return 'PERCUSSION';
  return 'TREBLE';
}

function formatHeader(h: ParsedHeader): string {
  const parts: string[] = [];
  if (h.clef !== 'TREBLE') parts.push(`CLEF:${h.clef}`);
  if (h.timeNum !== 4 || h.timeDen !== 4) parts.push(`TIME:${h.timeNum}/${h.timeDen}`);
  // v2.1: KEY は名前形式 (KEY:D, KEY:Am) — パーサーは数値/名前の両方を受容
  if (h.keyFifths !== 0 || h.keyMode === 'minor') {
    const keyName = fifthsToKeyName(h.keyFifths, h.keyMode);
    parts.push(`KEY:${keyName}`);
  }
  if (h.div !== 64) parts.push(`DIV:${h.div}`);
  if (parts.length === 0) return '';
  return `[${parts.join(' ')}]`;
}

// ============================================================
// 内部: パート → セル列変換
// ============================================================

interface XmlNote {
  isRest: boolean;
  isWholeMeasureRest: boolean;
  isChordContinuation: boolean;
  duration: number; // MusicXML の <duration>
  dots: number;     // <dot/> の個数 (0, 1, 2)
  pitch?: HidePitch;
  isUnpitched: boolean;  // <unpitched> 要素 (パーカッション)
  notehead?: 'diamond' | 'x' | 'slash' | 'triangle'; // <notehead> 要素
  tieStart: boolean;
  voice: number;
  hasTimeModification: boolean;
  // articulations / ornaments
  slurStart: boolean;
  slurEnd: boolean;
  staccato: boolean;
  staccatissimo: boolean;
  accent: boolean;
  tenuto: boolean;
  fermata: boolean;
  marcato: boolean;
  trill: boolean;
  mordent: boolean;
  turn: boolean;
  tremolo: 0 | 1 | 2 | 3;
  arpeggio: boolean;
  glissando: boolean;
  // v2.1 bowing / techniques
  upBow: boolean;
  downBow: boolean;
  harmonicNote: boolean;
  snapPizzicato: boolean;
  stopped: boolean;
  // v2.1 inverted ornaments
  invertedMordent: boolean;
  invertedTurn: boolean;
  // v2.1 jazz articulations
  fall: boolean;
  doit: boolean;
  plop: boolean;
  scoop: boolean;
  // v2.1 misc
  vibrato: boolean;
  bend: boolean;
  fermataType: '' | 'normal' | 'short' | 'long';
  breathMark: boolean;
  caesura: boolean;
  isGrace: boolean;
  isAcciaccatura: boolean;
  actualNotes?: number;
  normalNotes?: number;
  tupletType?: 'start' | 'stop';
  lyricText?: string;
}

/** 小節内の要素 (音符・方向指示・属性変更・ハーモニー) を位置順で保持 */
interface MeasureEvent {
  pos: number;
  kind: 'note' | 'direction' | 'attributes' | 'harmony';
  body: string;
}

/** 小節番号ベースで全パートを揃えて変換する。欠落小節は全休符で補完。 */
function convertAllPartsAligned(
  parts: { id: string; body: string }[],
  header: ParsedHeader,
  warnings: string[],
  diagnostics: MusicXmlToHideDiagnostic[],
  partLabels: string[],
): string[][] {
  // 1. 全パートから番号付き小節を抽出
  const allPartMeasures = parts.map(p => extractNumberedMeasures(p.body));

  // 2. 小節番号のマスターリスト構築（全パートの和集合、数値順ソート）
  const allNums = new Set<string>();
  for (const pm of allPartMeasures) {
    for (const m of pm) allNums.add(m.num);
  }
  const masterNumbers = [...allNums].sort((a, b) => {
    // "7" → [7, 0], "7§1" → [7, 1] としてソート
    const [baseA, suffA] = a.split('§');
    const [baseB, suffB] = b.split('§');
    const na = parseFloat(baseA);
    const nb = parseFloat(baseB);
    if (!isNaN(na) && !isNaN(nb)) {
      if (na !== nb) return na - nb;
      return (parseInt(suffA) || 0) - (parseInt(suffB) || 0);
    }
    return a.localeCompare(b);
  });

  // 3. 各パートを小節番号→本体のマップ化し、マスター順で変換
  const partOutputs: string[][] = [];
  for (let pi = 0; pi < parts.length; pi++) {
    // パートごとの divisions を抽出（パート間で異なる場合に対応）
    const partHeader = { ...header };
    const partAttrMatch = /<attributes>([\s\S]*?)<\/attributes>/.exec(parts[pi].body);
    if (partAttrMatch) {
      const partDiv = parseIntFromTag(partAttrMatch[1], 'divisions');
      if (partDiv !== undefined && partDiv !== header.divisionsXml) {
        partHeader.divisionsXml = partDiv;
        partHeader.div = partDiv * 4;
      }
    }

    const measureMap = new Map<string, string>();
    for (const m of allPartMeasures[pi]) {
      measureMap.set(m.num, m.body);
    }

    const out: string[] = [];
    let runningTimeNum = partHeader.timeNum;
    let runningTimeDen = partHeader.timeDen;
    let runningKeyFifths = partHeader.keyFifths;

    for (let mi = 0; mi < masterNumbers.length; mi++) {
      const body = measureMap.get(masterNumbers[mi]);
      if (body !== undefined) {
        // 通常の小節変換
        const result = convertMeasureToHide(
          body, partHeader, warnings, diagnostics, pi, mi,
          runningTimeNum, runningTimeDen, runningKeyFifths,
        );
        out.push(result.tokens);
        if (result.newTimeNum !== undefined) runningTimeNum = result.newTimeNum;
        if (result.newTimeDen !== undefined) runningTimeDen = result.newTimeDen;
        if (result.newKeyFifths !== undefined) runningKeyFifths = result.newKeyFifths;
      } else {
        // 欠落小節 → 全休符で補完
        const restTok = durationToRest(
          measureRestUnits(partHeader, runningTimeNum, runningTimeDen),
          partHeader, warnings, diagnostics, pi, mi, 0,
        );
        out.push(`${restTok || 'Rn'} ,`);
      }
    }

    // 欠落があった場合 diagnostic を emit
    if (allPartMeasures[pi].length < masterNumbers.length) {
      const missing = masterNumbers.length - allPartMeasures[pi].length;
      diagnostics.push({
        kind: 'partMeasureCountMismatch',
        partIndex: pi,
        partLabel: partLabels[pi],
        got: allPartMeasures[pi].length,
        expected: masterNumbers.length,
      });
      warnings.push(`パート#${pi + 1} (${partLabels[pi]}) は ${missing} 小節が欠落 — 全休符で補完`);
    }

    partOutputs.push(out);
  }
  return partOutputs;
}

interface NumberedMeasure {
  num: string;
  body: string;
}

function extractNumberedMeasures(partBody: string): NumberedMeasure[] {
  const out: NumberedMeasure[] = [];
  // 通常の <measure ...>...</measure> と自己閉じ <measure ... /> の両方にマッチ
  const re = /<measure\b([^>]*?)(?:\s*\/\s*>|>([\s\S]*?)<\/measure>)/g;
  let m: RegExpExecArray | null;
  let seq = 0;
  const countByNum = new Map<string, number>();

  function addMeasure(rawNum: string, body: string) {
    const occ = countByNum.get(rawNum) ?? 0;
    countByNum.set(rawNum, occ + 1);
    // 同じ番号の重複出現にサフィックスを付与（volta等）
    const key = occ === 0 ? rawNum : `${rawNum}§${occ}`;
    out.push({ num: key, body });
  }

  while ((m = re.exec(partBody)) !== null) {
    seq++;
    const attrs = m[1];
    const body = m[2] ?? ''; // 自己閉じ → 空本体
    // number 属性の柔軟な抽出（シングル/ダブルクォート、スペース対応）
    const numMatch = /number\s*=\s*["']([^"']*)["']/.exec(attrs);
    const rawNum = numMatch ? numMatch[1] : String(seq);

    // <multiple-rest>N</multiple-rest> の展開
    const multiRestMatch = /<multiple-rest[^>]*>(\d+)<\/multiple-rest>/.exec(body);
    if (multiRestMatch) {
      const count = parseInt(multiRestMatch[1], 10);
      const baseNum = parseFloat(rawNum);
      // 最初の小節はそのまま（attributes 等を保持）
      addMeasure(rawNum, body);
      // 残りの小節を空本体で展開（convertMeasureToHide が全休符を補完）
      for (let i = 1; i < count; i++) {
        const expandedNum = !isNaN(baseNum) ? String(baseNum + i) : `${rawNum}+${i}`;
        addMeasure(expandedNum, '');
      }
    } else {
      addMeasure(rawNum, body);
    }
  }
  return out;
}

// ============================================================
// 内部: 小節要素抽出 (position 順)
// ============================================================

function extractMeasureEvents(measureBody: string): MeasureEvent[] {
  const events: MeasureEvent[] = [];

  // <note> 要素 + note 内の <technical> から fingering/string を direction として抽出
  const noteRe = /<note(?:\s[^>]*)?>([\s\S]*?)<\/note>/g;
  let m: RegExpExecArray | null;
  while ((m = noteRe.exec(measureBody)) !== null) {
    events.push({ pos: m.index, kind: 'note', body: m[1] });
    // v2.1: note 内 <technical> の fingering/string を direction イベントとして追加
    const techBody = m[1];
    const fing = /<fingering[^>]*>([^<]+)<\/fingering>/.exec(techBody);
    if (fing) events.push({ pos: m.index + 1, kind: 'direction', body: `<fingering>${fing[1]}</fingering>` });
    const str = /<string[^>]*>(\d+)<\/string>/.exec(techBody);
    if (str) events.push({ pos: m.index + 1, kind: 'direction', body: `<string>${str[1]}</string>` });
  }

  // <forward> → voice=1 の暗黙休符として扱う（多声パートの隙間を補完）
  // ただし多声小節 (<backup> あり) で voice 未指定の forward は
  // 他声部のポジショニング用 → voice=1 に計上すると小節が超過する
  const hasBackup = /<backup>/.test(measureBody);
  const fwdRe = /<forward>([\s\S]*?)<\/forward>/g;
  while ((m = fwdRe.exec(measureBody)) !== null) {
    const fwdBody = m[1];
    const dur = parseIntFromTag(fwdBody, 'duration');
    const voice = parseIntFromTag(fwdBody, 'voice');
    if (dur && dur > 0 && (voice === 1 || (!voice && !hasBackup))) {
      events.push({
        pos: m.index,
        kind: 'note',
        body: `<rest/><duration>${dur}</duration><voice>1</voice>`,
      });
    }
  }

  // <direction> 要素 (テンポ・強弱)
  const dirRe = /<direction[^>]*>([\s\S]*?)<\/direction>/g;
  while ((m = dirRe.exec(measureBody)) !== null) {
    events.push({ pos: m.index, kind: 'direction', body: m[1] });
  }

  // <attributes> 要素 (中途変更)
  const attrRe = /<attributes>([\s\S]*?)<\/attributes>/g;
  while ((m = attrRe.exec(measureBody)) !== null) {
    events.push({ pos: m.index, kind: 'attributes', body: m[1] });
  }

  // v2.0: <harmony> 要素 (コードシンボル)
  const harmRe = /<harmony[^>]*>([\s\S]*?)<\/harmony>/g;
  while ((m = harmRe.exec(measureBody)) !== null) {
    events.push({ pos: m.index, kind: 'harmony', body: m[1] });
  }

  // v2.1: <measure-style> 要素 (小節リピート [%])
  if (/<measure-repeat[^>]+type="start"/.test(measureBody)) {
    events.push({ pos: 0, kind: 'direction', body: '<measure-repeat-marker/>' });
  }

  events.sort((a, b) => a.pos - b.pos);
  return events;
}

// ============================================================
// 内部: direction 解析 (テンポ・強弱)
// ============================================================

function parseDirection(body: string): string[] {
  const tokens: string[] = [];

  // v2.1: measure repeat marker (合成イベント)
  if (/<measure-repeat-marker/.test(body)) {
    tokens.push('[%]');
    return tokens;
  }

  // <sound tempo="N"/>
  const tempoMatch = /<sound[^>]+tempo="([\d.]+)"/.exec(body);
  if (tempoMatch) {
    const bpm = Math.round(parseFloat(tempoMatch[1]));
    if (bpm > 0) tokens.push(`[T${bpm}]`);
  }

  // <metronome> (tempo がなければ metronome から推定)
  if (!tempoMatch) {
    const pmMatch = /<per-minute>([\d.]+)<\/per-minute>/.exec(body);
    if (pmMatch) {
      const bpm = Math.round(parseFloat(pmMatch[1]));
      if (bpm > 0) tokens.push(`[T${bpm}]`);
    }
  }

  // <dynamics><f/></dynamics> → [Df]
  const dynMatch = /<dynamics[^>]*>\s*<(\w+)\s*\/>\s*<\/dynamics>/.exec(body);
  if (dynMatch) {
    tokens.push(`[D${dynMatch[1]}]`);
  }

  // <wedge type="crescendo|diminuendo|stop"/> (属性順序非依存)
  const wedgeMatch = /<wedge[^>]+type="(\w+)"/.exec(body);
  if (wedgeMatch) {
    const wt = wedgeMatch[1];
    if (wt === 'crescendo') tokens.push('[D<]');
    else if (wt === 'diminuendo') tokens.push('[D>]');
    else if (wt === 'stop') tokens.push('[D/]');
  }

  // v2.0: ナビゲーション記号 (属性付きにも対応)
  if (/<segno/.test(body)) tokens.push('[segno]');
  if (/<coda/.test(body)) tokens.push('[coda]');

  // v2.0: Da Capo / Dal Segno (from <sound> attributes or <words>)
  if (/<sound[^>]+dacapo="yes"/.test(body)) {
    if (/<sound[^>]+fine="yes"/.test(body) || /D\.C\.\s*al\s*Fine/i.test(body)) tokens.push('[DC.fine]');
    else if (/D\.C\.\s*al\s*Coda/i.test(body)) tokens.push('[DC.coda]');
    else tokens.push('[DC]');
  } else if (/<sound[^>]+dalsegno/.test(body)) {
    if (/<sound[^>]+fine="yes"/.test(body) || /D\.S\.\s*al\s*Fine/i.test(body)) tokens.push('[DS.fine]');
    else if (/D\.S\.\s*al\s*Coda/i.test(body)) tokens.push('[DS.coda]');
    else tokens.push('[DS]');
  }
  if (/<sound[^>]+fine="yes"/.test(body) && !/<sound[^>]+dacapo/.test(body) && !/<sound[^>]+dalsegno/.test(body)) {
    tokens.push('[fine]');
  }
  if (/<sound[^>]+tocoda/.test(body)) tokens.push('[tocoda]');

  // v2.0: リハーサルマーク
  const rehearsalMatch = /<rehearsal[^>]*>([^<]*)<\/rehearsal>/.exec(body);
  if (rehearsalMatch) tokens.push(`[R:${rehearsalMatch[1].replace(/[\r\n]+/g, '')}]`);

  // v2.0: オッターヴァ (属性順序非依存)
  const octaveShiftMatch = /<octave-shift[^>]*>/.exec(body);
  if (octaveShiftMatch) {
    const osTag = octaveShiftMatch[0];
    const otypeM = /type="(\w+)"/.exec(osTag);
    const otype = otypeM ? otypeM[1] : '';
    const sizeM = /size="(\d+)"/.exec(osTag);
    const size = sizeM ? parseInt(sizeM[1], 10) : 8;
    if (otype === 'stop') {
      tokens.push('[8va/]'); // generic stop
    } else if (otype === 'up') {
      tokens.push(size >= 15 ? '[15ma]' : '[8va]');
    } else if (otype === 'down') {
      tokens.push(size >= 15 ? '[15mb]' : '[8vb]');
    }
  }

  // v2.0: ペダル (属性順序非依存)
  const pedalMatch = /<pedal[^>]+type="(\w+)"/.exec(body);
  if (pedalMatch) {
    tokens.push(pedalMatch[1] === 'stop' ? '[ped/]' : '[ped]');
  }

  // v2.0: テキスト / エクスプレッション (<words> は常に処理、複数対応)
  {
    const wordsRe = /<words([^>]*)>([^<]+)<\/words>/g;
    let wm: RegExpExecArray | null;
    while ((wm = wordsRe.exec(body)) !== null) {
      const attrs = wm[1];
      const text = wm[2].replace(/[\r\n]+/g, ' ').trim();
      if (text.length === 0) continue;
      // テンポテキストの判定
      const tempoTexts = ['allegro', 'andante', 'adagio', 'presto', 'vivace', 'moderato',
        'largo', 'lento', 'grave', 'rit', 'rall', 'accel', 'atempo', 'a tempo'];
      if (tempoTexts.some(t => text.toLowerCase().startsWith(t))) {
        // テンポテキストは [T:...] を優先、BPM [T120] が既にあれば置き換え
        const existingBpmIdx = tokens.findIndex(t => /^\[T\d+\]$/.test(t));
        if (existingBpmIdx >= 0) tokens.splice(existingBpmIdx, 1);
        tokens.push(`[T:${text}]`);
      } else if (/font-style="italic"/.test(attrs)) {
        tokens.push(`[expr:${text}]`);
      } else {
        tokens.push(`[text:${text}]`);
      }
    }
  }

  // v2.0: ブレス/カエスーラ
  if (/breath-mark/.test(body) || /other-direction>breath/.test(body)) tokens.push('[breath]');
  if (/caesura/.test(body) || /other-direction>caesura/.test(body)) tokens.push('[caesura]');

  // v2.1: フィンガリング
  const fingeringMatch = /<fingering[^>]*>([^<]+)<\/fingering>/.exec(body);
  if (fingeringMatch) tokens.push(`[F:${fingeringMatch[1].trim()}]`);

  // v2.1: 弦番号
  const stringMatch = /<string[^>]*>(\d+)<\/string>/.exec(body);
  if (stringMatch) tokens.push(`[S:${stringMatch[1]}]`);

  // v2.1: Swing / Straight (カスタム words ベースの検出)
  {
    const swingRe = /swing/i;
    const straightRe = /straight/i;
    const wordsInner = body.match(/<words[^>]*>([^<]+)<\/words>/g)?.map(w =>
      w.replace(/<\/?words[^>]*>/g, '').trim().toLowerCase()) ?? [];
    if (wordsInner.some(w => swingRe.test(w))) tokens.push('[swing]');
    if (wordsInner.some(w => straightRe.test(w))) tokens.push('[straight]');
  }

  return tokens;
}

// ============================================================
// 内部: 中途 attributes 解析 (拍子・調号変更)
// ============================================================

function parseMidAttributes(
  body: string,
  runningTimeNum: number,
  runningTimeDen: number,
  runningKeyFifths: number,
): { tokens: string[]; newTimeNum?: number; newTimeDen?: number; newKeyFifths?: number } {
  const tokens: string[] = [];
  let newTimeNum: number | undefined;
  let newTimeDen: number | undefined;
  let newKeyFifths: number | undefined;

  const beats = parseIntFromTag(body, 'beats');
  const beatType = parseIntFromTag(body, 'beat-type');
  if (beats !== undefined && beatType !== undefined) {
    if (beats !== runningTimeNum || beatType !== runningTimeDen) {
      tokens.push(`[M${beats}/${beatType}]`);
      newTimeNum = beats;
      newTimeDen = beatType;
    }
  }

  const fifths = parseIntFromTag(body, 'fifths');
  if (fifths !== undefined && fifths !== runningKeyFifths) {
    const modeM = /<mode>(\w+)<\/mode>/.exec(body);
    const mode: 'major' | 'minor' = modeM?.[1]?.toLowerCase() === 'minor' ? 'minor' : 'major';
    tokens.push(`[K${fifthsToKeyName(fifths, mode)}]`);
    newKeyFifths = fifths;
  }

  // v2.0: 音部記号変更
  const clefSign = /<sign>(\w+)<\/sign>/.exec(body)?.[1];
  if (clefSign) {
    const clefLine = parseIntFromTag(body, 'line');
    const clefOctaveChange = parseIntFromTag(body, 'clef-octave-change');
    const clef = inferClef(clefSign, clefLine, clefOctaveChange);
    const clefAbbr: Record<string, string> = {
      TREBLE: 'T', TREBLE_8VA: 'T8', TREBLE_8VB: 'T-8', BASS: 'B',
      ALTO: 'A', TENOR: 'Te', PERCUSSION: 'Pe', SOPRANO: 'So', BARITONE: 'Br',
    };
    const abbr = clefAbbr[clef] || 'T';
    tokens.push(`[${abbr}]`);
  }

  return { tokens, newTimeNum, newTimeDen, newKeyFifths };
}

// ============================================================
// 内部: 小節 → .hide トークン列変換 (主処理)
// ============================================================

interface MeasureConvertResult {
  tokens: string;
  newTimeNum?: number;
  newTimeDen?: number;
  newKeyFifths?: number;
}

function convertMeasureToHide(
  measureBody: string,
  header: ParsedHeader,
  warnings: string[],
  diagnostics: MusicXmlToHideDiagnostic[],
  partIndex: number,
  measureIndex: number,
  runningTimeNum: number,
  runningTimeDen: number,
  runningKeyFifths: number,
): MeasureConvertResult {
  const events = extractMeasureEvents(measureBody);
  let newTimeNum: number | undefined;
  let newTimeDen: number | undefined;
  let newKeyFifths: number | undefined;

  // フェーズ 1: 全 note を parse
  const noteEvents = events
    .filter(e => e.kind === 'note')
    .map(e => ({ pos: e.pos, note: parseNoteBlock(e.body, header) }));

  // 多声 voice 検出 (1パート内に複数 voice があれば voice=1 のみ採用)
  const voicesUsed = new Set(noteEvents.map(n => n.note.voice));
  if (voicesUsed.size > 1) {
    warnings.push(`パート#${partIndex + 1} 小節 ${measureIndex + 1}: 複数の <voice> を検出 (${[...voicesUsed].join(',')})、voice=1 のみ採用`);
    diagnostics.push({
      kind: 'multipleVoices',
      partIndex,
      measureIndex,
      voices: [...voicesUsed],
    });
  }
  const filteredNotes = voicesUsed.size > 1
    ? noteEvents.filter(n => n.note.voice === 1)
    : noteEvents;

  // フェーズ 2: note → .hide トークン (chord / tuplet / slur / staccato / lyrics)
  const noteTokens = convertNotesToHideTokens(
    filteredNotes, header, warnings, diagnostics, partIndex, measureIndex,
    runningTimeNum, runningTimeDen,
  );

  // フェーズ 3: direction → [TN] [Dp] 等
  const dirTokens: Array<{ pos: number; token: string }> = [];
  for (const e of events.filter(e => e.kind === 'direction')) {
    for (const t of parseDirection(e.body)) {
      dirTokens.push({ pos: e.pos, token: t });
    }
  }

  // フェーズ 4: 中途 attributes → [MN/D] [KN]
  const attrTokens: Array<{ pos: number; token: string }> = [];
  for (const e of events.filter(e => e.kind === 'attributes')) {
    // 最初の小節の attributes はヘッダーとして既に抽出済み → skip
    if (measureIndex === 0) continue;
    const attrResult = parseMidAttributes(e.body, runningTimeNum, runningTimeDen, runningKeyFifths);
    for (const t of attrResult.tokens) {
      attrTokens.push({ pos: e.pos, token: t });
    }
    if (attrResult.newTimeNum !== undefined) newTimeNum = attrResult.newTimeNum;
    if (attrResult.newTimeDen !== undefined) newTimeDen = attrResult.newTimeDen;
    if (attrResult.newKeyFifths !== undefined) newKeyFifths = attrResult.newKeyFifths;
  }

  // ノートもレストも無い空小節 → 全小節休符を補完
  if (noteTokens.length === 0) {
    const restTok = durationToRest(
      measureRestUnits(header, runningTimeNum, runningTimeDen), header, warnings, diagnostics, partIndex, measureIndex, 0,
    );
    if (restTok) noteTokens.push({ pos: 0, token: restTok });
  }

  // フェーズ 4c: harmony → [C:Cmaj7] 等
  const harmTokens: Array<{ pos: number; token: string }> = [];
  for (const e of events.filter(e => e.kind === 'harmony')) {
    const rootStep = /<root-step>([A-G])<\/root-step>/.exec(e.body)?.[1] ?? '';
    const rootAlterRaw = parseFloatFromTag(e.body, 'root-alter');
    const rootAlter = rootAlterRaw !== undefined ? Math.round(rootAlterRaw) : undefined;
    const kindText = /<kind[^>]*text="([^"]*)"/.exec(e.body)?.[1];
    let symbol = rootStep;
    if (rootAlter === 2) symbol += 'x';
    else if (rootAlter === 1) symbol += '#';
    else if (rootAlter === -1) symbol += 'b';
    else if (rootAlter === -2) symbol += 'bb';
    if (kindText) symbol += kindText;
    else {
      const kindEl = /<kind[^>]*>([^<]*)<\/kind>/.exec(e.body)?.[1] ?? '';
      symbol += musicXmlKindToSymbol(kindEl);
    }
    if (symbol) harmTokens.push({ pos: e.pos, token: `[C:${symbol}]` });
  }

  // フェーズ 5: position 順にマージして組み立て
  const allTokens = [...noteTokens, ...dirTokens, ...attrTokens, ...harmTokens];
  allTokens.sort((a, b) => a.pos - b.pos);

  const out: string[] = [];

  // 左端バーライン + volta
  const leftBarline = extractBarlineStyle(measureBody, 'left');
  if (leftBarline === 'repeatStart') {
    out.push(',:');
  }
  const voltaNum = extractVoltaNumber(measureBody);
  if (voltaNum !== undefined) {
    out.push(`[V${voltaNum}]`);
  }

  out.push(...allTokens.map(t => t.token));

  // 右端バーライン
  const rightBarline = extractBarlineStyle(measureBody, 'right');
  out.push(barlineStyleToken(rightBarline ?? 'single'));

  return {
    tokens: out.join(' '),
    newTimeNum,
    newTimeDen,
    newKeyFifths,
  };
}

// ============================================================
// 内部: note 列 → .hide トークン列 (chord / tuplet 対応)
// ============================================================

function convertNotesToHideTokens(
  notes: Array<{ pos: number; note: XmlNote }>,
  header: ParsedHeader,
  warnings: string[],
  diagnostics: MusicXmlToHideDiagnostic[],
  partIndex: number,
  measureIndex: number,
  runningTimeNum?: number,
  runningTimeDen?: number,
): Array<{ pos: number; token: string }> {
  const out: Array<{ pos: number; token: string }> = [];
  let i = 0;

  while (i < notes.length) {
    const { pos, note: head } = notes[i];

    // ---- 全小節休符 ----
    if (head.isWholeMeasureRest) {
      const tok = durationToRest(measureRestUnits(header, runningTimeNum, runningTimeDen), header, warnings, diagnostics, partIndex, measureIndex, 0);
      if (tok) out.push({ pos, token: tok });
      i++;
      continue;
    }

    // ---- 連符グループ (休符含む) ----
    // 休符チェックより先に判定。連符内の休符を standalone で処理すると
    // スケーリング済み duration が近似され小節長がずれる
    if (head.hasTimeModification && !head.isChordContinuation) {
      const result = collectTupletGroup(notes, i, header, warnings, diagnostics, partIndex, measureIndex);
      if (result.token) out.push({ pos, token: result.token });
      i = result.nextIndex;
      continue;
    }

    // ---- 通常休符 ----
    if (head.isRest) {
      const tok = durationToRest(head.duration, header, warnings, diagnostics, partIndex, measureIndex, head.dots);
      if (tok) out.push({ pos, token: tok });
      if (head.breathMark) out.push({ pos, token: '[breath]' });
      if (head.caesura) out.push({ pos, token: '[caesura]' });
      i++;
      continue;
    }

    // ---- 通常音符 (和音を含む) ----
    const result = emitSingleNote(notes, i, header, warnings, diagnostics, partIndex, measureIndex);
    if (result.token) out.push({ pos, token: result.token });
    // breath-mark / caesura は note の articulations 内に含まれるが .hide ではメタトークン
    if (head.breathMark) out.push({ pos, token: '[breath]' });
    if (head.caesura) out.push({ pos, token: '[caesura]' });
    i = result.nextIndex;
  }

  return out;
}

/** 単音または和音 1 つを .hide トークンに変換 */
function emitSingleNote(
  notes: Array<{ pos: number; note: XmlNote }>,
  startIndex: number,
  header: ParsedHeader,
  warnings: string[],
  diagnostics: MusicXmlToHideDiagnostic[],
  partIndex: number,
  measureIndex: number,
  durationOverride?: number,
): { token: string; nextIndex: number } {
  const head = notes[startIndex].note;
  const chordPitches: HidePitch[] = [];
  if (head.pitch) chordPitches.push(head.pitch);

  // chord 集約: 続く isChordContinuation=true の note 群
  let j = startIndex + 1;
  while (j < notes.length && notes[j].note.isChordContinuation) {
    const cn = notes[j].note;
    if (!cn.isRest && cn.pitch) chordPitches.push(cn.pitch);
    j++;
  }

  if (chordPitches.length === 0) {
    return { token: '', nextIndex: j };
  }

  const duration = durationOverride ?? head.duration;

  // パーカッション (unpitched) は調号による臨時記号を適用しない
  const effectiveKeyFifths = head.isUnpitched ? 0 : header.keyFifths;
  // スラー → 1 番目のピッチを小文字
  const pitchStr = chordPitches.map((p, idx) =>
    formatPitch(p, effectiveKeyFifths, idx === 0 && head.slurStart),
  ).join('');

  // v2.1: notehead suffix (!d !x !/ !t) — ピッチの直後、音価の前
  const noteheadStr = head.notehead
    ? `!${head.notehead === 'diamond' ? 'd' : head.notehead === 'x' ? 'x' : head.notehead === 'slash' ? '/' : 't'}`
    : '';

  // --- アーティキュレーション文字列を事前構築 (tied chain 全体で共有) ---
  let artStr = '';
  if (head.staccato) artStr += 's';
  if (head.staccatissimo) artStr += 'S';
  if (head.accent) artStr += '>';
  if (head.tenuto) artStr += '-';
  if (head.fermata) {
    if (head.fermataType === 'short') artStr += '~s';
    else if (head.fermataType === 'long') artStr += '~l';
    else artStr += '~';
  }
  if (head.marcato) artStr += '^';
  if (head.upBow) artStr += 'V';
  if (head.downBow) artStr += 'W';
  if (head.harmonicNote) artStr += 'O';
  if (head.snapPizzicato) artStr += 'X';
  if (head.stopped) artStr += 'T';
  if (head.trill) artStr += 'tr';
  if (head.mordent) artStr += 'mr';
  if (head.invertedMordent) artStr += 'MR';
  if (head.turn) artStr += 'tn';
  if (head.invertedTurn) artStr += 'TN';
  if (head.tremolo > 0) artStr += `z${head.tremolo}`;
  if (head.arpeggio) artStr += 'ar';
  if (head.glissando) artStr += 'gl';
  if (head.vibrato) artStr += 'vb';
  if (head.bend) artStr += 'bn';
  if (head.fall) artStr += 'jf';
  if (head.doit) artStr += 'jd';
  if (head.plop) artStr += 'jp';
  if (head.scoop) artStr += 'js';

  // --- duration → .hide トークン ---
  // grace note は duration=0 → デフォルト j (8分音符)
  if (head.isGrace && duration === 0) {
    let token = pitchStr + noteheadStr + 'j' + artStr;
    if (head.slurEnd) token += '_';
    if (head.tieStart) token += '+';
    token = (head.isAcciaccatura ? '``' : '`') + token;
    if (head.lyricText) token += ` '${head.lyricText}`;
    return { token, nextIndex: j };
  }

  // 付点検出 → 標準音価マッピング
  let dots = head.dots;
  let baseDur: number;
  if (dots > 0) {
    baseDur = dots === 3 ? Math.round(duration / 1.875)
      : dots === 2 ? Math.round(duration / 1.75)
      : Math.round(duration / 1.5);
  } else {
    const detected = detectDotsFromDuration(duration, header);
    dots = detected.dots;
    baseDur = detected.baseDur;
  }

  const lengthChar = unitsToLengthCharStrict(baseDur, header);
  if (lengthChar) {
    // ---- 標準パス: 単一トークン ----
    const dotStr = '.'.repeat(dots);
    let token = pitchStr + noteheadStr + lengthChar + dotStr + artStr;
    if (head.slurEnd) token += '_';
    if (head.tieStart) token += '+';
    if (head.isGrace) token = (head.isAcciaccatura ? '``' : '`') + token;
    if (head.lyricText) token += ` '${head.lyricText}`;
    return { token, nextIndex: j };
  }

  // ---- 非標準 duration → tied chain 分解 ----
  const chain = decomposeDuration(duration, header);
  if (chain.length === 0) return { token: '', nextIndex: j };

  // chain の各要素を pitch+duration で結合、アーティキュレーションは先頭のみ
  const parts: string[] = [];
  for (let ci = 0; ci < chain.length; ci++) {
    const { char, dots: cDots } = chain[ci];
    let part = pitchStr + noteheadStr + char + '.'.repeat(cDots);
    if (ci === 0) part += artStr; // アーティキュレーションは先頭音に付与
    if (ci < chain.length - 1) part += '+'; // chain 内タイ
  parts.push(part);
  }
  let token = parts.join('');
  if (head.slurEnd) token += '_';
  if (head.tieStart) token += '+'; // MusicXML 由来のタイ (次の MusicXML note へ)
  if (head.isGrace) token = (head.isAcciaccatura ? '``' : '`') + token;
  if (head.lyricText) token += ` '${head.lyricText}`;

  return { token, nextIndex: j };
}

/** 連符グループを収集して `N(...)` 構文を生成 */
function collectTupletGroup(
  notes: Array<{ pos: number; note: XmlNote }>,
  startIndex: number,
  header: ParsedHeader,
  warnings: string[],
  diagnostics: MusicXmlToHideDiagnostic[],
  partIndex: number,
  measureIndex: number,
): { token: string; nextIndex: number } {
  // 連符グループの範囲を特定
  // Strategy: tupletType='start' から tupletType='stop' まで。
  //           tuplet マーカーがなければ連続する hasTimeModification=true の note 群。
  const groupNotes: Array<{ pos: number; note: XmlNote }> = [];
  let i = startIndex;
  let foundStop = false;

  // start ノードに明示的 tuplet 括弧がある場合は stop まで続行 (hasTimeModification 不問)
  const hasExplicitTuplet = notes[startIndex].note.tupletType === 'start';
  while (i < notes.length) {
    const n = notes[i].note;
    if (hasExplicitTuplet) {
      // 明示的 tuplet: chord 以外の無関係なノート (time-modification もなく tuplet stop でもない) はスキップしない
      // ただし安全弁: start を超えた後で stop も time-mod もない場合は中断
      if (i > startIndex && !n.hasTimeModification && !n.isChordContinuation && n.tupletType !== 'stop') break;
    } else {
      if (!n.hasTimeModification && !n.isChordContinuation) break;
    }
    groupNotes.push(notes[i]);
    if (n.tupletType === 'stop' && !n.isChordContinuation) {
      i++;
      foundStop = true;
      // stop の後に chord continuation が続くなら含める
      while (i < notes.length && notes[i].note.isChordContinuation) {
        groupNotes.push(notes[i]);
        i++;
      }
      break;
    }
    i++;
  }

  // tuplet stop が見つからなかった場合、収集済みの分で打ち切り
  if (!foundStop && groupNotes.length === 0) {
    return { token: '', nextIndex: startIndex + 1 };
  }

  // targetUnits = 全メンバーの MusicXML duration の合計 (= .hide units)
  // ただし chord は head の duration のみカウント (chord continuation は同一タイミング)
  let totalDuration = 0;
  for (const gn of groupNotes) {
    if (!gn.note.isChordContinuation) {
      totalDuration += gn.note.duration;
    }
  }

  // 各メンバーの nominal duration (元の長さ) = MusicXML_duration * actual / normal
  const head = groupNotes[0].note;
  const actual = head.actualNotes ?? 3;
  const normal = head.normalNotes ?? 2;

  // 連符内の各 note/rest を .hide トークンに変換
  const memberTokens: string[] = [];
  let gi = 0;
  while (gi < groupNotes.length) {
    const gn = groupNotes[gi].note;
    if (gn.isChordContinuation) { gi++; continue; }

    // nominal duration for this member (スケーリング前の本来の長さ)
    const nominalDur = Math.round(gn.duration * actual / normal);

    // 連符内休符: Rx トークンとして名目デュレーションで生成
    if (gn.isRest) {
      const restTok = durationToRest(nominalDur, header, warnings, diagnostics, partIndex, measureIndex, gn.dots);
      if (restTok) memberTokens.push(restTok);
      gi++;
      continue;
    }

    // emitSingleNote を使って変換 (durationOverride で nominal を渡す)
    const result = emitSingleNoteInline(
      groupNotes, gi, header, warnings, diagnostics, partIndex, measureIndex, nominalDur,
    );
    if (result.token) memberTokens.push(result.token);
    gi = result.nextIndex;
  }

  // メンバーが空なら連符トークンを出さない
  if (memberTokens.length === 0) {
    return { token: '', nextIndex: i };
  }
  const token = `${totalDuration}(${memberTokens.join(' ')})`;
  return { token, nextIndex: i };
}

/** 連符内での単音/和音変換 (groupNotes 内の相対インデックスで動作) */
function emitSingleNoteInline(
  notes: Array<{ pos: number; note: XmlNote }>,
  startIndex: number,
  header: ParsedHeader,
  warnings: string[],
  diagnostics: MusicXmlToHideDiagnostic[],
  partIndex: number,
  measureIndex: number,
  durationOverride: number,
): { token: string; nextIndex: number } {
  return emitSingleNote(
    notes, startIndex, header, warnings, diagnostics, partIndex, measureIndex, durationOverride,
  );
}

// ============================================================
// 内部: note 要素パース
// ============================================================

function parseNoteBlock(body: string, header: ParsedHeader): XmlNote {
  const isChordContinuation = /<chord\s*\/>/.test(body);
  // <rest/> (自己終了) と <rest>...</rest> (子要素あり) の両方を検出
  const isRest = /<rest[\s>\/]/.test(body);
  const isWholeMeasureRest = isRest && /<rest[^>]*measure="yes"/.test(body);
  const isGrace = /<grace/.test(body);
  // 装飾音は演奏時間 0 (一部の MusicXML エクスポーターが非ゼロ duration を出力するが無視)
  const duration = isGrace ? 0 : (parseIntFromTag(body, 'duration') ?? 0);
  const dots = (body.match(/<dot[\s\/>]/g) ?? []).length;
  const tieStart = /<tie[^>]+type="start"/.test(body);
  const voice = parseIntFromTag(body, 'voice') ?? 1;
  const hasTimeModification = /<time-modification>/.test(body);

  const slurStart = /<slur[^>]+type="start"/.test(body);
  const slurEnd = /<slur[^>]+type="stop"/.test(body);
  const staccato = /<staccato/.test(body);
  const staccatissimo = /<staccatissimo/.test(body);
  const accent = /<accent/.test(body);
  const tenuto = /<tenuto/.test(body);
  const fermata = /<fermata/.test(body);
  const marcato = /<strong-accent/.test(body);
  const trill = /<trill-mark/.test(body);
  // mordent vs inverted-mordent: MusicXML <mordent/> = lower mordent, <inverted-mordent/> = upper
  const mordent = /<mordent[\s\/>]/.test(body) && !/<inverted-mordent/.test(body);
  const invertedMordent = /<inverted-mordent/.test(body);
  const turn = /<turn[\s\/>]/.test(body) && !/<inverted-turn/.test(body);
  const invertedTurn = /<inverted-turn/.test(body);
  const tremoloMatch = /<tremolo[^>]*>(\d+)<\/tremolo>/.exec(body);
  const tremolo: 0 | 1 | 2 | 3 = tremoloMatch
    ? (Math.min(3, Math.max(0, parseInt(tremoloMatch[1], 10))) as 0 | 1 | 2 | 3)
    : 0;
  const arpeggio = /<arpeggiate/.test(body);
  const glissando = /<glissando/.test(body);
  // v2.1 bowing / techniques
  const upBow = /<up-bow/.test(body);
  const downBow = /<down-bow/.test(body);
  const harmonicNote = /<harmonic/.test(body);
  const snapPizzicato = /<snap-pizzicato/.test(body);
  const stopped = /<stopped/.test(body);
  // v2.1 jazz articulations (MusicXML uses <falloff>, <doit>, <plop>, <scoop> in <articulations>)
  const fall = /<falloff/.test(body);
  const doit = /<doit/.test(body);
  const plop = /<plop/.test(body);
  const scoop = /<scoop/.test(body);
  // v2.1 misc
  const vibrato = /<wavy-line[^>]+type="start"/.test(body) && !trill;
  const bend = /<bend/.test(body);
  const breathMark = /<breath-mark/.test(body);
  const caesura = /<caesura/.test(body);
  // v2.1 fermata type detection
  let fermataType: '' | 'normal' | 'short' | 'long' = '';
  if (fermata) {
    const fermataTag = /<fermata[^>]*>([^<]*)<\/fermata>/.exec(body);
    const fermataContent = fermataTag?.[1]?.trim().toLowerCase() ?? '';
    if (fermataContent === 'angled' || fermataContent === 'square') fermataType = fermataContent === 'angled' ? 'short' : 'long';
    else fermataType = 'normal';
  }

  // v2.1: note-level technical annotations (fingering, string) → 抽出して lyricText に付加しない
  // これらは direction 経由で別途処理される場合もある。note 内 <technical> は parseNoteBlock では
  // 直接 .hide トークンに変換できない (XmlNote は単一トークンを表すため) ので
  // convertNotesToHideTokens 側でハンドルする。ここではフラグのみ保持。
  // (将来拡張用に XmlNote に fingering/string フィールドを追加可能)
  // isGrace は上で宣言済み (duration=0 の強制に使用)
  const isAcciaccatura = /<grace[^>]+slash="yes"/.test(body);

  // 連符詳細
  let actualNotes: number | undefined;
  let normalNotes: number | undefined;
  if (hasTimeModification) {
    const tmMatch = /<time-modification>([\s\S]*?)<\/time-modification>/.exec(body);
    if (tmMatch) {
      actualNotes = parseIntFromTag(tmMatch[1], 'actual-notes') ?? undefined;
      normalNotes = parseIntFromTag(tmMatch[1], 'normal-notes') ?? undefined;
    }
  }

  let tupletType: 'start' | 'stop' | undefined;
  if (/<tuplet[^>]+type="start"/.test(body)) tupletType = 'start';
  else if (/<tuplet[^>]+type="stop"/.test(body)) tupletType = 'stop';

  // 歌詞
  let lyricText: string | undefined;
  const lyricMatch = /<lyric[^>]*>[\s\S]*?<text>([^<]*)<\/text>[\s\S]*?<\/lyric>/.exec(body);
  if (lyricMatch) {
    lyricText = lyricMatch[1].replace(/[\r\n]+/g, '');
  }

  // パーカッション: <unpitched> 検出
  const isUnpitched = /<unpitched/.test(body);

  // ノートヘッド: <notehead>x|slash|diamond|triangle</notehead>
  let notehead: XmlNote['notehead'];
  const noteheadMatch = /<notehead[^>]*>([^<]+)<\/notehead>/.exec(body);
  if (noteheadMatch) {
    const nh = noteheadMatch[1].trim().toLowerCase();
    if (nh === 'x' || nh === 'cross') notehead = 'x';
    else if (nh === 'slash') notehead = 'slash';
    else if (nh === 'diamond') notehead = 'diamond';
    else if (nh === 'triangle') notehead = 'triangle';
  }

  let pitch: HidePitch | undefined;
  if (!isRest) {
    if (isUnpitched) {
      // パーカッション: <display-step>/<display-octave> を使用、alter は常に 0
      const stepM = /<display-step>(\w)<\/display-step>/.exec(body);
      const octaveM = /<display-octave>(\d+)<\/display-octave>/.exec(body);
      if (stepM && octaveM) {
        pitch = {
          step: stepM[1] as HidePitch['step'],
          octave: parseInt(octaveM[1], 10),
          alter: 0,
        };
      }
    } else {
      // 通常の <pitch> (フォールバック: <display-step>/<display-octave>)
      const stepM = /<step>(\w)<\/step>/.exec(body)
        ?? /<display-step>(\w)<\/display-step>/.exec(body);
      const octaveM = /<octave>(\d+)<\/octave>/.exec(body)
        ?? /<display-octave>(\d+)<\/display-octave>/.exec(body);
      const alterM = /<alter>(-?[\d.]+)<\/alter>/.exec(body);
      if (stepM && octaveM) {
        const step = stepM[1] as HidePitch['step'];
        const soundingAlter = alterM
          ? clampAlter(Math.round(parseFloat(alterM[1])))
          : keySigImpliedAlter(step, header.keyFifths);
        pitch = {
          step,
          octave: parseInt(octaveM[1], 10),
          alter: soundingAlter,
        };
      }
    }
  }

  return {
    isRest,
    isWholeMeasureRest,
    isChordContinuation,
    duration: isGrace ? 0 : duration, // grace notes have 0 duration in .hide
    dots,
    pitch,
    isUnpitched,
    notehead,
    tieStart,
    voice,
    hasTimeModification,
    slurStart,
    slurEnd,
    staccato,
    staccatissimo,
    accent,
    tenuto,
    fermata,
    marcato,
    trill,
    mordent,
    turn,
    tremolo,
    arpeggio,
    glissando,
    // v2.1 bowing / techniques
    upBow,
    downBow,
    harmonicNote,
    snapPizzicato,
    stopped,
    // v2.1 inverted ornaments
    invertedMordent,
    invertedTurn,
    // v2.1 jazz
    fall,
    doit,
    plop,
    scoop,
    // v2.1 misc
    vibrato,
    bend,
    fermataType,
    breathMark,
    caesura,
    isGrace,
    isAcciaccatura,
    actualNotes,
    normalNotes,
    tupletType,
    lyricText,
  };
}

// ============================================================
// 内部: バーライン
// ============================================================

/**
 * 小節 body から `<barline>` を抽出して style を返す。
 * location は 'left' / 'right' のどちらを探すか指定。
 * MusicXML 仕様: location 属性が省略された場合は 'right' とみなす。
 */
function extractBarlineStyle(
  measureBody: string,
  location: 'left' | 'right',
): HideBarlineStyle | undefined {
  const re = /<barline(\s+[^>]*)?>([\s\S]*?)<\/barline>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(measureBody)) !== null) {
    const attrs = m[1] ?? '';
    const inner = m[2];
    const locMatch = /location="([^"]+)"/.exec(attrs);
    const loc = locMatch ? locMatch[1] : 'right';
    if (loc !== location) continue;
    const styleMatch = /<bar-style>([^<]+)<\/bar-style>/.exec(inner);
    const barStyle = styleMatch ? styleMatch[1] : '';
    const repeatMatch = /<repeat\s+direction="([^"]+)"\s*\/?>/.exec(inner);
    const repeatDir = repeatMatch ? repeatMatch[1] : '';

    if (repeatDir === 'forward') return 'repeatStart';
    if (repeatDir === 'backward') return 'repeatEnd';
    if (barStyle === 'light-light') return 'double';
    if (barStyle === 'light-heavy') return 'final';
    if (barStyle === 'heavy-light') return 'repeatStart';
    if (barStyle === 'heavy-heavy') return 'double'; // double heavy → double
    if (barStyle === 'regular') return 'single';
    if (barStyle === 'dashed') return 'dashed';
    if (barStyle === 'none') return 'invisible';
    if (barStyle === 'tick') return 'dashed'; // tick → dashed fallback
    if (barStyle === 'short') return 'dashed'; // short → dashed fallback
    return undefined;
  }
  return undefined;
}

/** <ending number="N" type="start"/> → N を抽出 (属性順序非依存) */
function extractVoltaNumber(measureBody: string): number | undefined {
  // 全 <ending> タグから type="start" を含むものを探す
  const re = /<ending[^>]+>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(measureBody)) !== null) {
    const tag = m[0];
    if (/type="start"/.test(tag)) {
      const numM = /number="(\d+)"/.exec(tag);
      return numM ? parseInt(numM[1], 10) : undefined;
    }
  }
  return undefined;
}

/** MusicXML の <kind> 名を慣習的コードシンボルに変換 */
function musicXmlKindToSymbol(kind: string): string {
  const map: Record<string, string> = {
    'major': '', 'minor': 'm', 'augmented': 'aug', 'diminished': 'dim',
    'dominant': '7', 'major-seventh': 'maj7', 'minor-seventh': 'm7',
    'diminished-seventh': 'dim7', 'augmented-seventh': 'aug7',
    'half-diminished': 'm7b5', 'major-minor': 'mMaj7',
    'major-sixth': '6', 'minor-sixth': 'm6',
    'dominant-ninth': '9', 'major-ninth': 'maj9', 'minor-ninth': 'm9',
    'dominant-11th': '11', 'major-11th': 'maj11', 'minor-11th': 'm11',
    'dominant-13th': '13', 'major-13th': 'maj13', 'minor-13th': 'm13',
    'suspended-second': 'sus2', 'suspended-fourth': 'sus4',
    'power': '5',
  };
  return map[kind] ?? (kind === '' ? '' : kind);
}

/** 五度圏の数値 → .hide の調名 (例: 4→"E", -6→"Gb", minor: 0→"Am") */
function fifthsToKeyName(fifths: number, mode: 'major' | 'minor' = 'major'): string {
  if (mode === 'minor') {
    const minorNames: Record<string, string> = {
      '-7': 'Abm', '-6': 'Ebm', '-5': 'Bbm', '-4': 'Fm', '-3': 'Cm',
      '-2': 'Gm', '-1': 'Dm', '0': 'Am', '1': 'Em', '2': 'Bm',
      '3': 'F#m', '4': 'C#m', '5': 'G#m', '6': 'D#m', '7': 'A#m',
    };
    return minorNames[String(fifths)] ?? 'Am';
  }
  const names: Record<string, string> = {
    '-7': 'Cb', '-6': 'Gb', '-5': 'Db', '-4': 'Ab', '-3': 'Eb',
    '-2': 'Bb', '-1': 'F', '0': 'C', '1': 'G', '2': 'D',
    '3': 'A', '4': 'E', '5': 'B', '6': 'F#', '7': 'C#',
  };
  return names[String(fifths)] ?? 'C';
}

function barlineStyleToken(style: HideBarlineStyle): string {
  switch (style) {
    case 'single': return ',';
    case 'double': return ',,';
    case 'final': return ',,,';
    case 'repeatStart': return ',:';
    case 'repeatEnd': return ':,';
    case 'dashed': return ',-';
    case 'invisible': return ',.';
    default: return ',';
  }
}

// ============================================================
// 内部: duration / pitch / rest ヘルパー
// ============================================================

/**
 * duration 値から付点数を自動検出する。
 * MusicXML の `<dot/>` タグが欠落している場合のフォールバック。
 */
function detectDotsFromDuration(
  duration: number, header: ParsedHeader,
): { baseDur: number; dots: number } {
  // v2.0: DIV=64 ベース (g=1, h=2, i=4, j=8, k=16, l=32, m=64, n=128)
  const rawValues = [1, 2, 4, 8, 16, 32, 64, 128];
  // まず完全一致を優先的に探す
  for (const raw of rawValues) {
    const base = Math.round((raw * header.div) / 64);
    if (base <= 0) continue;
    if (base === duration) return { baseDur: base, dots: 0 };
  }
  // 完全一致なし → 付点を試す (三重付点まで)
  for (const raw of rawValues) {
    const base = Math.round((raw * header.div) / 64);
    if (base <= 0) continue;
    if (Math.round(base * 1.5) === duration) return { baseDur: base, dots: 1 };
    if (Math.round(base * 1.75) === duration) return { baseDur: base, dots: 2 };
    if (Math.round(base * 1.875) === duration) return { baseDur: base, dots: 3 };
  }
  return { baseDur: duration, dots: 0 };
}

function measureRestUnits(header: ParsedHeader, timeNum?: number, timeDen?: number): number {
  // <rest measure="yes"/> → 1小節分 (running time signature × divisions)
  const num = timeNum ?? header.timeNum;
  const den = timeDen ?? header.timeDen;
  return Math.round((num / den) * header.div);
}

function durationToRest(
  duration: number,
  header: ParsedHeader,
  warnings: string[],
  diagnostics: MusicXmlToHideDiagnostic[],
  partIndex: number,
  measureIndex: number,
  dotCount: number,
): string {
  const hideUnits = duration;
  let dots = dotCount;
  let baseUnits: number;
  if (dots > 0) {
    baseUnits = dots === 3 ? Math.round(hideUnits / 1.875)
      : dots === 2 ? Math.round(hideUnits / 1.75)
      : Math.round(hideUnits / 1.5);
  } else {
    const detected = detectDotsFromDuration(hideUnits, header);
    dots = detected.dots;
    baseUnits = detected.baseDur;
  }

  // 標準音価に一致する場合 → 単一休符トークン
  const lc = unitsToLengthCharStrict(baseUnits, header);
  if (lc) return `R${lc}${'.'.repeat(dots)}`;

  // 非標準 → decompose して複数休符を連結 (休符にタイは不要)
  const chain = decomposeDuration(hideUnits, header);
  if (chain.length === 0) {
    // フォールバック: 最近接近似
    const fallback = unitsToLengthChar(baseUnits, header, warnings, diagnostics, partIndex, measureIndex);
    return fallback ? `R${fallback}${'.'.repeat(dots)}` : '';
  }
  return chain.map(c => `R${c.char}${'.'.repeat(c.dots)}`).join(' ');
}

/** 厳密マッチのみ。失敗なら null。 */
function unitsToLengthCharStrict(
  units: number,
  header: ParsedHeader,
): string | null {
  for (const e of DURATION_MAP) {
    const expected = (e.rawAtDiv64 * header.div) / 64;
    if (Math.round(expected) === units) return e.char;
  }
  return null;
}

const DURATION_MAP: Array<{ char: string; rawAtDiv64: number }> = [
  { char: 'g', rawAtDiv64: 1 },
  { char: 'h', rawAtDiv64: 2 },
  { char: 'i', rawAtDiv64: 4 },
  { char: 'j', rawAtDiv64: 8 },
  { char: 'k', rawAtDiv64: 16 },
  { char: 'l', rawAtDiv64: 32 },
  { char: 'm', rawAtDiv64: 64 },
  { char: 'n', rawAtDiv64: 128 },
];

/**
 * 任意の duration を標準音価 (付点含む) の和に貪欲分解する。
 * 各要素は { char, dots } で、tied chain として結合可能。
 * 近似は一切しない — 完全分解のみ。
 */
function decomposeDuration(
  units: number,
  header: ParsedHeader,
): Array<{ char: string; dots: number }> {
  // 大→小順で標準音価 (基本 + 付点 1-3) のリストを構築
  const candidates: Array<{ char: string; units: number; dots: number }> = [];
  for (const e of DURATION_MAP) {
    const base = Math.round((e.rawAtDiv64 * header.div) / 64);
    if (base <= 0) continue;
    // 三重付点 → 二重付点 → 付点 → 基本 (大きい順で greedy)
    candidates.push({ char: e.char, units: Math.round(base * 1.875), dots: 3 });
    candidates.push({ char: e.char, units: Math.round(base * 1.75), dots: 2 });
    candidates.push({ char: e.char, units: Math.round(base * 1.5), dots: 1 });
    candidates.push({ char: e.char, units: base, dots: 0 });
  }
  candidates.sort((a, b) => b.units - a.units);

  const result: Array<{ char: string; dots: number }> = [];
  let remaining = units;
  while (remaining > 0) {
    let found = false;
    for (const c of candidates) {
      if (c.units > 0 && c.units <= remaining) {
        result.push({ char: c.char, dots: c.dots });
        remaining -= c.units;
        found = true;
        break;
      }
    }
    if (!found) break; // 分解不能な余り → 安全弁
  }
  return result;
}

/** 後方互換ラッパー: まず厳密マッチ → 失敗なら decompose の先頭要素を返す */
function unitsToLengthChar(
  units: number,
  _header: ParsedHeader,
  warnings: string[],
  diagnostics: MusicXmlToHideDiagnostic[],
  partIndex: number,
  measureIndex: number,
): string | null {
  const exact = unitsToLengthCharStrict(units, _header);
  if (exact) return exact;
  // 非標準 → diagnostic を emit しつつ最近接を返す (decompose は呼び出し元で使う)
  warnings.push(`パート#${partIndex + 1} 小節 ${measureIndex + 1}: duration ${units}u が標準長さに一致しません — tied chain で分解`);
  diagnostics.push({
    kind: 'nonStandardDuration',
    partIndex,
    measureIndex,
    durationUnits: units,
  });
  const chain = decomposeDuration(units, _header);
  return chain.length > 0 ? chain[0].char : 'k';
}

function formatPitch(p: HidePitch, keyFifths: number, slurStart: boolean = false): string {
  // v2.0: 毎回絶対音高。#/b/*/x/bb で臨時記号を表記。
  // alter=0 でも調号が暗黙に♯/♭を付ける音名の場合は * (ナチュラル) を明示する。
  let accChar = '';
  switch (p.alter) {
    case 2: accChar = 'x'; break;
    case 1: accChar = '#'; break;
    case -1: accChar = 'b'; break;
    case -2: accChar = 'bb'; break;
    default: {
      // alter=0 だが調号が暗黙に変化させる音名なら * を付ける
      const implied = keySigImpliedAlter(p.step, keyFifths);
      if (implied !== 0) accChar = '*';
      break;
    }
  }
  const step = slurStart ? p.step.toLowerCase() : p.step;
  return `${step}${accChar}${p.octave}`;
}

function clampAlter(n: number): -2 | -1 | 0 | 1 | 2 {
  if (n >= 2) return 2;
  if (n === 1) return 1;
  if (n === -1) return -1;
  if (n <= -2) return -2;
  return 0;
}

function keySigImpliedAlter(step: HidePitch['step'], fifths: number): HidePitch['alter'] {
  const sharpOrder: HidePitch['step'][] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const flatOrder: HidePitch['step'][] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
  if (fifths > 0) {
    if (sharpOrder.slice(0, Math.min(fifths, 7)).includes(step)) return 1;
  } else if (fifths < 0) {
    if (flatOrder.slice(0, Math.min(-fifths, 7)).includes(step)) return -1;
  }
  return 0;
}

/**
 * <part-list> から各パートの楽器名を抽出する。
 * ID → name のマッピングを返し、parts の順序に合わせて配列化。
 */
function extractPartNames(xml: string, parts: RawPart[]): (string | undefined)[] {
  const idToName = new Map<string, string>();
  const re = /<score-part\s+id\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/score-part>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const id = m[1];
    const inner = m[2];
    const nameMatch = /<part-name[^>]*>([^<]+)<\/part-name>/.exec(inner);
    if (nameMatch) {
      const name = nameMatch[1].trim();
      // 空文字や汎用名 (MusicXML, Music, Part) は無視
      if (name.length > 0 && !/^(MusicXML|Music|Part)\s*\d*$/i.test(name)) {
        idToName.set(id, name);
      }
    }
  }
  return parts.map(p => idToName.get(p.id));
}

function assignPartLabels(count: number, override?: string[], partNames?: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    if (override && i < override.length) {
      out.push(override[i]);
    } else {
      const num = String(i + 1);
      const name = partNames?.[i];
      out.push(name ? `${num}:${name}` : num);
    }
  }
  return out;
}

// ============================================================
// M2H エクスポート (musicXmlToHide の別名)
// ============================================================

/** M2H — MusicXML → .hide v2.1 完全変換エイリアス */
export const m2h = musicXmlToHide;
export type { MusicXmlToHideOptions as M2HOptions };
export type { MusicXmlToHideResult as M2HResult };
export type { MusicXmlToHideDiagnostic as M2HDiagnostic };
