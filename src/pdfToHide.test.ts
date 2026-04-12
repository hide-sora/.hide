/**
 * pdfToHide.test.ts — Audiveris pipeline unit tests
 *
 * Audiveris CLI は外部依存のため、ここではモジュールの export と型を検証する。
 * 実 PDF の end-to-end テストは scripts/tryPdfToHide.ts で行う。
 */

import { describe, it, expect } from 'vitest';

describe('pdfToHide — module exports', () => {
  it('exports pdfToHide and pdfToHideFromFile', async () => {
    const mod = await import('./index');
    expect(typeof mod.pdfToHide).toBe('function');
    expect(typeof mod.pdfToHideFromFile).toBe('function');
  });

  it('exports runAudiveris', async () => {
    const mod = await import('./index');
    expect(typeof mod.runAudiveris).toBe('function');
  });

  it('exports musicXmlToHide', async () => {
    const mod = await import('./index');
    expect(typeof mod.musicXmlToHide).toBe('function');
  });
});

describe('pdfHideAudiveris — findAudiverisPath', () => {
  it('runAudiveris rejects with clear error for missing PDF', async () => {
    const { runAudiveris } = await import('./pdfHideAudiveris');
    await expect(
      runAudiveris('/nonexistent/path.pdf'),
    ).rejects.toThrow();
  });
});
