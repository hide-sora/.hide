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
 *  - スラー (`<slur type="start"/>` → 小文字音名)
 *  - スタッカート (`<staccato/>` → 大文字長さ)
 *  - 連符 (`<time-modification>` → `N(...)` 構文)
 *  - 歌詞 (`<lyric><text>` → 歌詞トークン)
 *  - テンポ (`<sound tempo>` / `<metronome>` → `[TN]`)
 *  - 強弱記号 (`<dynamics>` → `[Dp]` 等, `<wedge>` → `[D<]`/`[D>]`/`[D/]`)
 *  - 拍子・調号の中途変更 (`<attributes>` → `[MN/D]`/`[KN]`)
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

  // 各パートを 1 行で出力 (インライン形式: barline トークンのみで小節区切り)
  for (let pi = 0; pi < parts.length; pi++) {
    const label = partLabels[pi];
    const cells = partOutputs[pi];
    lines.push(`[${label}]| ${cells.join(' | ')} |`);
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

function parseFloatFromTag(xml: string, tag: string): number | undefined {
  const re = new RegExp(`<${tag}>(-?[\\d.]+)<\\/${tag}>`);
  const m = re.exec(xml);
  return m ? parseFloat(m[1]) : undefined;
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
  // v2: 拡張フィールド
  slurStart: boolean;
  slurEnd: boolean;
  staccato: boolean;
  accent: boolean;
  tenuto: boolean;
  fermata: boolean;
  marcato: boolean;
  trill: boolean;
  isGrace: boolean;
  isAcciaccatura: boolean;
  actualNotes?: number;
  normalNotes?: number;
  tupletType?: 'start' | 'stop';
  lyricText?: string;
}

/** 小節内の要素 (音符・方向指示・属性変更) を位置順で保持 */
interface MeasureEvent {
  pos: number;
  kind: 'note' | 'direction' | 'attributes';
  body: string;
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

  // 中途変更の検出用: running state
  let runningTimeNum = header.timeNum;
  let runningTimeDen = header.timeDen;
  let runningKeyFifths = header.keyFifths;

  for (let mi = 0; mi < measures.length; mi++) {
    const result = convertMeasureToHide(
      measures[mi], header, warnings, diagnostics, partIndex, mi,
      runningTimeNum, runningTimeDen, runningKeyFifths,
    );
    out.push(result.tokens);
    if (result.newTimeNum !== undefined) runningTimeNum = result.newTimeNum;
    if (result.newTimeDen !== undefined) runningTimeDen = result.newTimeDen;
    if (result.newKeyFifths !== undefined) runningKeyFifths = result.newKeyFifths;
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

// ============================================================
// 内部: 小節要素抽出 (position 順)
// ============================================================

function extractMeasureEvents(measureBody: string): MeasureEvent[] {
  const events: MeasureEvent[] = [];

  // <note> 要素
  const noteRe = /<note(?:\s[^>]*)?>([\s\S]*?)<\/note>/g;
  let m: RegExpExecArray | null;
  while ((m = noteRe.exec(measureBody)) !== null) {
    events.push({ pos: m.index, kind: 'note', body: m[1] });
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

  events.sort((a, b) => a.pos - b.pos);
  return events;
}

// ============================================================
// 内部: direction 解析 (テンポ・強弱)
// ============================================================

function parseDirection(body: string): string[] {
  const tokens: string[] = [];

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

  // <wedge type="crescendo|diminuendo|stop"/>
  const wedgeMatch = /<wedge\s+type="(\w+)"/.exec(body);
  if (wedgeMatch) {
    const wt = wedgeMatch[1];
    if (wt === 'crescendo') tokens.push('[D<]');
    else if (wt === 'diminuendo') tokens.push('[D>]');
    else if (wt === 'stop') tokens.push('[D/]');
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
    tokens.push(`[K${fifthsToKeyName(fifths)}]`);
    newKeyFifths = fifths;
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
      measureRestUnits(header), header, warnings, diagnostics, partIndex, measureIndex, 0, false,
    );
    if (restTok) noteTokens.push({ pos: 0, token: restTok });
  }

  // フェーズ 5: position 順にマージして組み立て
  const allTokens = [...noteTokens, ...dirTokens, ...attrTokens];
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
): Array<{ pos: number; token: string }> {
  const out: Array<{ pos: number; token: string }> = [];
  let i = 0;

  while (i < notes.length) {
    const { pos, note: head } = notes[i];

    // ---- 全小節休符 ----
    if (head.isWholeMeasureRest) {
      const tok = durationToRest(measureRestUnits(header), header, warnings, diagnostics, partIndex, measureIndex, 0, false);
      if (tok) out.push({ pos, token: tok });
      i++;
      continue;
    }

    // ---- 通常休符 ----
    if (head.isRest) {
      const tok = durationToRest(head.duration, header, warnings, diagnostics, partIndex, measureIndex, head.dots, head.staccato);
      if (tok) out.push({ pos, token: tok });
      i++;
      continue;
    }

    // ---- 連符グループ ----
    if (head.hasTimeModification && !head.isChordContinuation) {
      const result = collectTupletGroup(notes, i, header, warnings, diagnostics, partIndex, measureIndex);
      if (result.token) out.push({ pos, token: result.token });
      i = result.nextIndex;
      continue;
    }

    // ---- 通常音符 (和音を含む) ----
    const result = emitSingleNote(notes, i, header, warnings, diagnostics, partIndex, measureIndex);
    if (result.token) out.push({ pos, token: result.token });
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
  // 付点の場合はベース duration を逆算して length char を引く
  // MusicXML が <dot/> タグを省略している場合は detectDotsFromDuration でフォールバック
  let dots = head.dots;
  let baseDur: number;
  if (dots > 0) {
    baseDur = dots === 2 ? Math.round(duration / 1.75)
      : Math.round(duration / 1.5);
  } else {
    const detected = detectDotsFromDuration(duration, header);
    dots = detected.dots;
    baseDur = detected.baseDur;
  }
  const lengthChar = unitsToLengthChar(baseDur, header, warnings, diagnostics, partIndex, measureIndex);
  if (!lengthChar) return { token: '', nextIndex: j };

  const dotStr = '.'.repeat(dots);
  // スタッカート → 大文字
  const durChar = head.staccato ? lengthChar.toUpperCase() : lengthChar;

  // スラー → 1 番目のピッチを小文字
  const pitchStr = chordPitches.map((p, idx) =>
    formatPitch(p, header.keyFifths, idx === 0 && head.slurStart),
  ).join('');

  let token = pitchStr + durChar + dotStr;

  // アーティキュレーション・装飾サフィックス
  if (head.accent) token += '>';
  if (head.tenuto) token += '-';
  if (head.fermata) token += '~';
  if (head.marcato) token += '^';
  if (head.trill) token += '*';
  if (head.slurEnd) token += '_';

  // タイ
  if (head.tieStart) token += '+';

  // 装飾音プレフィックス
  if (head.isGrace) {
    token = (head.isAcciaccatura ? '~~' : '~') + token;
  }

  // 歌詞
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

  while (i < notes.length) {
    const n = notes[i].note;
    if (!n.hasTimeModification && !n.isChordContinuation) break;
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

  // 連符内の各 note を .hide トークンに変換
  const memberTokens: string[] = [];
  let gi = 0;
  while (gi < groupNotes.length) {
    const gn = groupNotes[gi].note;
    if (gn.isChordContinuation) { gi++; continue; }

    // nominal duration for this member
    const nominalDur = Math.round(gn.duration * actual / normal);

    // emitSingleNote を使って変換 (durationOverride で nominal を渡す)
    const result = emitSingleNoteInline(
      groupNotes, gi, header, warnings, diagnostics, partIndex, measureIndex, nominalDur,
    );
    if (result.token) memberTokens.push(result.token);
    gi = result.nextIndex;
  }

  // メンバーが空なら連符トークンを出さない (全て休符だった場合など)
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

  // v2: 拡張フィールド
  const slurStart = /<slur\s+type="start"/.test(body);
  const slurEnd = /<slur\s+type="stop"/.test(body);
  const staccato = /<staccato\s*\/>/.test(body);
  const accent = /<accent\s*\/>/.test(body);
  const tenuto = /<tenuto\s*\/>/.test(body);
  const fermata = /<fermata/.test(body);
  const marcato = /<strong-accent/.test(body);
  const trill = /<trill-mark\s*\/>/.test(body);
  const isGrace = /<grace/.test(body);
  const isAcciaccatura = /<grace\s+slash="yes"/.test(body);

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
  if (/<tuplet\s+type="start"/.test(body)) tupletType = 'start';
  else if (/<tuplet\s+type="stop"/.test(body)) tupletType = 'stop';

  // 歌詞
  let lyricText: string | undefined;
  const lyricMatch = /<lyric[^>]*>[\s\S]*?<text>([^<]*)<\/text>[\s\S]*?<\/lyric>/.exec(body);
  if (lyricMatch) {
    lyricText = lyricMatch[1];
  }

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
    duration: isGrace ? 0 : duration, // grace notes have 0 duration in .hide
    dots,
    pitch,
    tieStart,
    voice,
    hasTimeModification,
    slurStart,
    slurEnd,
    staccato,
    accent,
    tenuto,
    fermata,
    marcato,
    trill,
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
    if (barStyle === 'regular') return 'single';
    // 不明スタイルは undefined (= デフォルト single)
    return undefined;
  }
  return undefined;
}

/** <ending number="N" type="start"/> → N を抽出 */
function extractVoltaNumber(measureBody: string): number | undefined {
  const m = /<ending\s+number="(\d+)"\s+type="start"/.exec(measureBody);
  return m ? parseInt(m[1], 10) : undefined;
}

/** バーラインスタイル → .hide ソース表現 */
/** 五度圏の数値 → .hide の調名 (例: 4→"E", -6→"Gb") */
function fifthsToKeyName(fifths: number): string {
  const names: Record<number, string> = {
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
  const rawValues = [1, 2, 4, 8, 16, 32]; // rawAtDiv32: h, i, j, k, l, m
  // まず完全一致を優先的に探す (dotted h と undotted j の衝突回避)
  for (const raw of rawValues) {
    const base = Math.round((raw * header.div) / 32);
    if (base <= 0) continue;
    if (base === duration) return { baseDur: base, dots: 0 };
  }
  // 完全一致なし → 付点を試す
  for (const raw of rawValues) {
    const base = Math.round((raw * header.div) / 32);
    if (base <= 0) continue;
    if (Math.round(base * 1.5) === duration) return { baseDur: base, dots: 1 };
    if (Math.round(base * 1.75) === duration) return { baseDur: base, dots: 2 };
  }
  return { baseDur: duration, dots: 0 };
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
  staccato: boolean,
): string {
  const hideUnits = duration;
  // 付点の場合はベース duration を逆算して length char を引く
  // MusicXML が <dot/> タグを省略している場合は detectDotsFromDuration でフォールバック
  let dots = dotCount;
  let baseUnits: number;
  if (dots > 0) {
    baseUnits = dots === 2 ? Math.round(hideUnits / 1.75)
      : Math.round(hideUnits / 1.5);
  } else {
    const detected = detectDotsFromDuration(hideUnits, header);
    dots = detected.dots;
    baseUnits = detected.baseDur;
  }
  const lc = unitsToLengthChar(baseUnits, header, warnings, diagnostics, partIndex, measureIndex);
  const dotStr = '.'.repeat(dots);
  if (!lc) return '';
  const durChar = staccato ? lc.toUpperCase() : lc;
  return `R${durChar}${dotStr}`;
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

function formatPitch(p: HidePitch, _keyFifths: number, slurStart: boolean = false): string {
  // .hide は実音ベース: F4 = F natural, Ab3 = A flat 3。
  // key signature は音符のピッチに影響しない。
  // alter !== 0 なら常に明示的に臨時記号を出力する。
  let accChar = '';
  if (p.alter === 1) accChar = '#';
  else if (p.alter === -1) accChar = 'b';
  const step = slurStart ? p.step.toLowerCase() : p.step;
  return `${step}${accChar}${p.octave}`;
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
