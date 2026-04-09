/**
 * pdfToHide.test.ts — pdfToHide orchestrator + pdfHideLlm unit tests
 *
 * Phase 1-4 の end-to-end は実 PDF + 実 LLM API が必要なので、
 * ここでは個別モジュールのワイヤリングとモック LLM による制御フローを検証する。
 */

import { describe, it, expect } from 'vitest';
import { createClaudeCaller } from './pdfHideLlm';
import type { CallLlmFn, CallLlmInput } from './pdfHideLlm';

// ============================================================
// pdfHideLlm — createClaudeCaller
// ============================================================

describe('pdfHideLlm — createClaudeCaller', () => {
  it('returns custom callLlm when provided', async () => {
    const mockFn: CallLlmFn = async (_input: CallLlmInput) => 'mock response';
    const caller = createClaudeCaller({ callLlm: mockFn });
    const result = await caller({
      systemPrompt: 'test',
      userContent: [{ type: 'text', text: 'hello' }],
    });
    expect(result).toBe('mock response');
  });

  it('custom callLlm receives systemPrompt and userContent', async () => {
    let captured: CallLlmInput | null = null;
    const mockFn: CallLlmFn = async (input: CallLlmInput) => {
      captured = input;
      return 'ok';
    };
    const caller = createClaudeCaller({ callLlm: mockFn });
    await caller({
      systemPrompt: 'sys',
      userContent: [{ type: 'text', text: 'user msg' }],
      maxTokens: 1024,
    });
    expect(captured).not.toBeNull();
    expect(captured!.systemPrompt).toBe('sys');
    expect(captured!.userContent).toHaveLength(1);
    expect(captured!.maxTokens).toBe(1024);
  });

  it('throws without API key when no custom callLlm', async () => {
    // Temporarily remove ANTHROPIC_API_KEY
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const caller = createClaudeCaller({});
      await expect(
        caller({
          systemPrompt: 'test',
          userContent: [{ type: 'text', text: 'hello' }],
        }),
      ).rejects.toThrow('ANTHROPIC_API_KEY');
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
    }
  });
});

// ============================================================
// pdfToHide — mock integration
// ============================================================

describe('pdfToHide — pipeline wiring (mock LLM)', () => {
  it('exports pdfToHide and pdfToHideFromFile from index', async () => {
    const mod = await import('./index');
    expect(typeof mod.pdfToHide).toBe('function');
    expect(typeof mod.pdfToHideFromFile).toBe('function');
    expect(typeof mod.createClaudeCaller).toBe('function');
  });

  it('exports pdfToImages from index', async () => {
    const mod = await import('./index');
    expect(typeof mod.pdfToImages).toBe('function');
    expect(typeof mod.pdfToImagesFromFile).toBe('function');
  });
});
