/**
 * hideToMusicXML.ts — HideAst / HidePartitionedAst を MusicXML 文字列に変換する (v2.0)
 *
 * v2.0 変更:
 *   - DIV=64 ベースの duration 計算 (g=1u=64th .. n=128u=breve)
 *   - Rule B 廃止: 臨時記号表示は調号コンテキストから自動判定
 *   - alter -2..+2 (ダブルシャープ/ダブルフラット) 対応
 *   - 新アーティキュレーション/オーナメント: staccatissimo, mordent, turn, tremolo, arpeggio, glissando
 *   - 新メタコマンド: tempoText, segno, coda, jump, fine, tocoda, rehearsal, text, expression,
 *     breath, caesura, ottava, pedal, chord, measureRepeat, clefChange, key (mid-piece)
 *   - 新小節線: dashed, invisible
 *   - 新音部記号: SOPRANO, BARITONE
 */

import type {
  HideAst,
  HideClef,
  HideNoteToken,
  HideRestToken,
  HideMetaToken,
  HideMeasureBarrierToken,
  HideBarlineStyle,
  HideCompileOptions,
  HidePitch,
  HideHeader,
  HidePart,
  HidePartitionedAst,
} from './hideTypes';
import { expand } from './hideExpander';

interface MeasureBucket {
  /**
   * 出力時に走査されるトークン列。note/rest と inline meta (tempo/time) を含む。
   * meta は emission 時に `<direction>` (tempo) として出力される。
   * time meta は bucket 境界化に使われた後、inline には残らない。
   */
  tokens: (HideNoteToken | HideRestToken | HideMetaToken)[];
  /** この bucket の note/rest が累積した unit (= getEmittedDuration の総和) */
  totalUnits: number;
  /** この bucket の小節長 (時間署名変更後は新しい値) */
  unitsPerMeasure: number;
  /**
   * この bucket で時間署名が変わった場合、新しい (timeNum, timeDen)。
   * 1 小節目は header の値を持って常に set される (出力で <attributes> 判定に使う)。
   */
  timeSignatureForAttributes?: { num: number; den: number };
  /** この bucket の右端バーラインスタイル (`.`/`..`/`...`/`:.`)。default は single (暗黙) */
  rightBarlineStyle?: HideBarlineStyle;
  /** この bucket の左端バーラインスタイル (`.:` のみ。前の bucket で `.:` を見たら次に立つ) */
  leftBarlineStyle?: HideBarlineStyle;
  /** Volta (N番括弧) — この小節の左端に置く */
  voltaNumber?: number;
  /** Volta 終了 — この小節の右端 barline に <ending type="discontinue"/> を出力 */
  voltaEndNumber?: number;
}

/**
 * HideAst から MusicXML を生成する高レベル API。
 * 内部で expand() を呼んで HidePartitionedAst に変換してから出力する。
 */
export function astToMusicXML(ast: HideAst, opts: HideCompileOptions): {
  musicXml: string;
  measuresCount: number;
  partsCount: number;
  warnings: string[];
} {
  const expandResult = expand(ast);
  const xmlResult = partitionedAstToMusicXML(expandResult.partitioned, opts);
  return {
    ...xmlResult,
    warnings: [...expandResult.warnings, ...xmlResult.warnings],
  };
}

/**
 * HidePartitionedAst (パート分離・反復展開済み) を MusicXML 文字列に変換する。
 */
export function partitionedAstToMusicXML(
  partitioned: HidePartitionedAst,
  opts: HideCompileOptions,
): {
  musicXml: string;
  measuresCount: number;
  partsCount: number;
  warnings: string[];
} {
  const header = partitioned.header;
  let newKeyFifths = computeNewKeyFifths(header.keyFifths, header.transposeSemitones);

  // 各パートのトークン列に移調を適用
  const transposedParts: HidePart[] = partitioned.parts.map(part => ({
    ...part,
    tokens: part.tokens.map(tok => {
      if (tok.kind === 'note' && header.transposeSemitones !== 0) {
        return transposeNoteToken(tok, header.transposeSemitones, newKeyFifths);
      }
      return tok;
    }),
  }));

  // 連符のスケール係数を計算 (連符メンバーの duration を整数化するため)
  // 例: 8(C4jD4jE4j) は 8u を 3 等分するので scale=3 が必要
  const tupletScale = computeTupletScaleFactor(transposedParts);
  const divisions = Math.max(1, Math.floor(header.div / 4) * tupletScale);
  if (header.timeDen === 0) throw new Error('Invalid time signature: denominator cannot be 0');
  const unitsPerMeasureRaw = Math.round((header.timeNum / header.timeDen) * header.div);
  const unitsPerMeasure = unitsPerMeasureRaw * tupletScale;

  // パートごとに小節バケットを作成 (スケール後の単位で計算)
  // 全パートで小節数を揃える必要があるため、最大値を計算
  const compileWarnings: string[] = [];
  const partMeasures = transposedParts.map(part =>
    bucketize(part.tokens, unitsPerMeasure, tupletScale, header, compileWarnings, part.label),
  );
  const maxMeasureCount = Math.max(1, ...partMeasures.map(m => m.length));
  // 短いパートには空小節を追加 (= 各パートの最後の bucket と同じ unitsPerMeasure を使う)
  for (const measures of partMeasures) {
    const lastUpm =
      measures.length > 0 ? measures[measures.length - 1].unitsPerMeasure : unitsPerMeasure;
    while (measures.length < maxMeasureCount) {
      measures.push({ tokens: [], totalUnits: 0, unitsPerMeasure: lastUpm });
    }
  }

  // 初期テンポ取得 (どのパートにあっても OK、最初に見つかったもの)
  let initialBpm: number | undefined;
  for (const part of transposedParts) {
    for (const tok of part.tokens) {
      if (tok.kind === 'meta' && tok.type === 'tempo' && tok.bpm !== undefined) {
        initialBpm = tok.bpm;
        break;
      }
    }
    if (initialBpm !== undefined) break;
  }

  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  out.push('<score-partwise version="3.1">');

  if (opts.title) {
    out.push(`  <work><work-title>${escapeXml(opts.title)}</work-title></work>`);
  }
  if (opts.composer || opts.lyricist) {
    out.push('  <identification>');
    if (opts.composer) {
      out.push(`    <creator type="composer">${escapeXml(opts.composer)}</creator>`);
    }
    if (opts.lyricist) {
      out.push(`    <creator type="lyricist">${escapeXml(opts.lyricist)}</creator>`);
    }
    out.push('  </identification>');
  }

  // パートリスト
  out.push('  <part-list>');
  for (const part of transposedParts) {
    out.push(`    <score-part id="${part.partId}">`);
    out.push(`      <part-name>${escapeXml(part.displayName)}</part-name>`);
    out.push(`      <score-instrument id="${part.partId}-I1"><instrument-name>${escapeXml(part.displayName)}</instrument-name></score-instrument>`);
    out.push(`      <midi-instrument id="${part.partId}-I1"><midi-channel>1</midi-channel><midi-program>${part.midiProgram}</midi-program></midi-instrument>`);
    out.push('    </score-part>');
  }
  out.push('  </part-list>');

  // 各パート本体
  for (let pi = 0; pi < transposedParts.length; pi++) {
    const part = transposedParts[pi];
    const measures = partMeasures[pi];
    out.push(`  <part id="${part.partId}">`);
    // 直前 bucket の time signature を track して mid-piece 変更を検出
    let prevTimeNum = header.timeNum;
    let prevTimeDen = header.timeDen;
    let initialTempoEmitted = false;
    for (let mi = 0; mi < measures.length; mi++) {
      const bucket = measures[mi];
      out.push(`    <measure number="${mi + 1}">`);

      // 左端バーライン (`.:` = repeatStart) + volta
      if (bucket.leftBarlineStyle || bucket.voltaNumber !== undefined) {
        emitBarlineWithVolta(out, bucket.leftBarlineStyle, 'left', bucket.voltaNumber);
      }

      if (mi === 0) {
        out.push('      <attributes>');
        out.push(`        <divisions>${divisions}</divisions>`);
        out.push('        <key>');
        out.push(`          <fifths>${newKeyFifths}</fifths>`);
        out.push('        </key>');
        out.push('        <time>');
        out.push(`          <beats>${header.timeNum}</beats>`);
        out.push(`          <beat-type>${header.timeDen}</beat-type>`);
        out.push('        </time>');
        emitClefXml(out, header.clef);
        out.push('      </attributes>');
        if (pi === 0 && initialBpm !== undefined) {
          emitTempoDirection(out, initialBpm);
          initialTempoEmitted = true;
        }
      } else if (
        bucket.timeSignatureForAttributes &&
        (bucket.timeSignatureForAttributes.num !== prevTimeNum ||
          bucket.timeSignatureForAttributes.den !== prevTimeDen)
      ) {
        // 中途 time signature 変更: <time> のみ含む小さな <attributes> を出力
        out.push('      <attributes>');
        out.push('        <time>');
        out.push(`          <beats>${bucket.timeSignatureForAttributes.num}</beats>`);
        out.push(`          <beat-type>${bucket.timeSignatureForAttributes.den}</beat-type>`);
        out.push('        </time>');
        out.push('      </attributes>');
      }
      if (bucket.timeSignatureForAttributes) {
        prevTimeNum = bucket.timeSignatureForAttributes.num;
        prevTimeDen = bucket.timeSignatureForAttributes.den;
      }

      if (bucket.tokens.length === 0) {
        emitWholeRest(out, { ...header, ...bucketTimeOverride(bucket, header) }, tupletScale);
      } else {
        const measureMemory = createMeasureMemory();
        let pendingBreath: 'breath-mark' | 'caesura' | null = null;
        for (const tok of bucket.tokens) {
          if (tok.kind === 'meta') {
            switch (tok.type) {
              case 'tempo':
                if (tok.bpm !== undefined) {
                  if (mi === 0 && pi === 0 && initialTempoEmitted && tok.bpm === initialBpm) {
                    initialTempoEmitted = false;
                    continue;
                  }
                  emitTempoDirection(out, tok.bpm);
                }
                break;
              case 'tempoText':
                if (tok.tempoText) emitTempoTextDirection(out, tok.tempoText);
                break;
              case 'dynamics':
                if (tok.dynamics) emitDynamicsDirection(out, tok.dynamics);
                break;
              case 'segno':
              case 'coda':
              case 'jump':
              case 'fine':
              case 'tocoda':
                emitNavigationDirection(out, tok);
                break;
              case 'rehearsal':
                if (tok.rehearsalMark) emitRehearsalDirection(out, tok.rehearsalMark);
                break;
              case 'text':
                if (tok.textContent) emitTextDirection(out, tok.textContent, false);
                break;
              case 'expression':
                if (tok.textContent) emitTextDirection(out, tok.textContent, true);
                break;
              case 'breath':
                pendingBreath = 'breath-mark';
                break;
              case 'caesura':
                pendingBreath = 'caesura';
                break;
              case 'ottava':
                emitOttavaDirection(out, tok);
                break;
              case 'pedal':
                emitPedalDirection(out, !!tok.pedalEnd);
                break;
              case 'chord':
                if (tok.chordSymbol) emitChordHarmony(out, tok.chordSymbol);
                break;
              case 'clefChange':
                if (tok.clef) {
                  out.push('      <attributes>');
                  emitClefXml(out, tok.clef);
                  out.push('      </attributes>');
                }
                break;
              case 'key':
                if (tok.keyFifths !== undefined) {
                  newKeyFifths = tok.keyFifths;
                  out.push('      <attributes>');
                  out.push('        <key>');
                  out.push(`          <fifths>${tok.keyFifths}</fifths>`);
                  out.push('        </key>');
                  out.push('      </attributes>');
                }
                break;
              case 'measureRepeat':
                // MusicXML measure-repeat is complex; emit as a measure-style attribute
                out.push('      <attributes>');
                out.push('        <measure-style>');
                out.push('          <measure-repeat type="start">1</measure-repeat>');
                out.push('        </measure-style>');
                out.push('      </attributes>');
                break;
              case 'fingering':
                if (tok.fingerNumber) emitTextDirection(out, tok.fingerNumber, false);
                break;
              case 'stringNumber':
                if (tok.stringNum !== undefined) emitTextDirection(out, String(tok.stringNum), false);
                break;
              case 'swing':
                emitTextDirection(out, 'Swing', false);
                break;
              case 'straight':
                emitTextDirection(out, 'Straight', false);
                break;
              case 'multiRest':
                if (tok.multiRestCount !== undefined) {
                  out.push('      <attributes>');
                  out.push('        <measure-style>');
                  out.push(`          <multiple-rest>${tok.multiRestCount}</multiple-rest>`);
                  out.push('        </measure-style>');
                  out.push('      </attributes>');
                }
                break;
            }
          } else if (tok.kind === 'rest') {
            emitRest(out, tok, tupletScale, header.div, pendingBreath);
            pendingBreath = null;
          } else if (tok.kind === 'note') {
            emitNote(out, tok, newKeyFifths, measureMemory, tupletScale, header.div, pendingBreath);
            pendingBreath = null;
          }
        }
        const remainder = bucket.unitsPerMeasure - bucket.totalUnits;
        if (remainder > 0) {
          emitFillRest(out, remainder, tupletScale, header.div);
        }
      }
      // 右端バーライン (`..`/`.../`:.`) + volta end
      if ((bucket.rightBarlineStyle && bucket.rightBarlineStyle !== 'single') || bucket.voltaEndNumber !== undefined) {
        emitBarlineWithVolta(out, bucket.rightBarlineStyle, 'right', undefined, bucket.voltaEndNumber);
      }
      out.push('    </measure>');
    }
    out.push('  </part>');
  }
  out.push('</score-partwise>');

  return {
    musicXml: out.join('\n'),
    measuresCount: maxMeasureCount,
    partsCount: transposedParts.length,
    warnings: compileWarnings,
  };
}

/** bucket の unitsPerMeasure に対応する timeNum/timeDen を擬似的に渡す (emitWholeRest 用) */
function bucketTimeOverride(
  bucket: MeasureBucket,
  header: HideHeader,
): { timeNum: number; timeDen: number } {
  if (bucket.timeSignatureForAttributes) {
    return {
      timeNum: bucket.timeSignatureForAttributes.num,
      timeDen: bucket.timeSignatureForAttributes.den,
    };
  }
  return { timeNum: header.timeNum, timeDen: header.timeDen };
}

function emitTempoDirection(out: string[], bpm: number): void {
  out.push('      <direction placement="above">');
  out.push('        <direction-type>');
  out.push(`          <metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome>`);
  out.push('        </direction-type>');
  out.push(`        <sound tempo="${bpm}"/>`);
  out.push('      </direction>');
}

function emitDynamicsDirection(out: string[], dynamics: string): void {
  if (dynamics === '<' || dynamics === '>' || dynamics === '/') {
    out.push('      <direction placement="below">');
    out.push('        <direction-type>');
    if (dynamics === '<') {
      out.push('          <wedge type="crescendo"/>');
    } else if (dynamics === '>') {
      out.push('          <wedge type="diminuendo"/>');
    } else {
      out.push('          <wedge type="stop"/>');
    }
    out.push('        </direction-type>');
    out.push('      </direction>');
  } else {
    out.push('      <direction placement="below">');
    out.push('        <direction-type>');
    out.push(`          <dynamics><${dynamics}/></dynamics>`);
    out.push('        </direction-type>');
    out.push('      </direction>');
  }
}

/** テンポテキスト direction ([T:Allegro] 等) */
function emitTempoTextDirection(out: string[], text: string): void {
  out.push('      <direction placement="above">');
  out.push('        <direction-type>');
  out.push(`          <words font-weight="bold">${escapeXml(text)}</words>`);
  out.push('        </direction-type>');
  out.push('      </direction>');
}

/** セーニョ/コーダ/ナビゲーション direction */
function emitNavigationDirection(out: string[], tok: HideMetaToken): void {
  out.push('      <direction placement="above">');
  out.push('        <direction-type>');
  switch (tok.type) {
    case 'segno':
      out.push('          <segno/>');
      break;
    case 'coda':
      out.push('          <coda/>');
      break;
    case 'fine':
      out.push('          <words font-weight="bold">Fine</words>');
      break;
    case 'tocoda':
      out.push('          <words font-weight="bold">To Coda</words>');
      break;
    case 'jump':
      {
        const jumpLabels: Record<string, string> = {
          DC: 'D.C.', 'DC.fine': 'D.C. al Fine', 'DC.coda': 'D.C. al Coda',
          DS: 'D.S.', 'DS.fine': 'D.S. al Fine', 'DS.coda': 'D.S. al Coda',
        };
        const label = tok.jumpType ? (jumpLabels[tok.jumpType] || tok.jumpType) : 'D.C.';
        out.push(`          <words font-weight="bold">${escapeXml(label)}</words>`);
      }
      break;
  }
  out.push('        </direction-type>');
  // MusicXML <sound> attributes for playback
  switch (tok.type) {
    case 'segno':
      out.push('        <sound segno="segno"/>');
      break;
    case 'coda':
      out.push('        <sound coda="coda"/>');
      break;
    case 'fine':
      out.push('        <sound fine="yes"/>');
      break;
    case 'tocoda':
      out.push('        <sound tocoda="coda"/>');
      break;
    case 'jump':
      if (tok.jumpType === 'DC') out.push('        <sound dacapo="yes"/>');
      else if (tok.jumpType === 'DS') out.push('        <sound dalsegno="segno"/>');
      else if (tok.jumpType === 'DC.fine') out.push('        <sound dacapo="yes"/>');
      else if (tok.jumpType === 'DC.coda') out.push('        <sound dacapo="yes"/>');
      else if (tok.jumpType === 'DS.fine') out.push('        <sound dalsegno="segno"/>');
      else if (tok.jumpType === 'DS.coda') out.push('        <sound dalsegno="segno"/>');
      break;
  }
  out.push('      </direction>');
}

/** リハーサルマーク direction */
function emitRehearsalDirection(out: string[], mark: string): void {
  out.push('      <direction placement="above">');
  out.push('        <direction-type>');
  out.push(`          <rehearsal>${escapeXml(mark)}</rehearsal>`);
  out.push('        </direction-type>');
  out.push('      </direction>');
}

/** テキスト/エクスプレッション direction */
function emitTextDirection(out: string[], text: string, isExpression: boolean): void {
  const placement = isExpression ? 'below' : 'above';
  const style = isExpression ? ' font-style="italic"' : '';
  out.push(`      <direction placement="${placement}">`);
  out.push('        <direction-type>');
  out.push(`          <words${style}>${escapeXml(text)}</words>`);
  out.push('        </direction-type>');
  out.push('      </direction>');
}

/** オッターヴァ direction */
function emitOttavaDirection(out: string[], tok: HideMetaToken): void {
  if (tok.ottavaEnd) {
    out.push('      <direction>');
    out.push('        <direction-type>');
    out.push('          <octave-shift type="stop"/>');
    out.push('        </direction-type>');
    out.push('      </direction>');
    return;
  }
  const sizeMap: Record<string, number> = { '8va': 8, '8vb': 8, '15ma': 15, '15mb': 15 };
  const dirMap: Record<string, string> = { '8va': 'up', '8vb': 'down', '15ma': 'up', '15mb': 'down' };
  const size = tok.ottavaType ? sizeMap[tok.ottavaType] || 8 : 8;
  const dir = tok.ottavaType ? dirMap[tok.ottavaType] || 'up' : 'up';
  out.push('      <direction>');
  out.push('        <direction-type>');
  out.push(`          <octave-shift type="${dir}" size="${size}"/>`);
  out.push('        </direction-type>');
  out.push('      </direction>');
}

/** ペダル direction */
function emitPedalDirection(out: string[], isEnd: boolean): void {
  out.push('      <direction placement="below">');
  out.push('        <direction-type>');
  out.push(`          <pedal type="${isEnd ? 'stop' : 'start'}"/>`);
  out.push('        </direction-type>');
  out.push('      </direction>');
}

/** コードシンボル harmony */
function emitChordHarmony(out: string[], symbol: string): void {
  // ルート音パース: step + optional accidental
  let idx = 0;
  const rootStep = symbol.charAt(idx);
  idx++;
  let rootAlter = 0;
  if (symbol.charAt(idx) === '#') { rootAlter = 1; idx++; }
  else if (symbol.charAt(idx) === 'b' && symbol.charAt(idx + 1) !== 'a') { rootAlter = -1; idx++; }

  // コード種別パース
  const rest = symbol.slice(idx);
  const kind = parseChordKind(rest);

  out.push('      <harmony>');
  out.push('        <root>');
  out.push(`          <root-step>${rootStep}</root-step>`);
  if (rootAlter !== 0) out.push(`          <root-alter>${rootAlter}</root-alter>`);
  out.push('        </root>');
  out.push(`        <kind text="${escapeXml(symbol)}">${kind}</kind>`);
  out.push('      </harmony>');
}

/** コードシンボルの残り部分から MusicXML kind を推定 */
function parseChordKind(rest: string): string {
  // slash bass を除去して kind 部分だけ取る
  const slashIdx = rest.indexOf('/');
  const q = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
  const ql = q.toLowerCase();
  // 順序重要: 長い文字列を先にマッチ
  if (ql.startsWith('maj7') || ql.startsWith('ma7') || ql.startsWith('δ') || ql.startsWith('Δ')) return 'major-seventh';
  if (ql.startsWith('maj9')) return 'major-ninth';
  if (ql.startsWith('maj')) return 'major';
  if (ql.startsWith('m7b5') || ql.startsWith('m7(b5)') || ql.startsWith('ø')) return 'half-diminished';
  if (ql.startsWith('min7') || ql.startsWith('m7')) return 'minor-seventh';
  if (ql.startsWith('min9') || ql.startsWith('m9')) return 'minor-ninth';
  if (ql.startsWith('min') || ql.startsWith('m')) return 'minor';
  if (ql.startsWith('dim7') || ql.startsWith('°7')) return 'diminished-seventh';
  if (ql.startsWith('dim') || ql.startsWith('°')) return 'diminished';
  if (ql.startsWith('aug7') || ql.startsWith('+7')) return 'augmented-seventh';
  if (ql.startsWith('aug') || ql.startsWith('+')) return 'augmented';
  if (ql.startsWith('sus4')) return 'suspended-fourth';
  if (ql.startsWith('sus2')) return 'suspended-second';
  if (ql.startsWith('sus')) return 'suspended-fourth';
  if (ql.startsWith('9')) return 'dominant-ninth';
  if (ql.startsWith('13')) return 'dominant-13th';
  if (ql.startsWith('11')) return 'dominant-11th';
  if (ql.startsWith('7')) return 'dominant';
  if (ql.startsWith('6')) return 'major-sixth';
  if (ql === '' || ql.startsWith('5')) return 'major';
  return 'major';
}

/**
 * 小節バーラインを MusicXML `<barline>` 要素として出力する。
 *
 *  - single (通常小節線): MusicXML 暗黙 (= 関数を呼ばない、上位で除外)
 *  - double : `<bar-style>light-light</bar-style>`
 *  - final  : `<bar-style>light-heavy</bar-style>`
 *  - repeatStart: `<bar-style>heavy-light</bar-style><repeat direction="forward"/>` (location=left)
 *  - repeatEnd  : `<bar-style>light-heavy</bar-style><repeat direction="backward"/>` (location=right)
 */
function emitBarline(out: string[], style: HideBarlineStyle, location: 'left' | 'right'): void {
  out.push(`      <barline location="${location}">`);
  switch (style) {
    case 'single':
      out.push('        <bar-style>regular</bar-style>');
      break;
    case 'double':
      out.push('        <bar-style>light-light</bar-style>');
      break;
    case 'final':
      out.push('        <bar-style>light-heavy</bar-style>');
      break;
    case 'repeatStart':
      out.push('        <bar-style>heavy-light</bar-style>');
      out.push('        <repeat direction="forward"/>');
      break;
    case 'repeatEnd':
      out.push('        <bar-style>light-heavy</bar-style>');
      out.push('        <repeat direction="backward"/>');
      break;
    case 'dashed':
      out.push('        <bar-style>dashed</bar-style>');
      break;
    case 'invisible':
      out.push('        <bar-style>none</bar-style>');
      break;
  }
  out.push('      </barline>');
}

function emitBarlineWithVolta(
  out: string[],
  style: HideBarlineStyle | undefined,
  location: 'left' | 'right',
  voltaNumber?: number,
  voltaEndNumber?: number,
): void {
  out.push(`      <barline location="${location}">`);
  // DTD 順序: bar-style → ending → repeat
  let repeatXml: string | undefined;
  if (style) {
    switch (style) {
      case 'single':
        out.push('        <bar-style>regular</bar-style>');
        break;
      case 'double':
        out.push('        <bar-style>light-light</bar-style>');
        break;
      case 'final':
        out.push('        <bar-style>light-heavy</bar-style>');
        break;
      case 'repeatStart':
        out.push('        <bar-style>heavy-light</bar-style>');
        repeatXml = '        <repeat direction="forward"/>';
        break;
      case 'repeatEnd':
        out.push('        <bar-style>light-heavy</bar-style>');
        repeatXml = '        <repeat direction="backward"/>';
        break;
      case 'dashed':
        out.push('        <bar-style>dashed</bar-style>');
        break;
      case 'invisible':
        out.push('        <bar-style>none</bar-style>');
        break;
    }
  }
  // ending must come before repeat (MusicXML DTD)
  if (voltaNumber !== undefined) {
    out.push(`        <ending number="${voltaNumber}" type="start"/>`);
  }
  if (voltaEndNumber !== undefined) {
    out.push(`        <ending number="${voltaEndNumber}" type="discontinue"/>`);
  }
  if (repeatXml) out.push(repeatXml);
  out.push('      </barline>');
}

/**
 * トークン列を小節バケットに振り分ける。
 *
 * 動的変更:
 *  - tempo meta (`[T120]`) は inline で bucket に入り、emission 時に `<direction>` 出力される
 *  - time meta (`[M3/4]`) は bucket 境界として扱う:
 *      1. 現在の bucket が空でなければ close (totalUnits < unitsPerMeasure なら fill rest)
 *      2. 新しい unitsPerMeasure を計算
 *      3. 新しい bucket に timeSignatureForAttributes をセットして属性再出力をトリガ
 *  - その他の meta (key/transpose/partSwitch) は note/rest として bucket には載せない
 *
 * 小節終止マーカー (`.`/`..`/`.../`.:/`:.`):
 *  - 現在の bucket を強制 close (style を rightBarlineStyle に記録)
 *  - totalUnits != unitsPerMeasure なら "小節長不一致" を warning にする
 *  - `.:` (repeatStart) は次の bucket の leftBarlineStyle に立てる
 *
 * @param tokens part 単位のトークン列 (expand 後)
 * @param initialUnitsPerMeasure ヘッダー由来の小節長 (tupletScale 適用済み)
 * @param tupletScale 連符スケール係数
 * @param header ヘッダー (div 等を取得)
 * @param warnings 警告書き込み先
 * @param partLabel エラーメッセージ用パートラベル
 */
function bucketize(
  tokens: (HideNoteToken | HideRestToken | HideMetaToken | HideMeasureBarrierToken)[],
  initialUnitsPerMeasure: number,
  tupletScale: number,
  header: HideHeader,
  warnings: string[],
  partLabel: string,
): MeasureBucket[] {
  const measures: MeasureBucket[] = [];
  // 1 小節目は常に header の (timeNum/timeDen) を attributes に持つ
  let currentUnitsPerMeasure = initialUnitsPerMeasure;
  let currentTimeNum = header.timeNum;
  let currentTimeDen = header.timeDen;
  // 次の bucket に立てる leftBarlineStyle (`.:` を見た直後だけ true になる)
  let pendingLeftBarline: HideBarlineStyle | undefined;
  measures.push({
    tokens: [],
    totalUnits: 0,
    unitsPerMeasure: currentUnitsPerMeasure,
    timeSignatureForAttributes: { num: currentTimeNum, den: currentTimeDen },
  });

  const startNewBucket = (timeChanged: boolean): MeasureBucket => {
    const b: MeasureBucket = {
      tokens: [],
      totalUnits: 0,
      unitsPerMeasure: currentUnitsPerMeasure,
      timeSignatureForAttributes: timeChanged
        ? { num: currentTimeNum, den: currentTimeDen }
        : undefined,
      leftBarlineStyle: pendingLeftBarline,
    };
    pendingLeftBarline = undefined;
    measures.push(b);
    return b;
  };

  for (const tok of tokens) {
    if (tok.kind === 'measureBarrier') {
      // hard barrier: 直前の note が確定した bucket を対象に style を立てる
      const currentBucket = measures[measures.length - 1];
      const isEmptyCurrent =
        currentBucket.tokens.length === 0 &&
        currentBucket.totalUnits === 0;

      if (tok.style === 'repeatStart') {
        // `.:` = 次の bucket の左端マーカー
        if (isEmptyCurrent) {
          // 現在の bucket がまだ空 → そのまま左端マーカーを立てる
          currentBucket.leftBarlineStyle = 'repeatStart';
        } else {
          // 現在の bucket に何かある → 閉じて新しい bucket の左端に立てる
          pendingLeftBarline = 'repeatStart';
          startNewBucket(false);
        }
        continue;
      }

      // single / double / final / repeatEnd
      // 直前の note がぴったり 1 小節分埋めて auto-startNewBucket した直後は、
      // 1 つ前の bucket がこの barrier の対象
      const targetBucket =
        isEmptyCurrent && measures.length >= 2
          ? measures[measures.length - 2]
          : currentBucket;

      // 小節長の検証 (`.` を打った時点で 1 小節分 ぴったりかチェック)
      if (
        targetBucket.totalUnits !== targetBucket.unitsPerMeasure &&
        targetBucket.tokens.some(t => t.kind === 'note' || t.kind === 'rest')
      ) {
        const diff = targetBucket.unitsPerMeasure - targetBucket.totalUnits;
        if (diff > 0) {
          warnings.push(
            `パート ${partLabel}: 小節終止マーカーの直前で ${diff}u 足りません (拍子 ${currentTimeNum}/${currentTimeDen} = ${targetBucket.unitsPerMeasure}u 必要、累積 ${targetBucket.totalUnits}u)。残りを休符で埋めます。`,
          );
        } else {
          warnings.push(
            `パート ${partLabel}: 小節終止マーカーの直前で ${-diff}u 超過しています (拍子 ${currentTimeNum}/${currentTimeDen} = ${targetBucket.unitsPerMeasure}u、累積 ${targetBucket.totalUnits}u)。`,
          );
        }
      }
      targetBucket.rightBarlineStyle = tok.style;

      // 現 bucket が既に空 (auto-startNewBucket 直後) ならそのまま再利用、
      // そうでなければ新しい bucket を開く
      if (!isEmptyCurrent) {
        startNewBucket(false);
      }
      continue;
    }
    if (tok.kind === 'meta') {
      // v2.0: 大半のメタコマンドは bucket に inline で挿入 → emission 時に direction 等として出力
      const inlineMetaTypes = [
        'tempo', 'tempoText', 'dynamics',
        'segno', 'coda', 'jump', 'fine', 'tocoda',
        'rehearsal', 'text', 'expression',
        'breath', 'caesura', 'ottava', 'pedal', 'chord', 'measureRepeat',
      ];
      if (inlineMetaTypes.includes(tok.type)) {
        let bucket = measures[measures.length - 1];
        bucket.tokens.push(tok);
        continue;
      }
      if (tok.type === 'volta' && tok.voltaNumber !== undefined) {
        let bucket = measures[measures.length - 1];
        bucket.voltaNumber = tok.voltaNumber;
        continue;
      }
      if (tok.type === 'voltaEnd' && tok.voltaNumber !== undefined) {
        let bucket = measures[measures.length - 1];
        bucket.voltaEndNumber = tok.voltaNumber;
        continue;
      }
      if (tok.type === 'clefChange' && tok.clef) {
        // 音部記号変更は bucket に inline で挿入 (emission 時に <attributes><clef> として出力)
        let bucket = measures[measures.length - 1];
        bucket.tokens.push(tok);
        continue;
      }
      if (tok.type === 'key' && tok.keyFifths !== undefined) {
        // 調号変更は bucket に inline で挿入 (emission 時に <attributes><key> として出力)
        let bucket = measures[measures.length - 1];
        bucket.tokens.push(tok);
        continue;
      }
      if (tok.type === 'time' && tok.timeNum !== undefined && tok.timeDen !== undefined) {
        // 現在の bucket を閉じる (空でなければ fill rest 余地を残す)
        let bucket = measures[measures.length - 1];
        if (bucket.tokens.some(t => t.kind === 'note' || t.kind === 'rest')) {
          if (bucket.totalUnits < bucket.unitsPerMeasure) {
            warnings.push(
              `パート ${partLabel}: 小節途中で時間署名が ${tok.timeNum}/${tok.timeDen} に変更されたため、前の小節 (${currentTimeNum}/${currentTimeDen}) を残り休符で埋めました`,
            );
          }
          // 新しい unitsPerMeasure に更新してから新 bucket を作る
          currentTimeNum = tok.timeNum;
          currentTimeDen = tok.timeDen;
          currentUnitsPerMeasure =
            Math.round((currentTimeNum / currentTimeDen) * header.div) * tupletScale;
          startNewBucket(true);
        } else {
          // 空 bucket: その場で更新 (初回 [M] の上書きにも対応)
          currentTimeNum = tok.timeNum;
          currentTimeDen = tok.timeDen;
          currentUnitsPerMeasure =
            Math.round((currentTimeNum / currentTimeDen) * header.div) * tupletScale;
          bucket.unitsPerMeasure = currentUnitsPerMeasure;
          bucket.timeSignatureForAttributes = { num: currentTimeNum, den: currentTimeDen };
        }
        continue;
      }
      // それ以外の meta (key/transpose/partSwitch) は無視
      continue;
    }
    // note / rest
    // 装飾音 (grace) は演奏時間 0 — bucket 計算に参加しない
    if (tok.kind === 'note' && tok.graceType) {
      let bucket = measures[measures.length - 1];
      bucket.tokens.push(tok);
      continue;
    }
    const dur = getEmittedDuration(tok, tupletScale);
    let bucket = measures[measures.length - 1];
    const remaining = bucket.unitsPerMeasure - bucket.totalUnits;

    if (dur > remaining && remaining > 0 && dur > bucket.unitsPerMeasure) {
      // 小節を跨ぐ長い音符/休符 → 自動タイ分割
      warnings.push(
        `パート ${partLabel}: 音価 ${dur}u が小節残り ${remaining}u を超過 (拍子 ${currentTimeNum}/${currentTimeDen} = ${bucket.unitsPerMeasure}u)。自動タイ分割します。`,
      );
      let leftover = dur;
      let isFirst = true;
      while (leftover > 0) {
        bucket = measures[measures.length - 1];
        const space = bucket.unitsPerMeasure - bucket.totalUnits;
        const chunk = Math.min(leftover, space);
        const isLast = leftover - chunk <= 0;
        if (tok.kind === 'note') {
          const part: HideNoteToken = {
            ...tok,
            durationUnits: Math.round(chunk / tupletScale),
            dots: 0,
            tieToNext: isLast ? tok.tieToNext : true,
            tieFromPrev: !isFirst,
          };
          bucket.tokens.push(part);
        } else {
          const part: HideRestToken = {
            ...tok,
            durationUnits: Math.round(chunk / tupletScale),
            dots: 0,
          };
          bucket.tokens.push(part);
        }
        bucket.totalUnits += chunk;
        leftover -= chunk;
        isFirst = false;
        if (bucket.totalUnits >= bucket.unitsPerMeasure && leftover > 0) {
          startNewBucket(false);
        }
      }
      if (bucket.totalUnits >= bucket.unitsPerMeasure) {
        startNewBucket(false);
      }
    } else {
      // 通常パス: 小節内に収まる
      if (bucket.totalUnits + dur > bucket.unitsPerMeasure) {
        if (bucket.totalUnits > 0) {
          bucket = startNewBucket(false);
        }
      }
      bucket.tokens.push(tok);
      bucket.totalUnits += dur;
      if (bucket.totalUnits >= bucket.unitsPerMeasure) {
        startNewBucket(false);
      }
    }
  }
  // 末尾の空 bucket を削る (1個だけは残す)
  // ただし leftBarlineStyle/rightBarlineStyle のついた bucket は残す
  while (
    measures.length > 1 &&
    measures[measures.length - 1].tokens.length === 0 &&
    measures[measures.length - 1].leftBarlineStyle === undefined &&
    measures[measures.length - 1].rightBarlineStyle === undefined
  ) {
    measures.pop();
  }
  return measures;
}

// ============================================================
// 連符スケール係数の計算
// ============================================================

/**
 * 連符メンバーの duration が整数になるよう、必要なスケール係数を計算する。
 * 例: 8(C4jD4jE4j) は 8u を 3 等分するので scale=3 が必要 (8*3/3=8)
 *     6(C4jD4jE4jF4j) は 6u を 4 等分するので scale=2 が必要 (6*2/4=3)
 */
function computeTupletScaleFactor(parts: HidePart[]): number {
  let scale = 1;
  for (const part of parts) {
    for (const tok of part.tokens) {
      if ((tok.kind === 'note' || tok.kind === 'rest') && tok.tupletMember) {
        const { targetUnits, totalMembers } = tok.tupletMember;
        const product = targetUnits * scale;
        if (product % totalMembers !== 0) {
          // scale をどこまで増やせば (targetUnits * scale) が totalMembers で割り切れるか
          const g = gcd(product, totalMembers);
          scale = scale * (totalMembers / g);
        }
      }
    }
  }
  return scale;
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a || 1;
}

/** トークンの emitted duration (スケール後の MusicXML <duration> 値) を返す */
function getEmittedDuration(
  tok: HideNoteToken | HideRestToken,
  tupletScale: number,
): number {
  if (tok.tupletMember) {
    return Math.round(
      (tok.tupletMember.targetUnits * tupletScale) / tok.tupletMember.totalMembers,
    );
  }
  return tok.durationUnits * tupletScale;
}

// ============================================================
// 個別ノート出力
// ============================================================

function emitNote(
  out: string[],
  tok: HideNoteToken,
  keyFifths: number,
  measureMemory: Map<string, number>,
  tupletScale: number,
  div: number,
  pendingBreath: 'breath-mark' | 'caesura' | null = null,
): void {
  const emittedDur = getEmittedDuration(tok, tupletScale);
  const baseUnits = tok.dots === 3 ? tok.durationUnits / 1.875
    : tok.dots === 2 ? tok.durationUnits / 1.75
    : tok.dots === 1 ? tok.durationUnits / 1.5
    : tok.durationUnits;
  const noteType = unitsToNoteType(Math.round(baseUnits), div);

  let timeModXml: string | null = null;
  let tupletStartStop = { start: false, stop: false };
  if (tok.tupletMember) {
    const { totalMembers, memberIndex, normalNotes } = tok.tupletMember;
    timeModXml =
      `        <time-modification>\n` +
      `          <actual-notes>${totalMembers}</actual-notes>\n` +
      `          <normal-notes>${normalNotes}</normal-notes>\n` +
      `        </time-modification>`;
    tupletStartStop = {
      start: memberIndex === 0,
      stop: memberIndex === totalMembers - 1,
    };
  }

  for (let i = 0; i < tok.pitches.length; i++) {
    const p = tok.pitches[i];
    const accDisplay = determineAccidentalDisplay(p, keyFifths, measureMemory);

    out.push('      <note>');
    if (tok.graceType) {
      out.push(tok.graceType === 'acciaccatura'
        ? '        <grace slash="yes"/>'
        : '        <grace/>');
    }
    if (i > 0) out.push('        <chord/>');
    out.push('        <pitch>');
    out.push(`          <step>${p.step}</step>`);
    if (p.alter !== 0 || naturalAlterByKey(p.step, keyFifths) !== 0) {
      out.push(`          <alter>${p.alter}</alter>`);
    }
    out.push(`          <octave>${p.octave}</octave>`);
    out.push('        </pitch>');
    if (!tok.graceType) {
      out.push(`        <duration>${emittedDur}</duration>`);
    }
    // DTD 順序: <tie> は <duration> の直後、<voice> の前
    if (tok.tieFromPrev) out.push('        <tie type="stop"/>');
    if (tok.tieToNext) out.push('        <tie type="start"/>');
    out.push('        <voice>1</voice>');
    out.push(`        <type>${noteType}</type>`);
    for (let d = 0; d < tok.dots; d++) out.push('        <dot/>');
    // v2.1: notehead type (diamond/x/slash/triangle)
    if (tok.notehead) {
      const nhMap: Record<string, string> = {
        diamond: 'diamond', x: 'x', slash: 'slash', triangle: 'triangle',
      };
      out.push(`        <notehead>${nhMap[tok.notehead]}</notehead>`);
    }
    // DTD 順序: dot → notehead → accidental → time-modification
    if (accDisplay.showAccidental) {
      const accName = alterToAccidentalName(p.alter);
      if (accName) out.push(`        <accidental>${accName}</accidental>`);
    }
    if (timeModXml) out.push(timeModXml);

    // v2.1: expanded articulations + ornaments + technical
    const isFirstChordNote = i === 0;
    const hasArticulations = tok.staccato || tok.staccatissimo || tok.accent ||
      tok.tenuto || tok.marcato ||
      tok.fall || tok.doit || tok.plop || tok.scoop ||
      (isFirstChordNote && pendingBreath !== null);
    const hasOrnaments = tok.trill || tok.mordent || tok.invertedMordent ||
      tok.turn || tok.invertedTurn || tok.tremolo > 0 || tok.vibrato;
    const hasTechnical = tok.arpeggio || tok.glissando ||
      tok.upBow || tok.downBow || tok.harmonicNote || tok.snapPizz ||
      tok.stopped || tok.bend;
    // tie の <notations>/<tied> は全 chord note に必要、それ以外は first note のみ
    const wantNotations = tok.tieToNext || tok.tieFromPrev || (isFirstChordNote && (
      hasArticulations || hasOrnaments || hasTechnical || tok.fermata ||
      tok.slurStart || tok.slurEnd ||
      tupletStartStop.start || tupletStartStop.stop
    ));
    if (wantNotations) {
      out.push('        <notations>');
      if (tok.tieFromPrev) out.push('          <tied type="stop"/>');
      if (tok.tieToNext) out.push('          <tied type="start"/>');
      if (isFirstChordNote && tok.slurStart) out.push('          <slur type="start" number="1"/>');
      if (isFirstChordNote && tok.slurEnd) out.push('          <slur type="stop" number="1"/>');
      if (tupletStartStop.start) out.push('          <tuplet type="start" number="1"/>');
      if (tupletStartStop.stop) out.push('          <tuplet type="stop" number="1"/>');
      if (isFirstChordNote && tok.fermata) {
        const shape = tok.fermataType === 'short' ? ' shape="angled"'
          : tok.fermataType === 'long' ? ' shape="square"' : '';
        out.push(`          <fermata type="upright"${shape}/>`);
      }
      if (isFirstChordNote && hasArticulations) {
        out.push('          <articulations>');
        if (tok.staccato) out.push('            <staccato/>');
        if (tok.staccatissimo) out.push('            <staccatissimo/>');
        if (tok.accent) out.push('            <accent/>');
        if (tok.tenuto) out.push('            <tenuto/>');
        if (tok.marcato) out.push('            <strong-accent type="up"/>');
        if (tok.fall) out.push('            <falloff/>');
        if (tok.doit) out.push('            <doit/>');
        if (tok.plop) out.push('            <plop/>');
        if (tok.scoop) out.push('            <scoop/>');
        if (pendingBreath === 'breath-mark') out.push('            <breath-mark/>');
        if (pendingBreath === 'caesura') out.push('            <caesura/>');
        out.push('          </articulations>');
      }
      if (isFirstChordNote && hasOrnaments) {
        out.push('          <ornaments>');
        if (tok.trill) out.push('            <trill-mark/>');
        if (tok.mordent) out.push('            <mordent/>');
        if (tok.invertedMordent) out.push('            <inverted-mordent/>');
        if (tok.turn) out.push('            <turn/>');
        if (tok.invertedTurn) out.push('            <inverted-turn/>');
        if (tok.tremolo > 0) out.push(`            <tremolo type="single">${tok.tremolo}</tremolo>`);
        if (tok.vibrato) out.push('            <wavy-line type="start"/>');
        out.push('          </ornaments>');
      }
      if (isFirstChordNote && hasTechnical) {
        out.push('          <technical>');
        if (tok.upBow) out.push('            <up-bow/>');
        if (tok.downBow) out.push('            <down-bow/>');
        if (tok.harmonicNote) out.push('            <harmonic><natural/></harmonic>');
        if (tok.snapPizz) out.push('            <snap-pizzicato/>');
        if (tok.stopped) out.push('            <stopped/>');
        if (tok.bend) out.push('            <bend><bend-alter>1</bend-alter></bend>');
        out.push('          </technical>');
      }
      if (isFirstChordNote && tok.arpeggio) out.push('          <arpeggiate/>');
      if (isFirstChordNote && tok.glissando) out.push('          <glissando line-type="wavy" type="start">gliss.</glissando>');
      out.push('        </notations>');
    }

    if (isFirstChordNote && tok.lyric) {
      out.push('        <lyric number="1">');
      out.push('          <syllabic>single</syllabic>');
      out.push(`          <text>${escapeXml(tok.lyric)}</text>`);
      out.push('        </lyric>');
    }
    out.push('      </note>');
  }
}

function alterToAccidentalName(alter: number): string | null {
  switch (alter) {
    case 2: return 'double-sharp';
    case 1: return 'sharp';
    case 0: return 'natural';
    case -1: return 'flat';
    case -2: return 'flat-flat';
    default: return null;
  }
}

function emitRest(out: string[], tok: HideRestToken, tupletScale: number, div: number, pendingBreath: 'breath-mark' | 'caesura' | null = null): void {
  const emittedDur = getEmittedDuration(tok, tupletScale);
  const baseUnits = tok.dots === 3 ? tok.durationUnits / 1.875
    : tok.dots === 2 ? tok.durationUnits / 1.75
    : tok.dots === 1 ? tok.durationUnits / 1.5
    : tok.durationUnits;
  out.push('      <note>');
  out.push('        <rest/>');
  out.push(`        <duration>${emittedDur}</duration>`);
  out.push('        <voice>1</voice>');
  out.push(`        <type>${unitsToNoteType(Math.round(baseUnits), div)}</type>`);
  for (let d = 0; d < tok.dots; d++) out.push('        <dot/>');
  // 休符の連符 time-modification (連符内に休符がある場合)
  const hasTupletNotations = tok.tupletMember && (tok.tupletMember.memberIndex === 0 || tok.tupletMember.memberIndex === tok.tupletMember.totalMembers - 1);
  if (tok.tupletMember) {
    const { totalMembers, normalNotes } = tok.tupletMember;
    out.push('        <time-modification>');
    out.push(`          <actual-notes>${totalMembers}</actual-notes>`);
    out.push(`          <normal-notes>${normalNotes}</normal-notes>`);
    out.push('        </time-modification>');
  }
  if (hasTupletNotations || pendingBreath) {
    out.push('        <notations>');
    if (tok.tupletMember && tok.tupletMember.memberIndex === 0) out.push('          <tuplet type="start" number="1"/>');
    if (tok.tupletMember && tok.tupletMember.memberIndex === tok.tupletMember.totalMembers - 1) out.push('          <tuplet type="stop" number="1"/>');
    if (pendingBreath) {
      out.push('          <articulations>');
      out.push(`            <${pendingBreath}/>`);
      out.push('          </articulations>');
    }
    out.push('        </notations>');
  }
  out.push('      </note>');
}

/** 端数を埋める単純休符。emittedUnits はスケール後単位。<type> は div=64 正規化で計算 */
function emitFillRest(out: string[], emittedUnits: number, tupletScale: number, div: number): void {
  const rawUnits = emittedUnits / tupletScale;
  // div=64 に正規化して標準音価を判定する
  const normalized = Math.round(rawUnits * 64 / div);
  const match = matchStandardDuration(normalized);
  if (match) {
    emitSingleFillRest(out, emittedUnits, match.baseUnit, match.dots);
  } else {
    // 非標準値: div=64 空間で2冪の合計に分割して複数休符で出力 (大きい方から貪欲)
    let remaining = normalized;
    const powerOf2Desc = [128, 64, 32, 16, 8, 4, 2, 1];
    for (const pw of powerOf2Desc) {
      while (remaining >= pw) {
        // <duration> は実スケールに戻す
        emitSingleFillRest(out, Math.round(pw * div / 64 * tupletScale), pw, 0);
        remaining -= pw;
      }
    }
  }
}

function matchStandardDuration(rawUnits: number): { baseUnit: number; dots: number } | null {
  const powerOf2s = [1, 2, 4, 8, 16, 32, 64, 128];
  for (const pw of powerOf2s) {
    if (Math.round(pw * 1.875) === rawUnits) return { baseUnit: pw, dots: 3 };
    if (Math.round(pw * 1.75) === rawUnits) return { baseUnit: pw, dots: 2 };
    if (Math.round(pw * 1.5) === rawUnits) return { baseUnit: pw, dots: 1 };
    if (pw === rawUnits) return { baseUnit: pw, dots: 0 };
  }
  return null;
}

function emitSingleFillRest(out: string[], emittedUnits: number, baseUnit: number, dots: number): void {
  out.push('      <note>');
  out.push('        <rest/>');
  out.push(`        <duration>${emittedUnits}</duration>`);
  out.push('        <voice>1</voice>');
  out.push(`        <type>${unitsToNoteType(baseUnit)}</type>`);
  for (let d = 0; d < dots; d++) out.push('        <dot/>');
  out.push('      </note>');
}

/** 完全に空の小節を全休符で埋める */
function emitWholeRest(
  out: string[],
  header: { div: number; timeNum: number; timeDen: number },
  tupletScale: number,
): void {
  const units = (header.timeNum / header.timeDen) * header.div * tupletScale;
  out.push('      <note>');
  out.push('        <rest measure="yes"/>');
  out.push(`        <duration>${units}</duration>`);
  out.push('        <voice>1</voice>');
  out.push('      </note>');
}

// ============================================================
// ヘルパー
// ============================================================

/** units → MusicXML の <type> 文字列。v2.0: DIV=64 ベース */
function unitsToNoteType(units: number, div: number = 64): string {
  // durationUnits は実際の div スケールなので、div=64 基準に正規化してから判定する
  const n = Math.round(units * 64 / div);
  // g=1u=64th, h=2u=32nd, i=4u=16th, j=8u=8th, k=16u=quarter, l=32u=half, m=64u=whole, n=128u=breve
  switch (n) {
    case 1: return '64th';
    case 2: return '32nd';
    case 4: return '16th';
    case 8: return 'eighth';
    case 16: return 'quarter';
    case 32: return 'half';
    case 64: return 'whole';
    case 128: return 'breve';
  }
  // フォールバック: 一番近い基本値
  if (n < 1) return '64th';
  if (n < 2) return '64th';
  if (n < 4) return '32nd';
  if (n < 8) return '16th';
  if (n < 16) return 'eighth';
  if (n < 32) return 'quarter';
  if (n < 64) return 'half';
  if (n < 128) return 'whole';
  return 'breve';
}

function clefToMusicXml(clef: HideClef): { sign: string; line: number; octaveChange?: number } {
  switch (clef) {
    case 'TREBLE': return { sign: 'G', line: 2 };
    case 'TREBLE_8VA': return { sign: 'G', line: 2, octaveChange: 1 };
    case 'TREBLE_8VB': return { sign: 'G', line: 2, octaveChange: -1 };
    case 'BASS': return { sign: 'F', line: 4 };
    case 'ALTO': return { sign: 'C', line: 3 };
    case 'TENOR': return { sign: 'C', line: 4 };
    case 'SOPRANO': return { sign: 'C', line: 1 };
    case 'BARITONE': return { sign: 'F', line: 3 };
    case 'PERCUSSION': return { sign: 'percussion', line: 2 };
    default: {
      const _exhaustive: never = clef;
      throw new Error(`unhandled clef: ${String(_exhaustive)}`);
    }
  }
}

/** 音部記号の MusicXML 出力ヘルパー */
function emitClefXml(out: string[], clef: HideClef, indent: string = '        '): void {
  const { sign, line, octaveChange } = clefToMusicXml(clef);
  out.push(`${indent}<clef>`);
  out.push(`${indent}  <sign>${sign}</sign>`);
  out.push(`${indent}  <line>${line}</line>`);
  if (octaveChange !== undefined) {
    out.push(`${indent}  <clef-octave-change>${octaveChange}</clef-octave-change>`);
  }
  out.push(`${indent}</clef>`);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ============================================================
// 移調 + 異名同音選択 + 臨時記号表示判定ヘルパー (v2.0)
// ============================================================

/** 12平均律でのピッチクラス (C=0, C#=1, ..., B=11) */
const STEP_TO_PC: Record<HidePitch['step'], number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

/** ピッチクラス → ♯方向のスペル (新調が ♯ 方向の時に使う) */
const PC_TO_SHARP_SPELL: Array<{ step: HidePitch['step']; alter: HidePitch['alter'] }> = [
  { step: 'C', alter: 0 },   // 0
  { step: 'C', alter: 1 },   // 1 (C#)
  { step: 'D', alter: 0 },   // 2
  { step: 'D', alter: 1 },   // 3 (D#)
  { step: 'E', alter: 0 },   // 4
  { step: 'F', alter: 0 },   // 5
  { step: 'F', alter: 1 },   // 6 (F#)
  { step: 'G', alter: 0 },   // 7
  { step: 'G', alter: 1 },   // 8 (G#)
  { step: 'A', alter: 0 },   // 9
  { step: 'A', alter: 1 },   // 10 (A#)
  { step: 'B', alter: 0 },   // 11
];

/** ピッチクラス → ♭方向のスペル (新調が ♭ 方向の時に使う) */
const PC_TO_FLAT_SPELL: Array<{ step: HidePitch['step']; alter: HidePitch['alter'] }> = [
  { step: 'C', alter: 0 },   // 0
  { step: 'D', alter: -1 },  // 1 (Db)
  { step: 'D', alter: 0 },   // 2
  { step: 'E', alter: -1 },  // 3 (Eb)
  { step: 'E', alter: 0 },   // 4
  { step: 'F', alter: 0 },   // 5
  { step: 'G', alter: -1 },  // 6 (Gb)
  { step: 'G', alter: 0 },   // 7
  { step: 'A', alter: -1 },  // 8 (Ab)
  { step: 'A', alter: 0 },   // 9
  { step: 'B', alter: -1 },  // 10 (Bb)
  { step: 'B', alter: 0 },   // 11
];

/** 半音シフトの fifths への変換 (semitones → 五度圏 delta、-6..+6 に正規化) */
export function semitonesToFifthsShift(semitones: number): number {
  // 半音1個 = 五度圏で7移動 (mod 12 で正規化)
  const raw = ((semitones * 7) % 12 + 12) % 12;
  // 0..11 → -6..+5 (or +6 を許す)
  return raw > 6 ? raw - 12 : raw;
}

/** 元曲の調 + 半音シフト → 新しい調の fifths */
export function computeNewKeyFifths(originalFifths: number, transposeSemitones: number): number {
  if (transposeSemitones === 0) return originalFifths;
  const delta = semitonesToFifthsShift(transposeSemitones);
  let newFifths = originalFifths + delta;
  // -7..+7 にクランプ (理論上はそれ以上もあるが MusicXML 標準内に収める)
  while (newFifths > 7) newFifths -= 12;
  while (newFifths < -7) newFifths += 12;
  return newFifths;
}

/** 新調の fifths 方向 (♯ 方向 / ♭ 方向 / フラット) を返す */
function isSharpDirection(newKeyFifths: number): boolean {
  return newKeyFifths >= 0;
}

/** ピッチを移調 + 異名同音再スペル */
export function transposePitch(
  p: HidePitch,
  semitones: number,
  newKeyFifths: number,
): HidePitch {
  if (semitones === 0) return p;
  // 元のピッチクラス (絶対 MIDI 風) を計算
  const originalPc = STEP_TO_PC[p.step] + p.alter;
  const originalAbs = p.octave * 12 + originalPc;
  const newAbs = originalAbs + semitones;
  const newOctave = Math.floor(newAbs / 12);
  const newPc = ((newAbs % 12) + 12) % 12;
  // 新調の方向で spell を選ぶ
  const spelling = isSharpDirection(newKeyFifths) ? PC_TO_SHARP_SPELL[newPc] : PC_TO_FLAT_SPELL[newPc];
  return {
    step: spelling.step,
    octave: newOctave,
    alter: spelling.alter,
  };
}

/**
 * v2.0: 臨時記号表示判定。Rule B 廃止 — .hide source は毎回絶対音高を指定する。
 * MusicXML 出力時は調号コンテキスト + 小節内記憶から <alter>/<accidental> の要否を判定する。
 *
 * - <alter> は常に p.alter ≠ 0 なら出力 (ピッチ定義の一部)
 * - <accidental> は音名の alter が「現在の小節で期待される alter」と異なる場合に出力 (表示用)
 */
export function determineAccidentalDisplay(
  p: HidePitch,
  keyFifths: number,
  measureMemory: Map<string, number>,
): { showAccidental: boolean } {
  const key = `${p.step}${p.octave}`;
  const naturalAlterForKey = naturalAlterByKey(p.step, keyFifths);
  const memoryAlter = measureMemory.get(key);
  // 小節内で「現在有効な alter」は: 記憶があればそれ、なければ調号デフォルト
  const effectiveAlter = memoryAlter !== undefined ? memoryAlter : naturalAlterForKey;

  if (p.alter === effectiveAlter) {
    // 既に有効な alter と同じ → 表示不要
    return { showAccidental: false };
  }
  // 異なる → 表示必要 + 記憶を更新
  measureMemory.set(key, p.alter);
  return { showAccidental: true };
}

/** 調号 fifths でその音名が自然に持つ alter を返す (例: G major で F は ♯) */
function naturalAlterByKey(step: HidePitch['step'], keyFifths: number): -1 | 0 | 1 {
  // 五度圏での順番: F C G D A E B (♭側) ... C G D A E B F# C# G# D# A# E# B# (♯側)
  // 7つ ♯ → C# major: F♯ C♯ G♯ D♯ A♯ E♯ B♯
  // 7つ ♭ → Cb major: B♭ E♭ A♭ D♭ G♭ C♭ F♭
  const sharpOrder: HidePitch['step'][] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const flatOrder: HidePitch['step'][] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
  if (keyFifths > 0) {
    const sharpsInKey = sharpOrder.slice(0, Math.min(keyFifths, 7));
    if (sharpsInKey.includes(step)) return 1;
  } else if (keyFifths < 0) {
    const flatsInKey = flatOrder.slice(0, Math.min(-keyFifths, 7));
    if (flatsInKey.includes(step)) return -1;
  }
  return 0;
}

/** 新しい小節用の臨時記号表示記憶を作る */
export function createMeasureMemory(): Map<string, number> {
  return new Map();
}

/** ノートトークン全体の音高を移調する */
function transposeNoteToken(
  tok: HideNoteToken,
  semitones: number,
  newKeyFifths: number,
): HideNoteToken {
  return {
    ...tok,
    pitches: tok.pitches.map(p => transposePitch(p, semitones, newKeyFifths)),
  };
}
