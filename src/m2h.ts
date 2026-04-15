/**
 * m2h.ts — M2H (MusicXML → .hide) v2.1 モジュール
 *
 * musicXmlToHide.ts の公開エントリーポイント。
 * 単体インポートで使える便利エクスポートを提供する。
 *
 * @example
 *   import { m2h } from './m2h';
 *   const { hideSource, diagnostics } = m2h(xmlString);
 *
 * @example
 *   import { m2h, type M2HResult, type M2HDiagnostic } from './m2h';
 *   const result: M2HResult = m2h(xmlString, { partLabels: ['S','A','T','B'] });
 */

export {
  musicXmlToHide,
  musicXmlToHide as m2h,
  type MusicXmlToHideOptions,
  type MusicXmlToHideOptions as M2HOptions,
  type MusicXmlToHideResult,
  type MusicXmlToHideResult as M2HResult,
  type MusicXmlToHideDiagnostic,
  type MusicXmlToHideDiagnostic as M2HDiagnostic,
} from './musicXmlToHide';
