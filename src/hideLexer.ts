/**
 * hideLexer.ts — .hide v2.0 ソーステキストを生トークン列に分解する
 *
 * v2.0 破壊的変更:
 *  - 臨時記号: # b * x bb (s 廃止)
 *  - 音価: g-n 8段階 (case-insensitive, 大文字staccato廃止)
 *  - アーティキュレーション: s S > ^ - ~ サフィックス
 *  - オーナメント: tr mr tn z1 z2 z3 ar gl サフィックス
 *  - 前打音: ` / `` プレフィックス
 *  - ブロックコメント: \/* ... *\/
 *  - 小節線: ,- (dashed), ,. (invisible) 追加
 *  - メタコマンド大幅拡張
 *  - DIV デフォルト 64
 */

import type {
  HideHeader,
  HideClef,
  HideNoteToken,
  HideRestToken,
  HideMetaToken,
  HideNoteheadType,
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

export interface HideLyricRawToken { kind: 'lyric'; text: string; }
export interface HideTieRawToken { kind: 'tie'; }
export interface HideTupletOpenRawToken { kind: 'tupletOpen'; targetUnits: number; }
export interface HideTupletCloseRawToken { kind: 'tupletClose'; }
export interface HideRepeatBoundaryRawToken { kind: 'repeatBoundary'; count?: number; }
export interface HideBarlineRawToken { kind: 'barline'; }
export interface HideMeasureBarrierRawToken { kind: 'measureBarrier'; style: HideBarlineStyle; }

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
  positions: HideSourcePosition[];
  source: string;
}

// ============================================================
// 公開API
// ============================================================

export function tokenize(source: string): HideLexResult {
  let i = 0;
  i = skipWhitespaceAndComments(source, i);

  // 1. ヘッダー
  let header: HideHeader = createDefaultHeader();
  if (source[i] === '[') {
    const headerEnd = source.indexOf(']', i);
    if (headerEnd < 0) {
      throw new HideParseError('ヘッダーの ] が見つかりません', offsetToPosition(source, i), source);
    }
    const headerStr = source.slice(i + 1, headerEnd);
    const headerPos = offsetToPosition(source, i);
    if (looksLikeHeader(headerStr)) {
      header = parseHeader(headerStr, headerPos, source);
      i = headerEnd + 1;
    }
  }

  // 2. ボディ
  const tokens: HideRawToken[] = [];
  const positions: HideSourcePosition[] = [];

  while (i < source.length) {
    const skipped = skipWhitespaceAndComments(source, i);
    if (skipped !== i) { i = skipped; continue; }

    const startPos = offsetToPosition(source, i);
    const c = source[i];

    // `|` barline (matrix mode cell separator)
    if (c === '|') {
      tokens.push({ kind: 'barline' });
      positions.push(startPos);
      i++;
      continue;
    }

    // 小節終止マーカー (v2.0: ,- dashed, ,. invisible 追加)
    if (c === ',') {
      let style: HideBarlineStyle;
      let consumed: number;
      if (source[i + 1] === ',' && source[i + 2] === ',') {
        style = 'final'; consumed = 3;
      } else if (source[i + 1] === ',') {
        style = 'double'; consumed = 2;
      } else if (source[i + 1] === ':') {
        style = 'repeatStart'; consumed = 2;
      } else if (source[i + 1] === '-') {
        style = 'dashed'; consumed = 2;
      } else if (source[i + 1] === '.') {
        style = 'invisible'; consumed = 2;
      } else {
        style = 'single'; consumed = 1;
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
        throw new HideParseError('メタコマンドの ] が見つかりません', startPos, source);
      }
      const inner = source.slice(i + 1, end);
      const meta = parseMetaCommand(inner, startPos, source);
      tokens.push(meta);
      positions.push(startPos);
      i = end + 1;
      continue;
    }

    // `:,` = repeatEnd
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
      while (j < source.length && /[0-9]/.test(source[j])) { countStr += source[j]; j++; }
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
      while (j < source.length && /[0-9]/.test(source[j])) { numStr += source[j]; j++; }
      if (source[j] === '(') {
        tokens.push({ kind: 'tupletOpen', targetUnits: parseInt(numStr, 10) });
        positions.push(startPos);
        i = j + 1;
        continue;
      }
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
      const candidate = source.slice(i + 1, i + 8);
      const match = /^[A-Ga-g](?:bb|[#bx*])?[0-9](?:bb|[#bx*])?[g-nG-N]/.exec(candidate);
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

    // 休符 R[g-nG-N][.]*
    if (c === 'R') {
      const lengthChar = source[i + 1];
      if (lengthChar && LENGTH_ALIAS_TO_UNITS[lengthChar] !== undefined) {
        const baseUnits = getLengthUnits(lengthChar, header.div);
        let consumed = 2;
        let dots = 0;
        while (source[i + consumed] === '.' && dots < 3) { dots++; consumed++; }
        const durationUnits = applyDots(baseUnits, dots);
        const restToken: HideRestToken = {
          kind: 'rest',
          durationUnits: Math.round(durationUnits),
          dots,
          tieToNext: false,
        };
        tokens.push(restToken);
        positions.push(startPos);
        i += consumed;
        continue;
      }
      tokens.push({ kind: 'lyric', text: 'R' });
      positions.push(startPos);
      i++;
      continue;
    }

    // 装飾音プレフィックス `` ` `` / ` `` ` + 音符 (v2.0: ~ → `)
    if (c === '`') {
      let graceType: 'grace' | 'acciaccatura' = 'grace';
      let gi = i + 1;
      if (gi < source.length && source[gi] === '`') {
        graceType = 'acciaccatura';
        gi++;
      }
      if (gi < source.length && /[A-Ga-g]/.test(source[gi])) {
        const result = tryParseNote(source, gi, header.div);
        if (result) {
          result.token.graceType = graceType;
          result.token.slurStart = false; // 前打音では小文字音名によるスラー開始を無効化
          tokens.push(result.token);
          positions.push(startPos);
          i = result.nextOffset;
          continue;
        }
      }
      tokens.push({ kind: 'lyric', text: c });
      positions.push(startPos);
      i++;
      continue;
    }

    // 音符
    if (/[A-Ga-g]/.test(c)) {
      const result = tryParseNote(source, i, header.div);
      if (result) {
        tokens.push(result.token);
        positions.push(startPos);
        i = result.nextOffset;
        continue;
      }
      tokens.push({ kind: 'lyric', text: c });
      positions.push(startPos);
      i++;
      continue;
    }

    // 歌詞 (連続する非特殊文字)
    let lyricEnd = i;
    while (lyricEnd < source.length) {
      const lc = source[lyricEnd];
      if (
        isWhitespaceChar(lc) ||
        lc === '|' || lc === ';' || lc === ',' ||
        lc === '[' || lc === ']' || lc === '(' || lc === ')' ||
        lc === ':' || lc === '+' || lc === "'" || lc === '`' ||
        lc === 'R' || /[A-Ga-g]/.test(lc) || /[0-9]/.test(lc) ||
        (lc === '/' && source[lyricEnd + 1] === '*')
      ) break;
      lyricEnd++;
    }
    if (lyricEnd > i) {
      tokens.push({ kind: 'lyric', text: source.slice(i, lyricEnd) });
      positions.push(startPos);
      i = lyricEnd;
    } else {
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

/** 付点による音価倍率 */
function applyDots(base: number, dots: number): number {
  if (dots === 0) return base;
  if (dots === 1) return base * 1.5;
  if (dots === 2) return base * 1.75;
  if (dots === 3) return base * 1.875;
  return base;
}

/**
 * 空白・コメントを skip (v2.0: ブロックコメント対応)
 */
function skipWhitespaceAndComments(source: string, start: number): number {
  let i = start;
  while (i < source.length) {
    const c = source[i];
    if (isWhitespaceChar(c)) { i++; continue; }
    // 行コメント ;
    if (c === ';') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    // ブロックコメント /* ... */
    if (c === '/' && source[i + 1] === '*') {
      const commentStart = i;
      i += 2;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') { i += 2; closed = true; break; }
        i++;
      }
      if (!closed) {
        throw new HideParseError('ブロックコメント /* が閉じられていません', offsetToPosition(source, commentStart), source);
      }
      continue;
    }
    break;
  }
  return i;
}

function looksLikeHeader(inner: string): boolean {
  const s = inner.trim();
  if (s.length === 0) return true;
  // コロン含みは CLEF/TIME/KEY/DIV のような既知ヘッダーキーのみ許可
  // (T:Allegro, C:Am7 等のメタコマンドを誤判定しないため)
  if (s.includes(':')) {
    const colonKey = s.split(':')[0].trim().toUpperCase();
    if (['CLEF', 'TIME', 'KEY', 'DIV'].includes(colonKey)) return true;
    // 既知キーでなければヘッダーではない
    return false;
  }
  let rest = s;
  for (let safety = 0; safety < 20 && rest.length > 0; safety++) {
    rest = rest.replace(/^\s+/, '');
    if (rest.length === 0) break;
    let m = rest.match(/^(\d+)\/(\d+)/);
    if (m) { rest = rest.slice(m[0].length); continue; }
    m = rest.match(/^K[+-]\d+/);
    if (m) { rest = rest.slice(m[0].length); continue; }
    m = rest.match(/^DIV\d+/i);
    if (m) { rest = rest.slice(m[0].length); continue; }
    m = rest.match(/^D\d+/);
    if (m) { rest = rest.slice(m[0].length); continue; }
    m = rest.match(/^K[A-G][#b]?m?/);
    if (m) { rest = rest.slice(m[0].length); continue; }
    // v2.0: So, Br 追加
    m = rest.match(/^(Treble|Bass|Alto|Tenor|Percussion|Soprano|Baritone|Te|Al|Pe|So|Br|T|B|A|N)/);
    if (m && (rest.length === m[0].length || /[^A-Za-z0-9]/.test(rest[m[0].length]) || /[\dKD]/.test(rest[m[0].length]))) {
      rest = rest.slice(m[0].length);
      continue;
    }
    return false;
  }
  return rest.length === 0;
}

function parseHeader(inner: string, pos: HideSourcePosition, source: string): HideHeader {
  const result: HideHeader = createDefaultHeader();
  const trimmed = inner.trim();
  if (trimmed.length === 0) return result;

  const parts = trimmed.split(/\s+/).filter(Boolean);
  const shortFormParts: string[] = [];
  for (const part of parts) {
    const colonIdx = part.indexOf(':');
    if (colonIdx < 0) { shortFormParts.push(part); continue; }
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
      const n = parseInt(value, 10);
      if (!Number.isNaN(n)) { result.keyFifths = n; }
      else { result.keyFifths = parseKeyLetter(value, pos, source); }
    } else if (key === 'DIV') {
      const n = parseInt(value, 10);
      if (Number.isNaN(n) || n <= 0) throw new HideParseError(`不正なDIV: DIV:${value}`, pos, source);
      result.div = n;
    }
  }

  for (const part of shortFormParts) {
    parseShortFormHeader(part, result, pos, source);
  }

  const unitsPerMeasure = (result.timeNum / result.timeDen) * result.div;
  if (!Number.isFinite(unitsPerMeasure) || unitsPerMeasure < 1 || Math.abs(unitsPerMeasure - Math.round(unitsPerMeasure)) > 1e-9) {
    throw new HideParseError(
      `DIV=${result.div} が拍子 ${result.timeNum}/${result.timeDen} と整合しません`,
      pos, source,
    );
  }

  return result;
}

function parseShortFormHeader(part: string, result: HideHeader, pos: HideSourcePosition, source: string): void {
  let i = 0;
  while (i < part.length) {
    const c = part[i];
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
    if (c === 'K') {
      const transposeM = part.slice(i).match(/^K([+-]\d+)/);
      if (transposeM) {
        result.transposeSemitones = parseInt(transposeM[1], 10);
        i += transposeM[0].length;
        continue;
      }
      const keyM = part.slice(i).match(/^K([A-G])([#b])?(m)?/);
      if (keyM) {
        result.keyFifths = letterToFifths(keyM[1], keyM[2], !!keyM[3]);
        i += keyM[0].length;
        continue;
      }
      throw new HideParseError(`不正なヘッダー要素: ${part.slice(i)}`, pos, source);
    }
    if (c === 'D') {
      const divM = part.slice(i).match(/^D(?:IV?)?(\d+)/i);
      if (divM) {
        const n = parseInt(divM[1], 10);
        if (n <= 0) throw new HideParseError(`不正なDIV: ${divM[0]}`, pos, source);
        result.div = n;
        i += divM[0].length;
        continue;
      }
      throw new HideParseError(`不正なヘッダー要素: ${part.slice(i)}`, pos, source);
    }
    // v2.0: So, Br 追加
    const clefM = part.slice(i).match(/^(Treble|Bass|Alto|Tenor|Percussion|Soprano|Baritone|Te|Al|Pe|So|Br|T|B|A|N)/);
    if (clefM) {
      result.clef = abbreviationToClef(clefM[1]);
      i += clefM[0].length;
      continue;
    }
    throw new HideParseError(`不正なヘッダー要素: ${part.slice(i)}`, pos, source);
  }
}

function parseClefName(name: string, pos: HideSourcePosition, source: string): HideClef {
  const upper = name.toUpperCase().replace(/[-\s]/g, '_');
  if (upper === 'TREBLE' || upper === 'BASS' || upper === 'TREBLE_8VA' || upper === 'TREBLE_8VB' ||
      upper === 'ALTO' || upper === 'TENOR' || upper === 'PERCUSSION' ||
      upper === 'SOPRANO' || upper === 'BARITONE') {
    return upper as HideClef;
  }
  throw new HideParseError(`未知の譜表記号: CLEF:${name}`, pos, source);
}

function abbreviationToClef(s: string): HideClef {
  const upper = s.toUpperCase();
  if (upper === 'TREBLE' || upper === 'T') return 'TREBLE';
  if (upper === 'BASS' || upper === 'B') return 'BASS';
  if (upper === 'T8') return 'TREBLE_8VA';
  if (upper === 'T-8') return 'TREBLE_8VB';
  if (upper === 'ALTO' || upper === 'AL' || upper === 'A') return 'ALTO';
  if (upper === 'TENOR' || upper === 'TE') return 'TENOR';
  if (upper === 'PERCUSSION' || upper === 'PE' || upper === 'N') return 'PERCUSSION';
  if (upper === 'SOPRANO' || upper === 'SO') return 'SOPRANO';
  if (upper === 'BARITONE' || upper === 'BR') return 'BARITONE';
  return 'TREBLE';
}

function tryParseBareClef(s: string): HideClef | null {
  const upper = s.trim().toUpperCase();
  if (upper === 'T') return 'TREBLE';
  if (upper === 'B') return 'BASS';
  if (upper === 'T8') return 'TREBLE_8VA';
  if (upper === 'T-8') return 'TREBLE_8VB';
  if (upper === 'A') return 'ALTO';
  if (upper === 'TE') return 'TENOR';
  if (upper === 'PE' || upper === 'N') return 'PERCUSSION';
  if (upper === 'SO') return 'SOPRANO';
  if (upper === 'BR') return 'BARITONE';
  return null;
}

function parseKeyLetter(value: string, pos: HideSourcePosition, source: string): number {
  const m = value.match(/^([A-Ga-g])([#b♭])?(m|min|maj|major|minor)?$/);
  if (!m) throw new HideParseError(`不正な調号: KEY:${value}`, pos, source);
  return letterToFifths(m[1].toUpperCase(), m[2], !!(m[3] && /^m(in)?$/.test(m[3])));
}

function letterToFifths(letter: string, acc: string | undefined, minor: boolean): number {
  const baseMajor: Record<string, number> = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, F: -1 };
  let f = baseMajor[letter] ?? 0;
  if (acc === '#') f += 7;
  else if (acc === 'b' || acc === '♭') f -= 7;
  if (minor) f -= 3;
  return f;
}

// ============================================================
// メタコマンドパーサ (v2.0: 大幅拡張)
// ============================================================

function parseMetaCommand(inner: string, pos: HideSourcePosition, source: string): HideMetaToken {
  if (!inner) throw new HideParseError('空のメタコマンド []', pos, source);

  // --- bare clef [T] [B] [T8] [T-8] [A] [Te] [Pe] [So] [Br] ---
  {
    const clefOnly = tryParseBareClef(inner);
    if (clefOnly !== null) {
      return { kind: 'meta', type: 'clefChange', clef: clefOnly };
    }
  }

  // --- partSwitch+clef: [1T] [2B] [3T8] [4T-8] [1:Piano] [2Pe:Drums] ---
  {
    const m = inner.match(/^(\d+)(.+)$/);
    if (m) {
      const labelPart = m[1];
      const rest = m[2];
      // Check for instrument name: [1:Piano]
      if (rest.startsWith(':')) {
        return {
          kind: 'meta', type: 'partSwitch',
          partLabel: labelPart,
          instrumentName: rest.slice(1),
        };
      }
      // v2.1: clef+name combo: [3B:Tenor] [2Pe:Drums]
      const colonIdx = rest.indexOf(':');
      if (colonIdx > 0) {
        const clefPart = rest.slice(0, colonIdx);
        const namePart = rest.slice(colonIdx + 1);
        const clef = tryParseBareClef(clefPart);
        if (clef !== null) {
          return {
            kind: 'meta', type: 'partSwitch',
            partLabel: labelPart, clef, instrumentName: namePart,
          };
        }
      }
      const clefOnly = tryParseBareClef(rest);
      if (clefOnly !== null) {
        return { kind: 'meta', type: 'partSwitch', partLabel: labelPart, clef: clefOnly };
      }
    }
  }

  // --- v2.0 navigation commands (v2.1: segno2/coda2 variants) ---
  const lowerInner = inner.toLowerCase();
  if (lowerInner === 'segno') return { kind: 'meta', type: 'segno' };
  if (lowerInner === 'segno2') return { kind: 'meta', type: 'segno', variant: true };
  if (lowerInner === 'coda') return { kind: 'meta', type: 'coda' };
  if (lowerInner === 'coda2') return { kind: 'meta', type: 'coda', variant: true };
  if (lowerInner === 'fine') return { kind: 'meta', type: 'fine' };
  if (lowerInner === 'tocoda') return { kind: 'meta', type: 'tocoda' };
  if (inner === 'DC') return { kind: 'meta', type: 'jump', jumpType: 'DC' };
  if (inner === 'DC.fine') return { kind: 'meta', type: 'jump', jumpType: 'DC.fine' };
  if (inner === 'DC.coda') return { kind: 'meta', type: 'jump', jumpType: 'DC.coda' };
  if (inner === 'DS') return { kind: 'meta', type: 'jump', jumpType: 'DS' };
  if (inner === 'DS.fine') return { kind: 'meta', type: 'jump', jumpType: 'DS.fine' };
  if (inner === 'DS.coda') return { kind: 'meta', type: 'jump', jumpType: 'DS.coda' };
  if (inner === '%') return { kind: 'meta', type: 'measureRepeat' };

  // --- v2.0 text/expression/rehearsal ---
  if (inner.startsWith('R:')) {
    return { kind: 'meta', type: 'rehearsal', rehearsalMark: inner.slice(2) };
  }
  if (inner.startsWith('text:')) {
    return { kind: 'meta', type: 'text', textContent: inner.slice(5) };
  }
  if (inner.startsWith('expr:')) {
    return { kind: 'meta', type: 'expression', textContent: inner.slice(5) };
  }

  // --- v2.0 breath/caesura, v2.1 swing/straight ---
  if (lowerInner === 'breath') return { kind: 'meta', type: 'breath' };
  if (lowerInner === 'caesura') return { kind: 'meta', type: 'caesura' };
  if (lowerInner === 'swing') return { kind: 'meta', type: 'swing' };
  if (lowerInner === 'straight') return { kind: 'meta', type: 'straight' };

  // --- v2.0 ottava ---
  {
    const ottavaM = inner.match(/^(8va|8vb|15ma|15mb)(\/)?$/);
    if (ottavaM) {
      return {
        kind: 'meta', type: 'ottava',
        ottavaType: ottavaM[1] as '8va' | '8vb' | '15ma' | '15mb',
        ottavaEnd: !!ottavaM[2],
      };
    }
  }

  // --- v2.0 pedal ---
  if (inner === 'ped') return { kind: 'meta', type: 'pedal', pedalEnd: false };
  if (inner === 'ped/') return { kind: 'meta', type: 'pedal', pedalEnd: true };

  // --- v2.0 chord symbol [C:Cmaj7] ---
  if (inner.startsWith('C:')) {
    return { kind: 'meta', type: 'chord', chordSymbol: inner.slice(2) };
  }

  // --- v2.1 fingering [F:1] [F:p] ---
  if (inner.startsWith('F:')) {
    return { kind: 'meta', type: 'fingering', fingerNumber: inner.slice(2) };
  }

  // --- v2.1 string number [S:1] ---
  if (inner.startsWith('S:')) {
    const n = parseInt(inner.slice(2), 10);
    if (Number.isFinite(n) && n > 0) {
      return { kind: 'meta', type: 'stringNumber', stringNum: n };
    }
    throw new HideParseError(`不正な弦番号: [${inner}]`, pos, source);
  }

  // --- v2.1 multi-measure rest [mmr:8] ---
  if (inner.startsWith('mmr:')) {
    const n = parseInt(inner.slice(4), 10);
    if (Number.isFinite(n) && n > 0) {
      return { kind: 'meta', type: 'multiRest', multiRestCount: n };
    }
    throw new HideParseError(`不正な多小節休符: [${inner}]`, pos, source);
  }

  const head = inner[0];

  // [T120] tempo or [T:Allegro] tempoText
  if (head === 'T') {
    if (inner[1] === ':') {
      return { kind: 'meta', type: 'tempoText', tempoText: inner.slice(2) };
    }
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
      return { kind: 'meta', type: 'time', timeNum: parseInt(m[1], 10), timeDen: parseInt(m[2], 10) };
    }
    throw new HideParseError(`不正な拍子変更: [${inner}]`, pos, source);
  }

  // [K+2] [KC] [KCm] [KBb] [KF#m]
  if (head === 'K') {
    const transposeM = inner.slice(1).match(/^([+-]\d+)$/);
    if (transposeM) {
      return { kind: 'meta', type: 'transpose', transposeSemitones: parseInt(transposeM[1], 10) };
    }
    const keyM = inner.slice(1).match(/^([A-Ga-g])([#b])?(m|min|maj)?$/);
    if (keyM) {
      const fifths = letterToFifths(keyM[1].toUpperCase(), keyM[2], !!(keyM[3] && /^m(in)?$/.test(keyM[3])));
      return { kind: 'meta', type: 'key', keyFifths: fifths };
    }
    const numM = inner.slice(1).match(/^(-?[0-7])$/);
    if (numM) return { kind: 'meta', type: 'key', keyFifths: parseInt(numM[1], 10) };
    throw new HideParseError(`不正な調指定: [${inner}]`, pos, source);
  }

  // [V1] [V2] — volta start
  if (head === 'V') {
    const numStr = inner.slice(1);
    if (/^\d+$/.test(numStr)) {
      return { kind: 'meta', type: 'volta', voltaNumber: parseInt(numStr, 10) };
    }
    throw new HideParseError(`不正な Volta 指定: [${inner}]`, pos, source);
  }

  // [/V1] [/V2] — volta end
  if (inner.startsWith('/V')) {
    const numStr = inner.slice(2);
    if (/^\d+$/.test(numStr)) {
      return { kind: 'meta', type: 'voltaEnd', voltaNumber: parseInt(numStr, 10) };
    }
    throw new HideParseError(`不正な Volta 終了指定: [${inner}]`, pos, source);
  }

  // [Dp] [Dff] [D<] [D>] [D/]
  if (head === 'D') {
    const dynValue = inner.slice(1);
    const validDynamics = [
      'pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff',
      'fp', 'fz', 'sf', 'sfz', 'sffz', 'sfp', 'sfpp', 'rfz', 'rf',
      '<', '>', '/',
    ];
    if (validDynamics.includes(dynValue)) {
      return { kind: 'meta', type: 'dynamics', dynamics: dynValue };
    }
    throw new HideParseError(`不正な強弱記号: [${inner}]`, pos, source);
  }

  // パート切替: [P] / [1] / [2] / [P:Drums]
  if (inner === 'P' || /^\d+$/.test(inner)) {
    return { kind: 'meta', type: 'partSwitch', partLabel: inner };
  }
  if (inner.startsWith('P:')) {
    return { kind: 'meta', type: 'partSwitch', partLabel: 'P', instrumentName: inner.slice(2) };
  }

  throw new HideParseError(`未知のメタコマンド: [${inner}]`, pos, source);
}

// ============================================================
// 音符パーサ (v2.0: 臨時記号 #/b/*/x/bb 2段スタック、サフィックス全面改訂)
// ============================================================

/**
 * v2.0 臨時記号パーサ: 1段階分の accidental を読む
 * 返り値: [alter delta, consumed characters]
 */
function tryParseAccidental(source: string, i: number): [number, number] {
  if (i >= source.length) return [0, 0];
  const c = source[i];
  if (c === '#') return [1, 1];
  if (c === '*') return [0, 1]; // natural resets — handled by caller
  if (c === 'x') return [2, 1];
  if (c === 'b') {
    if (source[i + 1] === 'b') return [-2, 2]; // bb = double flat
    return [-1, 1];
  }
  return [0, 0];
}

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

    // Stage 1: pitch accidental (before octave)
    let alter = 0;
    let isNatural = false;
    const [acc1, consumed1] = tryParseAccidental(source, i);
    if (consumed1 > 0) {
      if (source[i] === '*') {
        isNatural = true;
        alter = 0;
      } else {
        alter = acc1;
      }
      i += consumed1;
    }

    // octave digit
    if (i >= source.length || !/[0-9]/.test(source[i])) return null;
    const octave = parseInt(source[i], 10);
    i++;

    // Stage 2: modifier accidental (after octave)
    // b+digit は音名 B のオクターブ開始と判定 (例: C4b4k = C4+B4 和音)
    if (!isNatural) {
      const nextCh = source[i];
      const skipStage2 = nextCh === 'b' && i + 1 < source.length && /[0-9]/.test(source[i + 1]);
      if (!skipStage2) {
        const [acc2, consumed2] = tryParseAccidental(source, i);
        if (consumed2 > 0) {
          if (source[i] === '*') {
            alter = 0; // cancel
          } else {
            alter += acc2;
          }
          i += consumed2;
        }
      }
    }

    // Clamp alter to -2..+2
    alter = Math.max(-2, Math.min(2, alter)) as -2 | -1 | 0 | 1 | 2;

    pitches.push({ step, octave, alter: alter as HidePitch['alter'] });

    // v2.1: Notehead modifier !d !x !/ !t (between pitches and duration)
    let noteheadType: HideNoteheadType | undefined;
    if (source[i] === '!' && i + 1 < source.length) {
      const nhChar = source[i + 1];
      if (nhChar === 'd') { noteheadType = 'diamond'; i += 2; }
      else if (nhChar === 'x') { noteheadType = 'x'; i += 2; }
      else if (nhChar === '/') { noteheadType = 'slash'; i += 2; }
      else if (nhChar === 't') { noteheadType = 'triangle'; i += 2; }
    }

    // Check for duration letter
    // v2.0: 'g'/'G' is both a note name and a duration letter (64th note).
    // Disambiguate: if followed by a digit (octave) or accidental, it's a note name for a chord.
    const next = source[i];
    const isAmbiguousG = next && (next === 'g' || next === 'G');
    const nextAfter = source[i + 1];
    const gIsNoteName = isAmbiguousG && nextAfter && (/[0-9#bx*A-Ga-g]/.test(nextAfter));
    if (next && LENGTH_ALIAS_TO_UNITS[next.toLowerCase()] !== undefined && !gIsNoteName) {
      const baseUnits = getLengthUnits(next.toLowerCase(), div);
      i++;

      // Dots (up to 3)
      let dots = 0;
      while (source[i] === '.' && dots < 3) { dots++; i++; }
      const durationUnits = applyDots(baseUnits, dots);

      // v2.0 articulation/ornament suffixes (v2.1: expanded)
      let staccato = false, staccatissimo = false, accent = false;
      let tenuto = false, fermata = false, marcato = false;
      let fermataType: 'short' | 'long' | undefined;
      let upBow = false, downBow = false, harmonicNote = false;
      let snapPizz = false, stopped = false;
      let trill = false, mordent = false, invertedMordent = false;
      let turn = false, invertedTurn = false;
      let tremolo: 0 | 1 | 2 | 3 = 0;
      let arpeggio = false, glissando = false, slurEnd = false;
      let fall = false, doit = false, plop = false, scoop = false;
      let bend = false, vibrato = false;

      let scanning = true;
      while (scanning && i < source.length) {
        // 2-char ornaments/articulations first (order matters: ~s/~l before ~)
        const two = source.slice(i, i + 2);
        if (two === 'tr') { trill = true; i += 2; continue; }
        if (two === 'MR') { invertedMordent = true; i += 2; continue; }
        if (two === 'mr') { mordent = true; i += 2; continue; }
        if (two === 'TN') { invertedTurn = true; i += 2; continue; }
        if (two === 'tn') { turn = true; i += 2; continue; }
        if (two === 'z1') { tremolo = 1; i += 2; continue; }
        if (two === 'z2') { tremolo = 2; i += 2; continue; }
        if (two === 'z3') { tremolo = 3; i += 2; continue; }
        if (two === 'ar') { arpeggio = true; i += 2; continue; }
        if (two === 'gl') { glissando = true; i += 2; continue; }
        if (two === 'jf') { fall = true; i += 2; continue; }
        if (two === 'jd') { doit = true; i += 2; continue; }
        if (two === 'jp') { plop = true; i += 2; continue; }
        if (two === 'js') { scoop = true; i += 2; continue; }
        if (two === 'bn') { bend = true; i += 2; continue; }
        if (two === 'vb') { vibrato = true; i += 2; continue; }
        if (two === '~s') { fermata = true; fermataType = 'short'; i += 2; continue; }
        if (two === '~l') { fermata = true; fermataType = 'long'; i += 2; continue; }

        // 1-char articulations
        switch (source[i]) {
          case 's': staccato = true; i++; break;
          case 'S': staccatissimo = true; i++; break;
          case '>': accent = true; i++; break;
          case '^': marcato = true; i++; break;
          case '-': tenuto = true; i++; break;
          case '~': fermata = true; i++; break;
          case '_': slurEnd = true; i++; break;
          case 'V': upBow = true; i++; break;
          case 'W': downBow = true; i++; break;
          case 'O': harmonicNote = true; i++; break;
          case 'X': snapPizz = true; i++; break;
          case 'T': stopped = true; i++; break;
          default: scanning = false;
        }
      }

      return {
        token: {
          kind: 'note',
          pitches,
          durationUnits: Math.round(durationUnits),
          dots,
          notehead: noteheadType,
          staccato,
          staccatissimo,
          accent,
          tenuto,
          fermata,
          fermataType,
          marcato,
          upBow,
          downBow,
          harmonicNote,
          snapPizz,
          stopped,
          trill,
          mordent,
          invertedMordent,
          turn,
          invertedTurn,
          tremolo,
          arpeggio,
          glissando,
          fall,
          doit,
          plop,
          scoop,
          bend,
          vibrato,
          slurStart,
          slurEnd,
          tieToNext: false,
        },
        nextOffset: i,
      };
    }

    // Chord continuation
    if (next && /[A-Ga-g]/.test(next)) continue;

    return null;
  }

  return null;
}
