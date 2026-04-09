/**
 * musicXmlToHide.ts — MusicXML を .hide ソースに逆変換する
 *
 * v1.9 ロードマップ項目 #1: Bach 389-chorales corpus の .hide 化前提。
 *
 * 目的: 4 声体多声楽譜 (主に Bach chorales) の MusicXML を、
 *       matrix mode (`analyzeMatrix`) でそのまま解析できる .hide grid form に
 *       変換すること。
 *
 * スコープ:
 *  - 複数 `<part>` (= 複数声部) を `[1] [2] [3] ...` パートラベルに連番マップ
 *  - 音符 (含む和音 = `<chord/>`) / 休符
 *  - タイ (`<tie type="start"/>` → `+`)
 *  - 小節区切り (`<measure>` → `|`)
 *  - 時間/拍子/調号 (1小節目の `<attributes>` から)
 *  - 多声 1 パート (= `<voice>` 複数) は最初の voice のみ採用、警告
 *
 * スコープ外 (検出時に warning):
 *  - 連符 (`<time-modification>`)
 *  - 動的記号 (`<dynamics>`)
 *  - スラー
 *  - 歌詞 (構造解析に不要なので捨てる)
 *  - 反復 (`<repeat>`)
 *  - 拍子・テンポ・調号の中途変更
 *  - ピックアップ小節 (`<implicit>yes</implicit>`)
 *
 * 依存: なし (XML パーサは内蔵の正規表現ベース mini extractor で対応)
 *       — Bach corpus + 自前 forward 出力ともに well-formed なので十分。
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
      /** `<attributes>` ブロックが複数 (= 拍子・調号の中途変更、v1 では未対応) */
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
      /** 連符 (`<time-modification>`) を検出 — duration をそのまま近似 */
      kind: 'tupletDetected';
      partIndex: number;
      measureIndex: number;
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
    clef: 'TREBLE' | 'BASS' | 'ALTO' | 'TENOR' | 'PERCUSSION';
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
  const stripped = xml.replace(/<!--[\s\S]*?-->/g, '');

  // 2. <part> ブロック抽出 (ID 付き)
  const parts = extractParts(stripped);
  if (parts.length === 0) {
    throw new Error('musicXmlToHide: no <part> elements found');
  }

  // 3. 1小節目の <attributes> からヘッダーを抽出 (最初のパート優先)
  const header = extractHeader(parts[0].body, warnings, diagnostics, 0);

  // 4. 各パートを per-measure cell に分解 → .hide token 列に変換
  const partLabels = assignPartLabels(parts.length, opts.partLabels);
  const partOutputs: string[][] = []; // partOutputs[pi] = [cell_str_per_measure]
  let maxMeasureCount = 0;
  for (let pi = 0; pi < parts.length; pi++) {
    const cells = convertPartToCells(parts[pi].body, header, warnings, diagnostics, pi);
    partOutputs.push(cells);
    if (cells.length > maxMeasureCount) maxMeasureCount = cells.length;
  }

  // 4b. パート間の measure count 不整合を構造化 diagnostic として emit
  //     **silent padding はしない** — 短いパートはそのまま短い grid 行として出力する。
  //     下流の analyzeMatrix() が `measureCountMismatch` を re-detect する。
  //     LLM レビュー層はこの diagnostic + 元 PDF 画像を見て修正候補を返す。
  for (let pi = 0; pi < parts.length; pi++) {
    if (partOutputs[pi].length < maxMeasureCount) {
      const got = partOutputs[pi].length;
      diagnostics.push({
        kind: 'partMeasureCountMismatch',
        partIndex: pi,
        partLabel: partLabels[pi],
        got,
        expected: maxMeasureCount,
      });
      warnings.push(`パート#${pi + 1} (${partLabels[pi]}) は ${got}/${maxMeasureCount} 小節 — 入力 MusicXML の不整合の可能性`);
    }
  }

  // 5. .hide ソース組み立て (grid form)
  const lines: string[] = [];

  // ヘッダー行
  lines.push(formatHeader(header));

  // 各パートを 1 行で出力
  for (let pi = 0; pi < parts.length; pi++) {
    const label = partLabels[pi];
    const cells = partOutputs[pi];
    const body = cells.map(c => ` ${c} `).join('|');
    lines.push(`[${label}]|${body}|`);
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
  // <part id="X"> ... </part> を非貪欲に拾う
  const re = /<part\s+id="([^"]+)"\s*>([\s\S]*?)<\/part>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push({ id: m[1], body: m[2] });
  }
  return out;
}

// ============================================================
// 内部: ヘッダー抽出
// ============================================================

interface ParsedHeader {
  timeNum: number;
  timeDen: number;
  keyFifths: number;
  div: number;
  divisionsXml: number;
  clef: 'TREBLE' | 'BASS' | 'ALTO' | 'TENOR' | 'PERCUSSION';
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

  // <clef><sign>X</sign><line>N</line></clef> → 我々の HideClef
  const clefSign = /<sign>(\w+)<\/sign>/.exec(attrBody)?.[1];
  const clefLine = parseIntFromTag(attrBody, 'line');
  const clef = inferClef(clefSign, clefLine);

  // div: MusicXML の divisions = quarter note 1個あたりの単位
  //      → 全音符 = 4 * divisions = .hide の DIV
  const div = divisionsXml * 4;

  // 中途変更検出 (簡易: 2個目以降の <attributes> や <sound tempo=> の有無)
  const attrCount = (partBody.match(/<attributes>/g) ?? []).length;
  if (attrCount > 1) {
    warnings.push('複数の <attributes> ブロックを検出しました (拍子・調号の中途変更は v1 では未対応、最初のものを採用)');
    diagnostics.push({ kind: 'multipleAttributes', partIndex });
  }

  return {
    timeNum: beats,
    timeDen: beatType,
    keyFifths: fifths,
    div,
    divisionsXml,
    clef,
  };
}

function parseIntFromTag(xml: string, tag: string): number | undefined {
  const re = new RegExp(`<${tag}>(-?\\d+)<\\/${tag}>`);
  const m = re.exec(xml);
  return m ? parseInt(m[1], 10) : undefined;
}

function inferClef(
  sign: string | undefined,
  line: number | undefined,
): ParsedHeader['clef'] {
  if (!sign) return 'TREBLE';
  const s = sign.toUpperCase();
  if (s === 'G') return 'TREBLE';
  if (s === 'F') return 'BASS';
  if (s === 'C' && line === 3) return 'ALTO';
  if (s === 'C' && line === 4) return 'TENOR';
  if (s === 'PERCUSSION') return 'PERCUSSION';
  return 'TREBLE';
}

function formatHeader(h: ParsedHeader): string {
  return `[CLEF:${h.clef} TIME:${h.timeNum}/${h.timeDen} KEY:${h.keyFifths} DIV:${h.div}]`;
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
  tieStart: boolean;
  voice: number;
  hasTimeModification: boolean;
}

function convertPartToCells(
  partBody: string,
  header: ParsedHeader,
  warnings: string[],
  diagnostics: MusicXmlToHideDiagnostic[],
  partIndex: number,
): string[] {
  // 各 <measure> を個別に処理
  const measures = extractMeasures(partBody);
  const out: string[] = [];
  for (let mi = 0; mi < measures.length; mi++) {
    const cellTokens = convertMeasureToHide(measures[mi], header, warnings, diagnostics, partIndex, mi);
    out.push(cellTokens);
  }
  return out;
}

function extractMeasures(partBody: string): string[] {
  const out: string[] = [];
  const re = /<measure[^>]*>([\s\S]*?)<\/measure>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(partBody)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function convertMeasureToHide(
  measureBody: string,
  header: ParsedHeader,
  warnings: string[],
  diagnostics: MusicXmlToHideDiagnostic[],
  partIndex: number,
  measureIndex: number,
): string {
  // <note>...</note> を順に抽出
  const noteBlocks = extractNoteBlocks(measureBody);
  const notes: XmlNote[] = noteBlocks.map(b => parseNoteBlock(b, header));

  // 多声 voice 検出 (1パート内に複数 voice があれば voice=1 のみ採用)
  const voicesUsed = new Set(notes.map(n => n.voice));
  if (voicesUsed.size > 1) {
    warnings.push(`パート#${partIndex + 1} 小節 ${measureIndex + 1}: 複数の <voice> を検出 (${[...voicesUsed].join(',')})、voice=1 のみ採用`);
    diagnostics.push({
      kind: 'multipleVoices',
      partIndex,
      measureIndex,
      voices: [...voicesUsed],
    });
  }
  const filteredNotes = voicesUsed.size > 1 ? notes.filter(n => n.voice === 1) : notes;

  // 連符検出
  if (filteredNotes.some(n => n.hasTimeModification)) {
    warnings.push(`パート#${partIndex + 1} 小節 ${measureIndex + 1}: 連符 (<time-modification>) を検出、duration をそのまま近似します`);
    diagnostics.push({ kind: 'tupletDetected', partIndex, measureIndex });
  }

  // tokens 構築
  const out: string[] = [];

  // 左端バーライン (`<barline location="left">` = 通常は repeatStart)
  // → 小節の先頭に `,:` を出力
  const leftBarline = extractBarlineStyle(measureBody, 'left');
  if (leftBarline === 'repeatStart') {
    out.push(',:');
  }

  let i = 0;
  while (i < filteredNotes.length) {
    const head = filteredNotes[i];

    // chord 集約: head + 続く isChordContinuation=true の note 群
    const chordPitches: HidePitch[] = [];
    if (head.isWholeMeasureRest) {
      out.push(durationToRest(measureRestUnits(header), header, warnings, diagnostics, partIndex, measureIndex, 0));
      i++;
      continue;
    }
    if (head.isRest) {
      out.push(durationToRest(head.duration, header, warnings, diagnostics, partIndex, measureIndex, head.dots));
      i++;
      continue;
    }
    if (head.pitch) chordPitches.push(head.pitch);
    let j = i + 1;
    while (j < filteredNotes.length && filteredNotes[j].isChordContinuation) {
      const cn = filteredNotes[j];
      if (!cn.isRest && cn.pitch) chordPitches.push(cn.pitch);
      j++;
    }
    if (chordPitches.length === 0) {
      i = j;
      continue;
    }
    // 付点の場合はベース duration を逆算して length char を引く
    const baseDur = head.dots === 2 ? Math.round(head.duration / 1.75)
      : head.dots === 1 ? Math.round(head.duration / 1.5)
      : head.duration;
    const lengthChar = unitsToLengthChar(baseDur, header, warnings, diagnostics, partIndex, measureIndex);
    if (lengthChar) {
      const dotStr = '.'.repeat(head.dots);
      const tokenStr = chordPitches.map(p => formatPitch(p, header.keyFifths)).join('') + lengthChar + dotStr;
      // タイ: head が tieStart の場合、トークン直後に '+'
      const withTie = head.tieStart ? `${tokenStr}+` : tokenStr;
      out.push(withTie);
    }
    i = j;
  }

  // 右端バーライン (`<barline location="right">` または末尾の暗黙的 location なし)
  // → 小節の末尾に `,`/`,,`/`,,,`/`:,` を出力
  const rightBarline = extractBarlineStyle(measureBody, 'right');
  out.push(barlineStyleToken(rightBarline ?? 'single'));

  return out.join(' ');
}

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
    if (barStyle === 'regular') return 'single';
    // 不明スタイルは undefined (= デフォルト single)
    return undefined;
  }
  return undefined;
}

/** バーラインスタイル → .hide ソース表現 */
function barlineStyleToken(style: HideBarlineStyle): string {
  switch (style) {
    case 'single': return ',';
    case 'double': return ',,';
    case 'final': return ',,,';
    case 'repeatStart': return ',:';
    case 'repeatEnd': return ':,';
  }
}

function extractNoteBlocks(measureBody: string): string[] {
  const out: string[] = [];
  const re = /<note(?:\s[^>]*)?>([\s\S]*?)<\/note>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(measureBody)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function parseNoteBlock(body: string, header: ParsedHeader): XmlNote {
  const isChordContinuation = /<chord\s*\/>/.test(body);
  const restMatch = /<rest(\s+measure="yes")?\s*\/>/.exec(body);
  const isRest = restMatch !== null;
  const isWholeMeasureRest = !!restMatch && !!restMatch[1];
  const duration = parseIntFromTag(body, 'duration') ?? 0;
  const dots = (body.match(/<dot\s*\/>/g) ?? []).length;
  const tieStart = /<tie\s+type="start"\s*\/>/.test(body);
  const voice = parseIntFromTag(body, 'voice') ?? 1;
  const hasTimeModification = /<time-modification>/.test(body);

  let pitch: HidePitch | undefined;
  if (!isRest) {
    const stepM = /<step>(\w)<\/step>/.exec(body);
    const octaveM = /<octave>(\d)<\/octave>/.exec(body);
    const alterM = /<alter>(-?\d+)<\/alter>/.exec(body);
    if (stepM && octaveM) {
      const step = stepM[1] as HidePitch['step'];
      // <alter> が明示されていなければ key signature が暗黙的に決める鳴音アルターを採用
      // (例: D major = fifths 2 で <step>F</step> の sounding は F#)
      const soundingAlter: -1 | 0 | 1 = alterM
        ? clampAlter(parseInt(alterM[1], 10))
        : keySigImpliedAlter(step, header.keyFifths);
      pitch = {
        step,
        octave: parseInt(octaveM[1], 10),
        alter: soundingAlter,
      };
    }
  }

  return {
    isRest,
    isWholeMeasureRest,
    isChordContinuation,
    duration,
    dots,
    pitch,
    tieStart,
    voice,
    hasTimeModification,
  };
}

function measureRestUnits(header: ParsedHeader): number {
  // <rest measure="yes"/> → 1小節分 (header の time signature × divisions)
  return Math.round((header.timeNum / header.timeDen) * header.div);
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
  // MusicXML の <duration> 値は divisions 単位 (= quarter note divisions)
  // .hide の length char は header.div 単位
  // → スケール: hideUnits = duration * (header.div / divisionsXml / 4 * 4) = duration * (header.div / header.divisionsXml / 4)
  //    が、divisionsXml = header.div / 4 なので結局 hideUnits = duration
  const hideUnits = duration;
  // 付点の場合はベース duration を逆算して length char を引く
  const baseUnits = dotCount === 2 ? Math.round(hideUnits / 1.75)
    : dotCount === 1 ? Math.round(hideUnits / 1.5)
    : hideUnits;
  const lc = unitsToLengthChar(baseUnits, header, warnings, diagnostics, partIndex, measureIndex);
  const dotStr = '.'.repeat(dotCount);
  return lc ? `R${lc}${dotStr}` : '';
}

function unitsToLengthChar(
  units: number,
  _header: ParsedHeader,
  warnings: string[],
  diagnostics: MusicXmlToHideDiagnostic[],
  partIndex: number,
  measureIndex: number,
): string | null {
  // 完全マッピング (DIV=32 のとき: h=1, i=2, j=4, k=8, l=16, m=32)
  // header.div != 32 のときは比例スケール
  const map: Array<{ char: string; rawAtDiv32: number }> = [
    { char: 'h', rawAtDiv32: 1 },
    { char: 'i', rawAtDiv32: 2 },
    { char: 'j', rawAtDiv32: 4 },
    { char: 'k', rawAtDiv32: 8 },
    { char: 'l', rawAtDiv32: 16 },
    { char: 'm', rawAtDiv32: 32 },
  ];
  for (const e of map) {
    const expected = (e.rawAtDiv32 * _header.div) / 32;
    if (Math.round(expected) === units) return e.char;
  }
  // 厳密マッチ失敗 → 一番近い基本値
  warnings.push(`パート#${partIndex + 1} 小節 ${measureIndex + 1}: duration ${units}u が標準長さに一致しません — 最近接の基本値で近似`);
  diagnostics.push({
    kind: 'nonStandardDuration',
    partIndex,
    measureIndex,
    durationUnits: units,
  });
  // 最近い rawAtDiv32 を探す
  let best = map[3]; // k = quarter
  let bestDist = Infinity;
  for (const e of map) {
    const expected = (e.rawAtDiv32 * _header.div) / 32;
    const d = Math.abs(expected - units);
    if (d < bestDist) { bestDist = d; best = e; }
  }
  return best.char;
}

function formatPitch(p: HidePitch, keyFifths: number): string {
  const implied = keySigImpliedAlter(p.step, keyFifths);
  let accChar = '';
  if (p.alter !== implied) {
    if (p.alter === 1) accChar = '#';
    else if (p.alter === -1) accChar = 'b';
    else accChar = 'n';
  }
  return `${p.step}${accChar}${p.octave}`;
}

function clampAlter(n: number): -1 | 0 | 1 {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

function keySigImpliedAlter(step: HidePitch['step'], fifths: number): -1 | 0 | 1 {
  const sharpOrder: HidePitch['step'][] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const flatOrder: HidePitch['step'][] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
  if (fifths > 0) {
    if (sharpOrder.slice(0, Math.min(fifths, 7)).includes(step)) return 1;
  } else if (fifths < 0) {
    if (flatOrder.slice(0, Math.min(-fifths, 7)).includes(step)) return -1;
  }
  return 0;
}

function assignPartLabels(count: number, override?: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    if (override && i < override.length) out.push(override[i]);
    else out.push(String(i + 1));
  }
  return out;
}
