/**
 * hideExpander.ts — HideAst を演奏可能な「パート分離 + 反復展開済み」中間表現に変換する
 *
 * 入力: HideAst (ボディは反復・パート切替・連符・メタ がそのまま並んだトークン列)
 * 出力: HidePartitionedAst (パートごとに反復展開済みのフラットなトークン列)
 *
 * 処理手順:
 *   1. 反復展開: HideRepeatGroup 構造を平坦化 (内側からネスト展開)
 *   2. パート分離: [S][A][T][B][P1] メタコマンドで切り替わるパート別に振り分ける
 *   3. パート間の小節数を揃える (短いパートには末尾に全休符を追加)
 *
 * M2 では連符 (HideTupletGroup) はパススルーするだけで、MusicXML 変換側で展開する。
 */

import type {
  HideAst,
  HideHeader,
  HideToken,
  HideNoteToken,
  HideRestToken,
  HideMetaToken,
  HideMeasureBarrierToken,
  HideRepeatGroup,
  HideTupletGroup,
  HidePart,
  HidePartitionedAst,
} from './hideTypes';
import { getPartMeta } from './hideTypes';

export interface HideExpandResult {
  partitioned: HidePartitionedAst;
  warnings: string[];
}

/**
 * HideAst を反復展開・パート分離する。
 */
export function expand(ast: HideAst): HideExpandResult {
  const warnings: string[] = [];

  // 1. 反復をフラット化 (HideRepeatGroup を再帰的に展開)
  const flat = flattenRepeats(ast.body);

  // 2. パート分離。
  //    最初の partSwitch メタが現れる前のトークンは「デフォルトパート」に入る。
  //    デフォルトパートのラベルは "M" (Main) とする。
  type PartTokenIn = HideNoteToken | HideRestToken | HideMetaToken | HideMeasureBarrierToken | HideTupletGroup;
  const partsMap = new Map<string, PartTokenIn[]>();
  let currentPart = 'M';
  const partInstrumentNames = new Map<string, string>();
  for (const tok of flat) {
    if (tok.kind === 'meta' && tok.type === 'partSwitch' && tok.partLabel) {
      currentPart = tok.partLabel;
      if (!partsMap.has(currentPart)) {
        partsMap.set(currentPart, []);
      }
      if (tok.instrumentName) {
        partInstrumentNames.set(currentPart, tok.instrumentName);
      }
      continue;
    }
    if (!partsMap.has(currentPart)) {
      partsMap.set(currentPart, []);
    }
    if (
      tok.kind === 'note' ||
      tok.kind === 'rest' ||
      tok.kind === 'meta' ||
      tok.kind === 'measureBarrier' ||
      tok.kind === 'tuplet'
    ) {
      partsMap.get(currentPart)!.push(tok);
    }
  }

  // 2b. 「pre-partSwitch メタ専用 'M' パート」を実パートにマージする。
  //
  //     例: '[T120][1] C5m .' は [T120] が '[1]' より前にあるので 'M' に入り、
  //     その後 '[1]' で '1' に切り替わると 'M' は「演奏内容を持たない phantom
  //     part」になる。alignPartLengths はこれを「他パートより 32u 短い」と
  //     見て silent に rest 補完していた (warning 条件 `< unitsPerMeasure` の
  //     バグも相まって警告すら出さない)。
  //
  //     正しい挙動: pre-partSwitch のグローバル meta はそれ自体では part を
  //     形成せず、最初の実 part の先頭に流し込まれるべき。tempo / time は
  //     emission 時にどのパートにあっても初期値として拾われる (hideToMusicXML
  //     の initialBpm 抽出ロジックを参照) ので、merge しても情報は失われない。
  if (partsMap.has('M') && partsMap.size > 1) {
    const mTokens = partsMap.get('M')!;
    const mHasPlayable = mTokens.some(
      t =>
        t.kind === 'note' ||
        t.kind === 'rest' ||
        t.kind === 'measureBarrier' ||
        t.kind === 'tuplet',
    );
    if (!mHasPlayable) {
      partsMap.delete('M');
      // 'M' を消した後の最初のキー = 最初の実パート
      const firstLabel = partsMap.keys().next().value as string;
      const firstTokens = partsMap.get(firstLabel)!;
      partsMap.set(firstLabel, [...mTokens, ...firstTokens]);
    }
  }

  // 3. パート単位で HidePart 構造を作る
  const parts: HidePart[] = [];
  let globalGroupIdSeed = 1; // D3: groupId をグローバルに一意にする
  for (const [label, tokens] of Array.from(partsMap.entries())) {
    // デフォルトパート "M" は「単一パートのみ」のスコアで使うので、表示名・MIDIは S と同じにする
    const isDefault = label === 'M';
    const instrName = partInstrumentNames.get(label);
    const meta = isDefault
      ? { partId: 'P_M', displayName: 'Voice', midiProgram: 53 }
      : getPartMeta(label, instrName);
    // 連符 (HideTupletGroup) は中身を展開して単純なノート・休符列にする (M2-F)
    const { tokens: expandedTokens, nextGroupId } = expandTuplets(tokens, globalGroupIdSeed);
    globalGroupIdSeed = nextGroupId;
    parts.push({
      label,
      displayName: meta.displayName,
      partId: meta.partId,
      midiProgram: meta.midiProgram,
      instrumentName: instrName,
      tokens: expandedTokens,
    });
  }

  // 4. パートを 1 つも含まない場合は「空のメインパート」を1つ作る (空 .hide でもクラッシュしないように)
  if (parts.length === 0) {
    parts.push({
      label: 'M',
      displayName: 'Voice',
      partId: 'P_M',
      midiProgram: 53,
      tokens: [],
    });
  }

  // 5. パート間の累積 unit (= 演奏長) を計算し、短いパートに全休符を補完
  //    M2 段階では「全休符は1小節分単位」で追加する。タイム署名変更には未対応。
  alignPartLengths(parts, ast.header, warnings);

  return {
    partitioned: {
      header: ast.header,
      parts,
    },
    warnings,
  };
}

// ============================================================
// ヘルパー
// ============================================================

/**
 * HideRepeatGroup をネストごと再帰的に展開する。
 *
 * 例: [a, repeat([b, c], 3), d] → [a, b, c, b, c, b, c, d]
 *     [a, repeat([b, repeat([c], 2)], 2), d] → [a, b, c, c, b, c, c, d]
 */
function flattenRepeats(tokens: HideToken[]): Exclude<HideToken, HideRepeatGroup>[] {
  const out: Exclude<HideToken, HideRepeatGroup>[] = [];
  for (const tok of tokens) {
    if (tok.kind === 'repeat') {
      // ネスト展開: 内側を先に flatten してから N 回繰り返す
      const inner = flattenRepeats(tok.body);
      const count = Math.max(1, Math.floor(tok.count));
      for (let i = 0; i < count; i++) {
        for (const t of inner) out.push(t);
      }
    } else {
      out.push(tok);
    }
  }
  return out;
}

/**
 * 連符 (HideTupletGroup) を中身の単純なノート・休符列に展開する。
 * M2 では tuplet metadata を各メンバーに付けて返す (実際の time-modification は MusicXML 側で出力)。
 * 小節終止マーカー (measureBarrier) はそのままパススルー。
 */
function expandTuplets(
  tokens: (HideNoteToken | HideRestToken | HideMetaToken | HideMeasureBarrierToken | HideTupletGroup)[],
  groupIdSeed: number = 1,
): { tokens: (HideNoteToken | HideRestToken | HideMetaToken | HideMeasureBarrierToken)[]; nextGroupId: number } {
  const out: (HideNoteToken | HideRestToken | HideMetaToken | HideMeasureBarrierToken)[] = [];
  let seed = groupIdSeed;
  for (const tok of tokens) {
    if (tok.kind === 'tuplet') {
      const groupId = seed++;
      const targetUnits = tok.targetUnits;
      const totalMembers = tok.members.length;
      // グループ全体で統一的に normalNotes を計算 (最初のメンバーの額面を基準)
      const refDuration = tok.members[0]?.durationUnits || 1;
      const normalNotes = Math.max(1, Math.round(targetUnits / refDuration));
      for (let i = 0; i < totalMembers; i++) {
        const member = tok.members[i];
        const annotated: HideNoteToken | HideRestToken = {
          ...member,
          tupletMember: {
            groupId,
            memberIndex: i,
            totalMembers,
            targetUnits,
            normalNotes,
          },
        };
        out.push(annotated);
      }
    } else {
      out.push(tok);
    }
  }
  return { tokens: out, nextGroupId: seed };
}

/**
 * パート間の累積 unit が揃うように、短いパートの末尾に全休符 (1小節) を追加する。
 *
 * M2 では「動的な拍子変更」を考慮しないので、ヘッダーの time signature だけを使う。
 */
function alignPartLengths(parts: HidePart[], header: HideHeader, warnings: string[]): void {
  if (parts.length <= 1) return;

  const unitsPerMeasure = Math.round((header.timeNum / header.timeDen) * header.div);
  if (unitsPerMeasure <= 0) return;

  // 各パートの累積 unit を計算
  const partLengths = parts.map(p => sumPlayableUnits(p.tokens));
  const maxUnits = Math.max(...partLengths);
  // maxUnits を小節境界まで切り上げ
  const alignedTarget = Math.ceil(maxUnits / unitsPerMeasure) * unitsPerMeasure;

  for (let i = 0; i < parts.length; i++) {
    const remaining = alignedTarget - partLengths[i];
    if (remaining <= 0) continue;
    // 残り unit を全休符1小節ずつ追加 (端数は最後の rest で吸収)
    // 各休符の後に measureBarrier を挿入して bucketize が小節を認識できるようにする
    let left = remaining;
    while (left > 0) {
      const r = Math.min(left, unitsPerMeasure);
      parts[i].tokens.push({
        kind: 'rest',
        durationUnits: r,
        dots: 0,
        tieToNext: false,
      });
      parts[i].tokens.push({
        kind: 'measureBarrier',
        style: 'single',
      });
      left -= r;
    }
    // 補完が発生したら必ず通知する。
    // (旧実装は `remaining < unitsPerMeasure` の時だけ warning を出していたが、
    //  小節単位で丸ごと短いパートが silent に padded されてしまうバグだった。
    //  reverse / matrix 経由の pipeline では padding は望ましくないので、
    //  少なくとも警告を必ず上げて呼び出し側に判断材料を渡す。)
    warnings.push(`パート ${parts[i].label} が他パートより ${remaining}u 短かったため全休符で補完しました`);
  }
}

/** ノート・休符の累積 unit を計算 (メタ・小節終止マーカーは無視) */
function sumPlayableUnits(
  tokens: (HideNoteToken | HideRestToken | HideMetaToken | HideMeasureBarrierToken)[],
): number {
  let sum = 0;
  for (const t of tokens) {
    // 装飾音 (grace note) は演奏長 0 なので合計に含めない
    if (t.kind === 'note' && t.graceType) continue;
    if (t.kind === 'note' || t.kind === 'rest') {
      // tuplet メンバーは額面 durationUnits ではなく実際の演奏長を使う
      if (t.tupletMember) {
        sum += t.tupletMember.targetUnits / t.tupletMember.totalMembers;
      } else {
        sum += t.durationUnits;
      }
    }
  }
  return sum;
}
