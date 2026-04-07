/**
 * hideErrors.ts — .hide パースエラークラス
 *
 * パース失敗時に「どこで」「なぜ」失敗したかをユーザーに伝えるため、
 * 行・列番号・原文の周辺を含む詳細エラーを投げる。
 */

export interface HideSourcePosition {
  /** 0 始まりの絶対オフセット */
  offset: number;
  /** 1 始まりの行番号 */
  line: number;
  /** 1 始まりの列番号 */
  column: number;
}

export class HideParseError extends Error {
  public readonly position: HideSourcePosition;
  public readonly snippet: string;

  constructor(message: string, position: HideSourcePosition, source?: string) {
    const snippet = source ? extractSnippet(source, position) : '';
    const formatted = `${message} (line ${position.line}, col ${position.column})${snippet ? `\n${snippet}` : ''}`;
    super(formatted);
    this.name = 'HideParseError';
    this.position = position;
    this.snippet = snippet;
  }
}

/**
 * エラー位置の前後を切り出して、見やすい形に整形する。
 *   2 |  [CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]
 *   3 |  C4kゆめD4kZ
 *     |          ^
 */
function extractSnippet(source: string, pos: HideSourcePosition): string {
  const lines = source.split(/\r?\n/);
  const lineIdx = pos.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return '';
  const line = lines[lineIdx];
  const lineNumWidth = String(pos.line).length;
  const prefix = `${pos.line.toString().padStart(lineNumWidth)} | `;
  const indent = ' '.repeat(lineNumWidth) + ' | ';
  const caret = ' '.repeat(Math.max(0, pos.column - 1)) + '^';
  return `${prefix}${line}\n${indent}${caret}`;
}

/** 0始まりオフセットから (line, column) を計算するヘルパー */
export function offsetToPosition(source: string, offset: number): HideSourcePosition {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { offset, line, column };
}
