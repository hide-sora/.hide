/**
 * hideToMusicXML.ts — HideAst / HidePartitionedAst を MusicXML 文字列に変換する
 *
 * M2: 複数パート対応 + 反復展開済み AST を受理
 *   - DIV を header から動的取得 (3/4 で 24u/measure 等)
 *   - 移調 [K+n]: header.transposeSemitones を全音符に適用
 *   - 異名同音自動選択: 新しい調の fifths 方向に合わせて ♯/♭ を選ぶ
 *   - Rule B: 1小節内の臨時記号記憶 (同じ音名・オクターブで明示があれば以降は省略)
 *   - メタ tempo は <direction> として出力
 *   - 連符 (HideTupletGroup → tupletMember 付きノート列) を <time-modification><tuplet/> で出力
 *
 * 出力 MusicXML は scoreModel.ts の _parseMusicXML() が受理する形式に揃える
 * (= OSMD 互換)。
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
  const newKeyFifths = computeNewKeyFifths(header.keyFifths, header.transposeSemitones);

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

      // 左端バーライン (`.:` = repeatStart)
      if (bucket.leftBarlineStyle) {
        emitBarline(out, bucket.leftBarlineStyle, 'left');
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
        out.push('        <clef>');
        const { sign, line } = clefToMusicXml(header.clef);
        out.push(`          <sign>${sign}</sign>`);
        out.push(`          <line>${line}</line>`);
        out.push('        </clef>');
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
        for (const tok of bucket.tokens) {
          if (tok.kind === 'meta' && tok.type === 'tempo' && tok.bpm !== undefined) {
            // 初回テンポは pi=0 で既に measure 1 上に出している。同じ bucket で重複する場合は省略
            if (mi === 0 && pi === 0 && initialTempoEmitted && tok.bpm === initialBpm) {
              initialTempoEmitted = false; // 同じ値の重複は1回だけ消化
              continue;
            }
            emitTempoDirection(out, tok.bpm);
          } else if (tok.kind === 'rest') {
            emitRest(out, tok, tupletScale);
          } else if (tok.kind === 'note') {
            emitNote(out, tok, newKeyFifths, measureMemory, tupletScale);
          }
        }
        const remainder = bucket.unitsPerMeasure - bucket.totalUnits;
        if (remainder > 0) {
          emitFillRest(out, remainder, tupletScale);
        }
      }
      // 右端バーライン (`..`/`.../`:.`)。`single` (= 通常小節線) は暗黙なので出力しない
      if (bucket.rightBarlineStyle && bucket.rightBarlineStyle !== 'single') {
        emitBarline(out, bucket.rightBarlineStyle, 'right');
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
      // 暗黙 (通常は呼ばれない)
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
  }
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
      if (tok.type === 'tempo') {
        // 現在の bucket に inline で挿入
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
    const dur = getEmittedDuration(tok, tupletScale);
    let bucket = measures[measures.length - 1];
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
  measureMemory: Map<string, -1 | 0 | 1>,
  tupletScale: number,
): void {
  const emittedDur = getEmittedDuration(tok, tupletScale);
  // <type> は付点なしのベース長さから決める (k.=12u → base 8u = quarter)
  const baseUnits = tok.dots === 2 ? tok.durationUnits / 1.75
    : tok.dots === 1 ? tok.durationUnits / 1.5
    : tok.durationUnits;
  const noteType = unitsToNoteType(Math.round(baseUnits));

  // 連符 time-modification の actual:normal を計算
  let timeModXml: string | null = null;
  let tupletStartStop: { start: boolean; stop: boolean } = { start: false, stop: false };
  if (tok.tupletMember) {
    const { totalMembers, targetUnits, memberIndex } = tok.tupletMember;
    // normal-notes = targetUnits / 元の長さ (例: 8u target に j(=4u) → 2)
    const normalNotes = Math.max(1, Math.round(targetUnits / tok.durationUnits));
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
    // Rule B: 小節内の臨時記号記憶を考慮して <alter> を出すか決める
    const ruleB = applyRuleB(p, keyFifths, measureMemory);

    out.push('      <note>');
    if (i > 0) out.push('        <chord/>');
    out.push('        <pitch>');
    out.push(`          <step>${p.step}</step>`);
    if (ruleB.needAlter) out.push(`          <alter>${ruleB.displayAlter}</alter>`);
    out.push(`          <octave>${p.octave}</octave>`);
    out.push('        </pitch>');
    out.push(`        <duration>${emittedDur}</duration>`);
    out.push('        <voice>1</voice>');
    out.push(`        <type>${noteType}</type>`);
    for (let d = 0; d < tok.dots; d++) out.push('        <dot/>');
    if (timeModXml) out.push(timeModXml);

    // 明示臨時記号 → <accidental> も書く (OSMD/OMR 表示用)
    if (ruleB.needAlter || p.accidentalExplicit) {
      const accName = alterToAccidentalName(ruleB.displayAlter);
      if (accName) out.push(`        <accidental>${accName}</accidental>`);
    }

    // タイ start (chord 2つ目以降は省略)
    const isFirstChordNote = i === 0;
    if (tok.tieToNext && isFirstChordNote) {
      out.push('        <tie type="start"/>');
    }

    const wantNotations = isFirstChordNote && (
      tok.staccato || tok.slurStart || tok.tieToNext ||
      tupletStartStop.start || tupletStartStop.stop
    );
    if (wantNotations) {
      out.push('        <notations>');
      if (tok.tieToNext) {
        out.push('          <tied type="start"/>');
      }
      if (tok.slurStart) {
        out.push('          <slur type="start" number="1"/>');
      }
      if (tupletStartStop.start) {
        out.push('          <tuplet type="start" number="1"/>');
      }
      if (tupletStartStop.stop) {
        out.push('          <tuplet type="stop" number="1"/>');
      }
      if (tok.staccato) {
        out.push('          <articulations><staccato/></articulations>');
      }
      out.push('        </notations>');
    }

    // 歌詞は和音の代表音 (1個目) のみに付ける
    if (isFirstChordNote && tok.lyric) {
      out.push('        <lyric number="1">');
      out.push('          <syllabic>single</syllabic>');
      out.push(`          <text>${escapeXml(tok.lyric)}</text>`);
      out.push('        </lyric>');
    }
    out.push('      </note>');
  }
}

function alterToAccidentalName(alter: -1 | 0 | 1): string | null {
  if (alter === 1) return 'sharp';
  if (alter === -1) return 'flat';
  if (alter === 0) return 'natural';
  return null;
}

function emitRest(out: string[], tok: HideRestToken, tupletScale: number): void {
  const emittedDur = getEmittedDuration(tok, tupletScale);
  const baseUnits = tok.dots === 2 ? tok.durationUnits / 1.75
    : tok.dots === 1 ? tok.durationUnits / 1.5
    : tok.durationUnits;
  out.push('      <note>');
  out.push('        <rest/>');
  out.push(`        <duration>${emittedDur}</duration>`);
  out.push('        <voice>1</voice>');
  out.push(`        <type>${unitsToNoteType(Math.round(baseUnits))}</type>`);
  for (let d = 0; d < tok.dots; d++) out.push('        <dot/>');
  // 休符の連符 time-modification (連符内に休符がある場合)
  if (tok.tupletMember) {
    const { totalMembers, targetUnits, memberIndex } = tok.tupletMember;
    const normalNotes = Math.max(1, Math.round(targetUnits / tok.durationUnits));
    out.push('        <time-modification>');
    out.push(`          <actual-notes>${totalMembers}</actual-notes>`);
    out.push(`          <normal-notes>${normalNotes}</normal-notes>`);
    out.push('        </time-modification>');
    if (memberIndex === 0 || memberIndex === totalMembers - 1) {
      out.push('        <notations>');
      if (memberIndex === 0) out.push('          <tuplet type="start" number="1"/>');
      if (memberIndex === totalMembers - 1) out.push('          <tuplet type="stop" number="1"/>');
      out.push('        </notations>');
    }
  }
  out.push('      </note>');
}

/** 端数を埋める単純休符。emittedUnits はスケール後単位。<type> は raw unit (scale で割る) で計算 */
function emitFillRest(out: string[], emittedUnits: number, tupletScale: number): void {
  // <type> 計算は raw 単位 (scale で割る) で行う
  const rawUnits = emittedUnits / tupletScale;
  out.push('      <note>');
  out.push('        <rest/>');
  out.push(`        <duration>${emittedUnits}</duration>`);
  out.push('        <voice>1</voice>');
  out.push(`        <type>${unitsToNoteType(rawUnits)}</type>`);
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

/** units → MusicXML の <type> 文字列。M1 では DIV=32 前提 */
function unitsToNoteType(units: number): string {
  // 1u=32分, 2u=16分, 4u=8分, 8u=4分, 16u=2分, 32u=全
  switch (units) {
    case 1: return '32nd';
    case 2: return '16th';
    case 4: return 'eighth';
    case 8: return 'quarter';
    case 16: return 'half';
    case 32: return 'whole';
    case 64: return 'breve';
  }
  // フォールバック: 一番近い基本値
  if (units < 1) return '32nd';
  if (units < 2) return '32nd';
  if (units < 4) return '16th';
  if (units < 8) return 'eighth';
  if (units < 16) return 'quarter';
  if (units < 32) return 'half';
  return 'whole';
}

function clefToMusicXml(clef: HideClef): { sign: string; line: number } {
  switch (clef) {
    case 'TREBLE': return { sign: 'G', line: 2 };
    // TREBLE_8VA / TREBLE_8VB は譜面上の sign/line は G line 2 と同じ。
    // 実音の octave シフト (clef-octave-change: +1 / -1) はこの関数の返り値型には
    // 含めていない (スキーマ拡張は将来課題)。
    case 'TREBLE_8VA': return { sign: 'G', line: 2 };
    case 'TREBLE_8VB': return { sign: 'G', line: 2 };
    case 'BASS': return { sign: 'F', line: 4 };
    case 'ALTO': return { sign: 'C', line: 3 };
    case 'TENOR': return { sign: 'C', line: 4 };
    case 'PERCUSSION': return { sign: 'percussion', line: 2 };
    default: {
      // exhaustiveness check: HideClef に新値を追加したらここが型エラーになる
      const _exhaustive: never = clef;
      throw new Error(`unhandled clef: ${String(_exhaustive)}`);
    }
  }
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
// 移調 + 異名同音選択 + Rule B 用ヘルパー
// ============================================================

/** 12平均律でのピッチクラス (C=0, C#=1, ..., B=11) */
const STEP_TO_PC: Record<HidePitch['step'], number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

/** ピッチクラス → ♯方向のスペル (新調が ♯ 方向の時に使う) */
const PC_TO_SHARP_SPELL: Array<{ step: HidePitch['step']; alter: -1 | 0 | 1 }> = [
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
const PC_TO_FLAT_SPELL: Array<{ step: HidePitch['step']; alter: -1 | 0 | 1 }> = [
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
    accidentalExplicit: p.accidentalExplicit,
  };
}

/**
 * Rule B (1小節内臨時記号記憶) を適用しつつ、ピッチに alter を出力すべきかを判定する。
 *
 * @param p             対象ピッチ
 * @param keyFifths     新しい調 (五度圏)
 * @param measureMemory 小節内記憶 (key: "step+octave"、value: 直前の alter)
 * @returns             { needAlter: alter を <alter> として書くか, displayAlter: 書く時の値 }
 */
export function applyRuleB(
  p: HidePitch,
  keyFifths: number,
  measureMemory: Map<string, -1 | 0 | 1>,
): { needAlter: boolean; displayAlter: -1 | 0 | 1 } {
  const key = `${p.step}${p.octave}`;
  // この音名の調号での自然な alter (♯ 系の調なら +1、♭ 系の調なら -1)
  const naturalAlterForKey = naturalAlterByKey(p.step, keyFifths);
  // 小節内に既存の記憶があるか
  const memoryAlter = measureMemory.get(key);
  // 「実質的に有効な alter」(記憶 > 調号)
  const effectiveAlter: -1 | 0 | 1 = memoryAlter !== undefined ? memoryAlter : naturalAlterForKey;

  if (p.alter === effectiveAlter) {
    // 既に効いている alter と同じ → 出力不要
    return { needAlter: false, displayAlter: p.alter };
  }
  // 異なる → 出力必要 + 記憶を更新
  measureMemory.set(key, p.alter);
  return { needAlter: true, displayAlter: p.alter };
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

/** 新しい小節用の小節記憶 (Rule B 用) を作る */
export function createMeasureMemory(): Map<string, -1 | 0 | 1> {
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
