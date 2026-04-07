/**
 * hideLoader.ts — .hide ソーステキストを MusicXML にコンパイルする高レベルAPI
 *
 * 用途:
 *   - HidePlayground / MusicPlayer / OMR から呼ぶエントリーポイント
 *   - 内部で tokenize → parse → astToMusicXML を順に呼ぶ
 *   - 失敗時は HideParseError を投げる (呼び出し側で UI に出す)
 *
 * M1 (現在): シングルパート出力のみ。M2 で hideExpander を間に挟んで複数パート対応する。
 */

import type { HideCompileOptions, HideCompileResult } from './hideTypes';
import { tokenize } from './hideLexer';
import { parse } from './hideParser';
import { astToMusicXML } from './hideToMusicXML';

export { HideParseError } from './hideErrors';
export type { HideCompileOptions, HideCompileResult } from './hideTypes';

/**
 * .hide ソーステキストを MusicXML 文字列にコンパイルする。
 *
 * @param source .hide ソーステキスト全体
 * @param opts   タイトル・作曲者などの追加メタ情報
 * @returns      MusicXML 文字列 + 警告 + パート/小節数
 * @throws       HideParseError パース失敗時 (行/列番号付き)
 */
export function compileHide(
  source: string,
  opts: HideCompileOptions = {},
): HideCompileResult {
  const lex = tokenize(source);
  const parsed = parse(lex);
  const { musicXml, measuresCount, partsCount, warnings: xmlWarnings } = astToMusicXML(parsed.ast, opts);
  return {
    musicXml,
    warnings: [...parsed.warnings, ...xmlWarnings],
    partsCount,
    measuresCount,
  };
}

/**
 * `.hide` 拡張子・MIME 判定ヘルパー。
 * scoreStore など他モジュールから利用する。
 */
export function isHideFileName(name: string): boolean {
  return /\.hide$/i.test(name);
}
