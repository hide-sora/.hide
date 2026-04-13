/**
 * hideParser.ts — レクサー出力を AST に変換する (v2.0)
 *
 * 再帰下降パーサで反復 (:body:N) と連符 (N(...)) を構造化する。
 *   - 反復: HideRepeatGroup を生成 (ネスト対応)
 *   - 連符: HideTupletGroup を生成 (中身はノート/休符のみ)
 *   - パート切替・移調・調変更などのメタはそのまま AST に乗せる (expander が処理)
 *   - v2.0: Rule B 廃止 — パーサにはもともと Rule B ロジックなし (レクサーが絶対音高を出力)
 */

import type {
  HideAst,
  HideToken,
  HideNoteToken,
  HideRestToken,
  HideRepeatGroup,
  HideTupletGroup,
} from './hideTypes';
import type { HideLexResult, HideRawToken } from './hideLexer';
import type { HideSourcePosition } from './hideErrors';
import { HideParseError } from './hideErrors';

export interface HideParseResult {
  ast: HideAst;
  warnings: string[];
}

export function parse(lex: HideLexResult): HideParseResult {
  const ctx: ParseContext = {
    tokens: lex.tokens,
    positions: lex.positions,
    source: lex.source,
    cursor: 0,
    warnings: [],
  };
  const body = parseBody(ctx, /*stopOnRepeatBoundary*/ false, /*stopOnTupletClose*/ false);
  return {
    ast: { header: lex.header, body },
    warnings: ctx.warnings,
  };
}

interface ParseContext {
  tokens: HideRawToken[];
  positions: HideSourcePosition[];
  source: string;
  cursor: number;
  warnings: string[];
}

/**
 * トークン列をシーケンシャルに読み、反復と連符を構造化する。
 *
 * @param stopOnRepeatBoundary 真なら次の `:` (count付きまたは無し) で停止する (反復の中身用)
 * @param stopOnTupletClose    真なら次の `)` で停止する (連符の中身用)
 */
function parseBody(
  ctx: ParseContext,
  stopOnRepeatBoundary: boolean,
  stopOnTupletClose: boolean,
): HideToken[] {
  const body: HideToken[] = [];

  while (ctx.cursor < ctx.tokens.length) {
    const tok = ctx.tokens[ctx.cursor];
    const pos = ctx.positions[ctx.cursor];

    switch (tok.kind) {
      case 'note': {
        body.push(tok);
        ctx.cursor++;
        break;
      }

      case 'rest': {
        body.push(tok);
        ctx.cursor++;
        break;
      }

      case 'tie': {
        // 直前の音符/休符に tieToNext=true を立てる
        const last = body[body.length - 1];
        if (last && (last.kind === 'note' || last.kind === 'rest')) {
          last.tieToNext = true;
        } else {
          ctx.warnings.push(
            `タイ '+' の直前に音符・休符がありません (line ${pos.line}, col ${pos.column})`,
          );
        }
        ctx.cursor++;
        break;
      }

      case 'lyric': {
        // 直前の最後の音符に追記
        let target: HideToken | undefined;
        for (let j = body.length - 1; j >= 0; j--) {
          if (body[j].kind === 'note') { target = body[j]; break; }
          if (body[j].kind === 'rest') break;
        }
        if (target && target.kind === 'note') {
          target.lyric = (target.lyric ?? '') + tok.text;
        } else {
          ctx.warnings.push(
            `歌詞 "${tok.text}" の直前に対応する音符がありません (line ${pos.line}, col ${pos.column})`,
          );
        }
        ctx.cursor++;
        break;
      }

      case 'meta': {
        // メタコマンドはそのまま AST に載せる。コンパイラが処理。
        body.push(tok);
        ctx.cursor++;
        break;
      }

      case 'tupletOpen': {
        // 連符開始: 終端 ) まで再帰的に parseBody (stopOnTupletClose=true)
        const targetUnits = tok.targetUnits;
        ctx.cursor++; // tupletOpen を消費
        const innerStartPos = pos;
        const innerTokens = parseBody(ctx, false, true);
        if (ctx.cursor >= ctx.tokens.length || ctx.tokens[ctx.cursor].kind !== 'tupletClose') {
          throw new HideParseError(
            `連符 ${targetUnits}(...) が ) で閉じられていません`,
            innerStartPos,
            ctx.source,
          );
        }
        ctx.cursor++; // tupletClose を消費
        // 中身がノート・休符のみであることを確認 (M2)
        const members: (HideNoteToken | HideRestToken)[] = [];
        for (const t of innerTokens) {
          if (t.kind === 'note' || t.kind === 'rest') {
            members.push(t);
          } else {
            ctx.warnings.push(`連符の中にはノート・休符のみ置けます (kind=${t.kind})`);
          }
        }
        const tupletGroup: HideTupletGroup = {
          kind: 'tuplet',
          targetUnits,
          members,
        };
        body.push(tupletGroup);
        break;
      }

      case 'tupletClose': {
        if (stopOnTupletClose) return body; // 呼び出し側で消費
        ctx.warnings.push(
          `予期しない ) (line ${pos.line}, col ${pos.column})`,
        );
        ctx.cursor++;
        break;
      }

      case 'barline': {
        // `|` はセル区切り (matrix mode) / whitespace。パース層では skip。
        ctx.cursor++;
        break;
      }

      case 'measureBarrier': {
        // 小節線 `,`/`,,`/`,,,`/`,:` /`:,`/`,-`/`,.` (v2.0)
        // hard barrier として AST に乗せ、bucketize / musicXmlToHide / OMR で処理する。
        body.push(tok);
        ctx.cursor++;
        break;
      }

      case 'repeatBoundary': {
        // : の出現は2通り:
        //  1. 開始境界 (count なし): ここから反復ボディが始まる
        //  2. 終了境界 (count あり): ここで反復ボディが閉じる
        // 開始時 (count なし) → 再帰的に parseBody(stopOnRepeatBoundary=true) を呼んで終了境界を待つ
        // 終了境界 (count あり) → 親の parseBody が見つけたら return する
        if (tok.count !== undefined) {
          // 終了境界
          if (stopOnRepeatBoundary) {
            // 親に返す (consume せず)。親が消費する。
            return body;
          }
          ctx.warnings.push(
            `反復終了 :${tok.count} に対応する開始 : がありません (line ${pos.line}, col ${pos.column})`,
          );
          ctx.cursor++;
          break;
        } else {
          // 開始境界
          ctx.cursor++; // 開始 : を消費
          const inner = parseBody(ctx, true, false);
          if (ctx.cursor >= ctx.tokens.length || ctx.tokens[ctx.cursor].kind !== 'repeatBoundary') {
            throw new HideParseError(
              `反復 :body: が閉じられていません (count付き : が必要)`,
              pos,
              ctx.source,
            );
          }
          const closeTok = ctx.tokens[ctx.cursor];
          if (closeTok.kind !== 'repeatBoundary' || closeTok.count === undefined) {
            throw new HideParseError(
              `反復終了境界に回数がありません (例: :body:2)`,
              pos,
              ctx.source,
            );
          }
          const count = closeTok.count;
          ctx.cursor++; // 終了 :N を消費
          const repeatGroup: HideRepeatGroup = {
            kind: 'repeat',
            body: inner,
            count,
          };
          body.push(repeatGroup);
          break;
        }
      }
    }
  }

  return body;
}
