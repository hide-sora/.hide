/**
 * hideLexer.ts — .hide ソーステキストを生トークン列に分解する
 *
 * 仕様:
 *   1. 先頭に [CLEF:... TIME:... KEY:... DIV:...] のヘッダー
 *   2. ボディは1文字ずつ走査し、優先順位に従ってトークン化
 *   3. v1.3: 改行・スペース・タブ・`|`・`;以降コメント` を無視
 *   4. v1.2: メタコマンド[...]・反復境界`:`・連符 `N(` `)` を生トークンに分解
 *      (構造化はパーサで行う)
 *   5. v1.3: 音名直後の `s/b/n` を臨時記号として読む
 */

import type {
  HideHeader,
  HideClef,
  HideNoteToken,
  HideRestToken,
  HideMetaToken,
  HidePitch,
  HideBarlineStyle,
} from './hideTypes';
import {
  LENGTH_ALIAS_TO_UNITS,
  NOTE_STEP_NORMALIZE,
  HIDE_HEADER_DEFAULT,
  createDefaultHeader,
  getLengthUnits,
} from './hideTypes';
import { HideParseError, offsetToPosition } from './hideErrors';
import type { HideSourcePosition } from './hideErrors';

// ============================================================
// 生トークン (Lexer 出力 / Parser 入力)
// ============================================================

/** 歌詞文字 (1音符ぶん、または1文字) */
export interface HideLyricRawToken {
  kind: 'lyric';
  text: string;
}

/** タイ記号 `+` */
export interface HideTieRawToken {
  kind: 'tie';
}

/** 連符開始 `N(` */
export interface HideTupletOpenRawToken {
  kind: 'tupletOpen';
  targetUnits: number;
}

/** 連符終了 `)` */
export interface HideTupletCloseRawToken {
  kind: 'tupletClose';
}

/**
 * 反復境界 `:`
 *  - 1個目の `:` は count=undefined → 開始
 *  - 2個目の `:` の直後に数字があれば count=N → 終了+回数
 *  - パーサがネスト解析時に判別する
 */
export interface HideRepeatBoundaryRawToken {
  kind: 'repeatBoundary';
  count?: number;
}

/**
 * 小節線 `|` (v1.9 matrix mode で復活)
 *
 * v1.8 までは lexer 段階で空白と一緒に捨てていたが、v1.9 では matrix mode が
 * 列の区切りとして必要とするため raw token として保持する。stream パーサは no-op で
 * 読み飛ばすので AST には現れない。
 */
export interface HideBarlineRawToken {
  kind: 'barline';
}

/**
 * 小節終止マーカー (v1.9 後期で導入)
 *
 * 5 種類の語彙を持つ hard barrier:
 *   `,`   = single (通常小節線)
 *   `,,`  = double (複縦線)
 *   `,,,` = final  (終止線)
 *   `,:` = repeatStart (繰り返しスタート, 次の小節の左端)
 *   `:,`  = repeatEnd   (繰り返し終わり, 現在の小節の右端)
 *
 * `.` は付点修飾子 (例: `k.` = 付点四分音符) として使用する。
 *
 * `bucketize` が
 *   - 現在の bucket を即 close (totalUnits != unitsPerMeasure なら warning)
 *   - style を bucket に記録
 *   - 新しい bucket を開始
 * という処理をする。`|` は引き続き whitespace 扱い (matrix mode の cell 区切り
 * としてのみ意味を持つ)。
 *
 * forward (`compileHide`) / reverse (`musicXmlToHide`) / future PDF OMR の
 * 三者で一貫する設計。
 */
export interface HideMeasureBarrierRawToken {
  kind: 'measureBarrier';
  style: HideBarlineStyle;
}

export type HideRawToken =
  | HideNoteToken
  | HideRestToken
  | HideMetaToken
  | HideLyricRawToken
  | HideTieRawToken
  | HideTupletOpenRawToken
  | HideTupletCloseRawToken
  | HideRepeatBoundaryRawToken
  | HideBarlineRawToken
  | HideMeasureBarrierRawToken;

export interface HideLexResult {
  header: HideHeader;
  tokens: HideRawToken[];
  /** tokens[i] のソース上の位置。エラーメッセージ用 */
  positions: HideSourcePosition[];
  source: string;
}

// ============================================================
// 公開API
// ============================================================

export function tokenize(source: string): HideLexResult {
  let i = 0;

  // 先頭の空白を skip
  i = skipWhitespaceAndComments(source, i);

  // 1. ヘッダー [...] (v1.8: 完全省略可。先頭が [ で始まる場合のみヘッダーとして解釈)
  let header: HideHeader = createDefaultHeader();
  if (source[i] === '[') {
    const headerEnd = source.indexOf(']', i);
    if (headerEnd < 0) {
      throw new HideParseError(
        'ヘッダーの ] が見つかりません',
        offsetToPosition(source, i),
        source,
      );
    }
    const headerStr = source.slice(i + 1, headerEnd);
    const headerPos = offsetToPosition(source, i);
    // v1.8: ヘッダーかボディ先頭メタかを判別。
    // 「先頭が音名・休符・数字・反復記号・半角英字でない文字」だけならヘッダーとみなす。
    // 具体的判別: ':' を含む長形式 (CLEF:TREBLE等) または 短形式パターン に一致するかで決める
    if (looksLikeHeader(headerStr)) {
      header = parseHeader(headerStr, headerPos, source);
      i = headerEnd + 1;
    }
    // looksLikeHeader=false の場合はヘッダーをスキップせず、ボディ側で [...] メタとして処理させる
  }

  // 2. ボディ
  const tokens: HideRawToken[] = [];
  const positions: HideSourcePosition[] = [];

  while (i < source.length) {
    // skip whitespace, comments, '|'
    const skipped = skipWhitespaceAndComments(source, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }

    const startPos = offsetToPosition(source, i);
    const c = source[i];

    // 小節線 `|` (v1.9: matrix mode で列の区切りとして使うため raw token に残す)
    if (c === '|') {
      tokens.push({ kind: 'barline' });
      positions.push(startPos);
      i++;
      continue;
    }

    // 小節終止マーカー (v1.9 後期: stream/reverse/OMR で一貫する end-of-measure)
    //   `,,,` = final  (終止線)
    //   `,,`  = double (複縦線)
    //   `,:` = repeatStart (繰り返しスタート、次の小節の左端マーカー)
    //   `,`   = single (通常小節線)
    // 貪欲: 長いものから順に試す
    if (c === ',') {
      let style: HideBarlineStyle;
      let consumed: number;
      if (source[i + 1] === ',' && source[i + 2] === ',') {
        style = 'final';
        consumed = 3;
      } else if (source[i + 1] === ',') {
        style = 'double';
        consumed = 2;
      } else if (source[i + 1] === ':') {
        style = 'repeatStart';
        consumed = 2;
      } else {
        style = 'single';
        consumed = 1;
      }
      tokens.push({ kind: 'measureBarrier', style });
      positions.push(startPos);
      i += consumed;
      continue;
    }

    // メタコマンド [...]
    if (c === '[') {
      const end = source.indexOf(']', i);
      if (end < 0) {
        throw new HideParseError(
          'メタコマンドの ] が見つかりません',
          startPos,
          source,
        );
      }
      const inner = source.slice(i + 1, end);
      const meta = parseMetaCommand(inner, startPos, source);
      tokens.push(meta);
      positions.push(startPos);
      i = end + 1;
      continue;
    }

    // `:,` = repeatEnd (繰り返し終わり、現在の小節の右端マーカー)
    // 反復境界 `:` よりも先にチェックする (`:,` を `:` + `,` と誤読しないため)
    if (c === ':' && source[i + 1] === ',') {
      tokens.push({ kind: 'measureBarrier', style: 'repeatEnd' });
      positions.push(startPos);
      i += 2;
      continue;
    }

    // 反復境界 `:`
    if (c === ':') {
      let j = i + 1;
      let countStr = '';
      while (j < source.length && /[0-9]/.test(source[j])) {
        countStr += source[j];
        j++;
      }
      if (countStr) {
        tokens.push({ kind: 'repeatBoundary', count: parseInt(countStr, 10) });
      } else {
        tokens.push({ kind: 'repeatBoundary' });
      }
      positions.push(startPos);
      i = j;
      continue;
    }

    // 連符 `N(`
    if (/[0-9]/.test(c)) {
      let j = i;
      let numStr = '';
      while (j < source.length && /[0-9]/.test(source[j])) {
        numStr += source[j];
        j++;
      }
      if (source[j] === '(') {
        tokens.push({ kind: 'tupletOpen', targetUnits: parseInt(numStr, 10) });
        positions.push(startPos);
        i = j + 1;
        continue;
      }
      // 数字 + ( でなければ歌詞扱い (例: 「1番」)
      tokens.push({ kind: 'lyric', text: numStr });
      positions.push(startPos);
      i = j;
      continue;
    }

    // 連符終端 `)`
    if (c === ')') {
      tokens.push({ kind: 'tupletClose' });
      positions.push(startPos);
      i++;
      continue;
    }

    // タイ `+`
    if (c === '+') {
      tokens.push({ kind: 'tie' });
      positions.push(startPos);
      i++;
      continue;
    }

    // 歌詞強制 `'`
    if (c === "'") {
      // 直後の音符パターンに一致する文字列を歌詞化 (#/s/b/n 対応)
      const candidate = source.slice(i + 1, i + 5); // 最大4文字
      const match = /^[A-Ga-g][#sbn]?[0-9][h-mH-M]/.exec(candidate);
      if (match) {
        tokens.push({ kind: 'lyric', text: match[0] });
        positions.push(startPos);
        i += 1 + match[0].length;
      } else if (i + 1 < source.length) {
        tokens.push({ kind: 'lyric', text: source[i + 1] });
        positions.push(startPos);
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    // 休符 R[h-mH-M][.][.]
    if (c === 'R') {
      const lengthChar = source[i + 1];
      if (lengthChar && LENGTH_ALIAS_TO_UNITS[lengthChar] !== undefined) {
        let baseUnits = getLengthUnits(lengthChar, header.div);
        const staccato = lengthChar === lengthChar.toUpperCase();
        let consumed = 2; // R + lengthChar
        // 付点: `.` = 1.5倍, `..` = 1.75倍
        let dots = 0;
        if (source[i + consumed] === '.') {
          dots = 1;
          consumed++;
          if (source[i + consumed] === '.') {
            dots = 2;
            consumed++;
          }
        }
        const durationUnits = dots === 2 ? baseUnits * 1.75 : dots === 1 ? baseUnits * 1.5 : baseUnits;
        const restToken: HideRestToken = {
          kind: 'rest',
          durationUnits: Math.round(durationUnits),
          dots,
          staccato,
          tieToNext: false,
        };
        tokens.push(restToken);
        positions.push(startPos);
        i += consumed;
        continue;
      }
      // R 単独 → 歌詞扱い
      tokens.push({ kind: 'lyric', text: 'R' });
      positions.push(startPos);
      i++;
      continue;
    }

    // 音符 (3-4文字パターン、和音可)
    if (/[A-Ga-g]/.test(c)) {
      const result = tryParseNote(source, i, header.div);
      if (result) {
        tokens.push(result.token);
        positions.push(startPos);
        i = result.nextOffset;
        continue;
      }
      // 音符パターン不一致 → 歌詞扱い
      tokens.push({ kind: 'lyric', text: c });
      positions.push(startPos);
      i++;
      continue;
    }

    // 上記いずれでもない → 歌詞 (1文字)
    // 連続する歌詞文字をまとめて1トークンにして効率化
    let lyricEnd = i;
    while (lyricEnd < source.length) {
      const lc = source[lyricEnd];
      if (
        isWhitespaceChar(lc) ||
        lc === '|' || lc === ';' || lc === ',' ||
        lc === '[' || lc === ']' || lc === '(' || lc === ')' ||
        lc === ':' || lc === '+' || lc === "'" ||
        lc === 'R' || /[A-Ga-g]/.test(lc) || /[0-9]/.test(lc)
      ) break;
      lyricEnd++;
    }
    if (lyricEnd > i) {
      tokens.push({ kind: 'lyric', text: source.slice(i, lyricEnd) });
      positions.push(startPos);
      i = lyricEnd;
    } else {
      // 念のためのフォールバック (1文字消費)
      tokens.push({ kind: 'lyric', text: c });
      positions.push(startPos);
      i++;
    }
  }

  return { header, tokens, positions, source };
}

// ============================================================
// ヘルパー
// ============================================================

function isWhitespaceChar(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

/**
 * 空白・コメントを skip して新しいオフセットを返す。
 *
 * v1.8 では `|` もここで捨てていたが、v1.9 matrix mode で列区切りとして
 * 必要になったため `|` は raw token として残す (= ここでは skip しない)。
 */
function skipWhitespaceAndComments(source: string, start: number): number {
  let i = start;
  while (i < source.length) {
    const c = source[i];
    if (isWhitespaceChar(c)) {
      i++;
      continue;
    }
    if (c === ';') {
      // 行末までコメント
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    break;
  }
  return i;
}

/**
 * ヘッダー文字列か単なるボディ内 [...] メタかを判別する。
 * v1.8: ヘッダー省略可。先頭の `[...]` がヘッダーらしくない場合はメタコマンドとして扱う。
 *
 * ヘッダーらしさの判定:
 *  - `:` を含む (CLEF:TREBLE, TIME:4/4, KEY:0, DIV:32)
 *  - 短縮形パターン: 譜表記号 / 拍子 / 調記号 / DIV / 移調 のいずれかを含む
 *  - 中身が空 ("[]" は v1.8 デフォルト適用のヘッダー)
 */
function looksLikeHeader(inner: string): boolean {
  const s = inner.trim();
  if (s.length === 0) return true; // [] = 完全デフォルトヘッダー
  if (s.includes(':')) return true; // CLEF:..., TIME:..., KEY:..., DIV:... の長形式
  // 短縮形要素を順に剥がしていって全部消えるかどうかで判定
  // 短縮形要素: T/B/Te/Al/N (clef), 数字/数字 (拍子), K[A-G][sb]?(min)? (調), K[+-]\d+ (移調), DIV\d+
  let rest = s;
  // 先頭から短縮形要素を貪欲に消費
  for (let safety = 0; safety < 20 && rest.length > 0; safety++) {
    rest = rest.replace(/^\s+/, '');
    if (rest.length === 0) break;
    // 拍子: 数字/数字
    let m = rest.match(/^(\d+)\/(\d+)/);
    if (m) { rest = rest.slice(m[0].length); continue; }
    // 移調 K+n / K-n
    m = rest.match(/^K[+-]\d+/);
    if (m) { rest = rest.slice(m[0].length); continue; }
    // DIV指定 D\d+ または DIV\d+
    m = rest.match(/^DIV\d+/i);
    if (m) { rest = rest.slice(m[0].length); continue; }
    m = rest.match(/^D\d+/);
    if (m) { rest = rest.slice(m[0].length); continue; }
    // 調 K[A-G][sb]?(m)?  (Kは大文字、調名は大文字)
    m = rest.match(/^K[A-G][sb]?m?/);
    if (m) { rest = rest.slice(m[0].length); continue; }
    // 譜表記号 (Treble/Bass/Alto/Tenor/Neutral) - 1〜2文字
    m = rest.match(/^(Te|Al|Pe|T|B|A|N)/);
    if (m && (rest.length === m[0].length || /[^A-Za-z0-9]/.test(rest[m[0].length]) || /[\dKD]/.test(rest[m[0].length]))) {
      rest = rest.slice(m[0].length);
      continue;
    }
    // 知らないパターン → ヘッダーではない
    return false;
  }
  return rest.length === 0;
}

/** ヘッダー文字列をパース (v1.8: 長形式 + 短縮形 両対応、省略時デフォルト) */
function parseHeader(
  inner: string,
  pos: HideSourcePosition,
  source: string,
): HideHeader {
  const result: HideHeader = createDefaultHeader();
  const trimmed = inner.trim();
  if (trimmed.length === 0) return result; // [] → 全部デフォルト

  // 長形式 (CLEF:..., TIME:..., KEY:..., DIV:..., CLEFS:...) と短縮形を共存させる。
  // まず ':' を含むトークンを長形式として処理し、残りを短縮形パーサで処理。
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const shortFormParts: string[] = [];
  for (const part of parts) {
    const colonIdx = part.indexOf(':');
    if (colonIdx < 0) {
      shortFormParts.push(part);
      continue;
    }
    const key = part.slice(0, colonIdx).toUpperCase();
    const value = part.slice(colonIdx + 1);
    if (key === 'CLEF') {
      result.clef = parseClefName(value, pos, source);
    } else if (key === 'TIME') {
      const m = value.match(/^(\d+)\/(\d+)$/);
      if (!m) throw new HideParseError(`不正な拍子: TIME:${value}`, pos, source);
      result.timeNum = parseInt(m[1], 10);
      result.timeDen = parseInt(m[2], 10);
    } else if (key === 'KEY') {
      // 数値 (五度圏) または 文字 (Cm/G/Bb等) を許容
      const n = parseInt(value, 10);
      if (!Number.isNaN(n)) {
        result.keyFifths = n;
      } else {
        result.keyFifths = parseKeyLetter(value, pos, source);
      }
    } else if (key === 'DIV') {
      const n = parseInt(value, 10);
      if (Number.isNaN(n) || n <= 0) throw new HideParseError(`不正なDIV: DIV:${value}`, pos, source);
      result.div = n;
    }
  }

  // 短縮形パーサ: 各 part を順次トークン化
  for (const part of shortFormParts) {
    parseShortFormHeader(part, result, pos, source);
  }

  // DIV が時間署名と整合するかチェック (units per measure が整数になるか)
  const unitsPerMeasure = (result.timeNum / result.timeDen) * result.div;
  if (!Number.isFinite(unitsPerMeasure) || unitsPerMeasure < 1 || Math.abs(unitsPerMeasure - Math.round(unitsPerMeasure)) > 1e-9) {
    throw new HideParseError(
      `DIV=${result.div} が拍子 ${result.timeNum}/${result.timeDen} と整合しません (1小節が整数 unit になりません)`,
      pos,
      source,
    );
  }

  return result;
}

/** 短縮形ヘッダー1要素を順次トークン化して result に書き込む */
function parseShortFormHeader(
  part: string,
  result: HideHeader,
  pos: HideSourcePosition,
  source: string,
): void {
  let i = 0;
  while (i < part.length) {
    const c = part[i];
    // 拍子: 数字/数字
    if (/[0-9]/.test(c)) {
      const m = part.slice(i).match(/^(\d+)\/(\d+)/);
      if (m) {
        result.timeNum = parseInt(m[1], 10);
        result.timeDen = parseInt(m[2], 10);
        i += m[0].length;
        continue;
      }
      throw new HideParseError(`不正なヘッダー要素: ${part.slice(i)}`, pos, source);
    }
    // K... (移調 K+n/K-n または 調 KCm/KBb 等)
    if (c === 'K') {
      // 移調 K+n / K-n
      const transposeM = part.slice(i).match(/^K([+-]\d+)/);
      if (transposeM) {
        result.transposeSemitones = parseInt(transposeM[1], 10);
        i += transposeM[0].length;
        continue;
      }
      // 調 KC / KCm / KBb / KF#m など (sは# として、bは♭として解釈)
      const keyM = part.slice(i).match(/^K([A-G])([sb#])?(m)?/);
      if (keyM) {
        const letter = keyM[1];
        const acc = keyM[2];
        const minor = !!keyM[3];
        result.keyFifths = letterToFifths(letter, acc, minor);
        i += keyM[0].length;
        continue;
      }
      throw new HideParseError(`不正なヘッダー要素: ${part.slice(i)}`, pos, source);
    }
    // DIV... または D...
    if (c === 'D') {
      const divM = part.slice(i).match(/^DIV?(\d+)/i);
      if (divM) {
        const n = parseInt(divM[1], 10);
        if (n <= 0) throw new HideParseError(`不正なDIV: ${divM[0]}`, pos, source);
        result.div = n;
        i += divM[0].length;
        continue;
      }
      throw new HideParseError(`不正なヘッダー要素: ${part.slice(i)}`, pos, source);
    }
    // 譜表記号 (Treble/Bass/Alto/Tenor/Neutral)
    const clefM = part.slice(i).match(/^(Treble|Bass|Alto|Tenor|Percussion|Te|Al|Pe|T|B|A|N)/);
    if (clefM) {
      result.clef = abbreviationToClef(clefM[1]);
      i += clefM[0].length;
      continue;
    }
    throw new HideParseError(`不正なヘッダー要素: ${part.slice(i)}`, pos, source);
  }
}

function parseClefName(name: string, pos: HideSourcePosition, source: string): HideClef {
  // 長形式 (CLEF:TREBLE, CLEF:TREBLE_8VA, CLEF:TREBLE_8VB, CLEF:BASS, ...) を受け付ける。
  // 値の表記は大文字小文字を区別せず、'-' / 空白は '_' に正規化する。
  const upper = name.toUpperCase().replace(/[-\s]/g, '_');
  if (upper === 'TREBLE' || upper === 'BASS' || upper === 'TREBLE_8VA' || upper === 'TREBLE_8VB' ||
      upper === 'ALTO' || upper === 'TENOR' || upper === 'PERCUSSION') {
    return upper as HideClef;
  }
  throw new HideParseError(`未知の譜表記号: CLEF:${name}`, pos, source);
}

/**
 * 短縮 vocabulary または長形式名のいずれかを HideClef に変換する。
 *  T   / TREBLE        → TREBLE      (ト音記号)
 *  B   / BASS          → BASS        (ヘ音記号)
 *  T8  / TREBLE_8VA    → TREBLE_8VA  (ト音記号 8va, 実音 1 オクターブ上)
 *  T-8 / TREBLE_8VB    → TREBLE_8VB  (ト音記号 8va bassa, 実音 1 オクターブ下 — テナー頻用)
 *  A   / AL / ALTO     → ALTO
 *  Te  / TENOR         → TENOR
 *  Pe  / N / PERCUSSION → PERCUSSION
 */
function parseClefShortOrLong(s: string, pos: HideSourcePosition, source: string): HideClef {
  const trimmed = s.trim();
  if (trimmed.length === 0) {
    throw new HideParseError('譜表記号が空です', pos, source);
  }
  // 短縮形 (case-insensitive)
  const upper = trimmed.toUpperCase();
  if (upper === 'T' || upper === 'TREBLE') return 'TREBLE';
  if (upper === 'B' || upper === 'BASS') return 'BASS';
  if (upper === 'T8' || upper === 'TREBLE_8VA' || upper === 'TREBLE-8VA' || upper === 'TREBLE8VA') return 'TREBLE_8VA';
  if (upper === 'T-8' || upper === 'TREBLE_8VB' || upper === 'TREBLE-8VB' || upper === 'TREBLE8VB') return 'TREBLE_8VB';
  if (upper === 'A' || upper === 'AL' || upper === 'ALTO') return 'ALTO';
  if (upper === 'TE' || upper === 'TENOR') return 'TENOR';
  if (upper === 'PE' || upper === 'N' || upper === 'PERCUSSION') return 'PERCUSSION';
  throw new HideParseError(`未知の譜表記号: ${s}`, pos, source);
}

function abbreviationToClef(s: string): HideClef {
  const upper = s.toUpperCase();
  if (upper === 'TREBLE' || upper === 'T') return 'TREBLE';
  if (upper === 'BASS' || upper === 'B') return 'BASS';
  if (upper === 'TREBLE8' || upper === 'T8') return 'TREBLE_8VA';
  if (upper === 'TREBLE-8' || upper === 'T-8') return 'TREBLE_8VB';
  if (upper === 'ALTO' || upper === 'AL' || upper === 'A') return 'ALTO';
  if (upper === 'TENOR' || upper === 'TE') return 'TENOR';
  if (upper === 'PERCUSSION' || upper === 'PE' || upper === 'N') return 'PERCUSSION';
  return 'TREBLE';
}

/**
 * インラインメタコマンド用の厳格な譜表 vocabulary パーサ。
 * 成功したら HideClef を返し、失敗したら null を返す (throw しない)。
 *
 *   T    → TREBLE
 *   B    → BASS
 *   T8   → TREBLE_8VA (ト音記号 8va, オクターブ上)
 *   T-8  → TREBLE_8VB (ト音記号 8va bassa, オクターブ下)
 *
 * `parseMetaCommand` の中で `[T]`/`[1T8]` などを試験的に判定する用途。
 * tempo/partSwitch など他の解釈と競合する可能性があるので throw しない。
 *
 * 注意: ここでは「インラインで頻用する短縮語彙」だけを受け付ける。長形式
 * (`CLEF:TREBLE_8VA`) は parseClefName() で別途扱う。
 */
function tryParseBareClef(s: string): HideClef | null {
  const upper = s.trim().toUpperCase();
  if (upper === 'T') return 'TREBLE';
  if (upper === 'B') return 'BASS';
  if (upper === 'T8') return 'TREBLE_8VA';
  if (upper === 'T-8') return 'TREBLE_8VB';
  return null;
}

function parseKeyLetter(value: string, pos: HideSourcePosition, source: string): number {
  // 例: "C", "Cm", "G", "F#", "Bb", "Cmaj", "Cmin"
  const m = value.match(/^([A-Ga-g])([sb#♭])?(m|min|maj|major|minor)?$/);
  if (!m) throw new HideParseError(`不正な調号: KEY:${value}`, pos, source);
  const letter = m[1].toUpperCase();
  const acc = m[2];
  const minor = m[3] && /^m(in)?$/.test(m[3]);
  return letterToFifths(letter, acc, !!minor);
}

/** 音名+臨時記号+長短調 → 五度圏 fifths */
function letterToFifths(letter: string, acc: string | undefined, minor: boolean): number {
  // 長調基準の fifths
  // C=0, G=1, D=2, A=3, E=4, B=5, F=-1
  const baseMajor: Record<string, number> = {
    C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, F: -1,
  };
  let f = baseMajor[letter];
  if (f === undefined) f = 0;
  if (acc === '#' || acc === 's') f += 7;
  else if (acc === 'b' || acc === '♭') f -= 7;
  if (minor) f -= 3;
  return f;
}

/** parseMetaCommand 用の薄いラッパー (関数定義順の都合) */
function letterToFifthsForMeta(letter: string, acc: string | undefined, minor: boolean): number {
  return letterToFifths(letter, acc, minor);
}

/** メタコマンド (角括弧の中身) をパース */
function parseMetaCommand(
  inner: string,
  pos: HideSourcePosition,
  source: string,
): HideMetaToken {
  if (!inner) throw new HideParseError('空のメタコマンド []', pos, source);

  // 先に bare な譜表指定 (clefChange) を判定。
  //   [T]   → TREBLE
  //   [B]   → BASS
  //   [T8]  → TREBLE_8VA (ト音記号 8va, オクターブ上)
  //   [T-8] → TREBLE_8VB (ト音記号 8va bassa, オクターブ下 — テナー頻用)
  //
  // これを tempo/key 判定より先に置くことで [T] / [T8] / [T-8] が clefChange として
  // 解釈される。[T120] のような「T + 数字」は後続の tempo 判定に落ちる。
  {
    const clefOnly = tryParseBareClef(inner);
    if (clefOnly !== null) {
      return { kind: 'meta', type: 'clefChange', clef: clefOnly };
    }
  }

  // 数字+譜表 の partSwitch+clef: [1T] [2B] [3T8] [4T-8] など
  //   先頭が数字で、残りが譜表 vocabulary として解釈できれば OK
  {
    const m = inner.match(/^(\d+)(.+)$/);
    if (m) {
      const labelPart = m[1];
      const clefPart = m[2];
      const clefOnly = tryParseBareClef(clefPart);
      if (clefOnly !== null) {
        return {
          kind: 'meta',
          type: 'partSwitch',
          partLabel: labelPart,
          clef: clefOnly,
        };
      }
    }
  }

  const head = inner[0];

  // [T120] tempo  (note: [T] 単独は clefChange として上で処理済み)
  if (head === 'T') {
    if (/^\d/.test(inner.slice(1))) {
      const bpm = parseFloat(inner.slice(1));
      if (Number.isFinite(bpm) && bpm > 0) {
        return { kind: 'meta', type: 'tempo', bpm };
      }
    }
    throw new HideParseError(`不正なテンポ指定: [${inner}]`, pos, source);
  }

  // [M3/4]
  if (head === 'M') {
    const m = inner.slice(1).match(/^(\d+)\/(\d+)$/);
    if (m) {
      return {
        kind: 'meta',
        type: 'time',
        timeNum: parseInt(m[1], 10),
        timeDen: parseInt(m[2], 10),
      };
    }
    throw new HideParseError(`不正な拍子変更: [${inner}]`, pos, source);
  }

  // [K+2] / [K-1] : v1.6 半音シフト
  if (head === 'K') {
    // 移調 K+n / K-n
    const transposeM = inner.slice(1).match(/^([+-]\d+)$/);
    if (transposeM) {
      return { kind: 'meta', type: 'transpose', transposeSemitones: parseInt(transposeM[1], 10) };
    }
    // 元曲の調 KC / KCm / KBb / KF#m など
    const keyM = inner.slice(1).match(/^([A-G])([sb#])?(m|min|maj)?$/);
    if (keyM) {
      const letter = keyM[1];
      const acc = keyM[2];
      const minor = !!(keyM[3] && /^m(in)?$/.test(keyM[3]));
      const fifths = letterToFifthsForMeta(letter, acc, minor);
      return { kind: 'meta', type: 'key', keyFifths: fifths };
    }
    // 五度圏数値 [K0] → 0 (互換用)
    const numM = inner.slice(1).match(/^(0)$/);
    if (numM) return { kind: 'meta', type: 'key', keyFifths: 0 };
    throw new HideParseError(`不正な調指定: [${inner}]`, pos, source);
  }

  // パート切替の一般ルール (v1.9):
  //   [] の中身が「数字のみ」または「P のみ」 → 新パート
  //   - [1] [2] ... [N] = 任意人数アカペラの番号付きボーカルパート
  //   - [P]             = voice percussion (ボイパ)
  //
  // 旧 SATB partSwitch [S][A][T][B] および旧 [P1][P2] は v1.9 で廃止。
  // 4声合唱を表現する場合も [1][2][3][4] を使う。
  if (inner === 'P' || /^\d+$/.test(inner)) {
    return { kind: 'meta', type: 'partSwitch', partLabel: inner };
  }

  throw new HideParseError(`未知のメタコマンド: [${inner}]`, pos, source);
}

/**
 * 音符パターン [A-Ga-g](#|s|b|n)?[0-9]([A-Ga-g](#|s|b|n)?[0-9])*[h-mH-M] を試行
 * 一致しなければ null を返す。
 *
 * - 1文字目の音名の大小がスラー開始判定 (lower=slurStart)
 * - 末尾長さ文字の大小がスタッカート判定 (Upper=staccato)
 * - 和音の場合、2つ目以降の音名の大小は無視 (常にスラー判定は1個目)
 * - 臨時記号: # または s = sharp, b = flat, n = natural (どれも明示的)
 * - DIV != 32 の場合は length unit が DIV/32 倍にスケールされる
 */
function tryParseNote(
  source: string,
  start: number,
  div: number,
): { token: HideNoteToken; nextOffset: number } | null {
  const pitches: HidePitch[] = [];
  let i = start;
  let slurStart = false;

  while (i < source.length) {
    const c = source[i];
    if (!/[A-Ga-g]/.test(c)) break;

    const step = NOTE_STEP_NORMALIZE[c];
    if (!step) return null;
    if (i === start) {
      slurStart = c === c.toLowerCase();
    }
    i++;

    // optional accidental: # / s = sharp, b = flat, n = natural
    let alter: -1 | 0 | 1 = 0;
    let accidentalExplicit = false;
    if (i < source.length) {
      const accChar = source[i];
      if (accChar === '#' || accChar === 's') {
        alter = 1;
        accidentalExplicit = true;
        i++;
      } else if (accChar === 'b') {
        // 'b' は次がオクターブ数字なら音名Bと衝突しないが、
        // 直前に音名がある場合は flat として読む
        // ※ B を音名として使うのは大文字Bのみなので衝突しない
        alter = -1;
        accidentalExplicit = true;
        i++;
      } else if (accChar === 'n') {
        alter = 0;
        accidentalExplicit = true;
        i++;
      }
    }

    // octave (1桁)
    if (i >= source.length || !/[0-9]/.test(source[i])) {
      return null;
    }
    const octave = parseInt(source[i], 10);
    i++;

    pitches.push({ step, octave, alter, accidentalExplicit });

    // 次の文字を見る
    const next = source[i];
    if (next && LENGTH_ALIAS_TO_UNITS[next] !== undefined) {
      // 末尾長さ → トークン完成 (DIV対応スケール)
      let baseUnits = getLengthUnits(next, div);
      const staccato = next === next.toUpperCase();
      i++;
      // 付点: `.` = 1.5倍, `..` = 1.75倍
      let dots = 0;
      if (source[i] === '.') {
        dots = 1;
        i++;
        if (source[i] === '.') {
          dots = 2;
          i++;
        }
      }
      const durationUnits = dots === 2 ? baseUnits * 1.75 : dots === 1 ? baseUnits * 1.5 : baseUnits;
      return {
        token: {
          kind: 'note',
          pitches,
          durationUnits: Math.round(durationUnits),
          dots,
          staccato,
          slurStart,
          tieToNext: false,
        },
        nextOffset: i,
      };
    }
    if (next && /[A-Ga-g]/.test(next)) {
      // 和音継続
      continue;
    }
    // どちらでもない → 音符パターン不一致
    return null;
  }

  return null;
}
