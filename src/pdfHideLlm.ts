/**
 * pdfHideLlm.ts — Claude API 接続レイヤー
 *
 * Phase 1 (pdfHideMeta) と Phase 4 (pdfHideLlmFallback) のプロンプトを
 * Anthropic Claude API に送信し、応答テキストを返す薄い wrapper。
 *
 * 設計:
 *  - @anthropic-ai/sdk を dynamic import (optional dependency)
 *  - ANTHROPIC_API_KEY 環境変数から認証
 *  - consumer がカスタム callLlm を注入できるよう、関数シグネチャを公開
 */

import type { PdfHideMetaContentBlock } from './pdfHideMeta';
import type { PdfHideFallbackContentBlock } from './pdfHideLlmFallback';

// ============================================================
// 公開型
// ============================================================

/** LLM 呼び出しの共通シグネチャ。consumer が差し替え可能。 */
export type CallLlmFn = (input: CallLlmInput) => Promise<string>;

export interface CallLlmInput {
  systemPrompt: string;
  userContent: Array<PdfHideMetaContentBlock | PdfHideFallbackContentBlock>;
  maxTokens?: number;
}

export interface PdfHideLlmOptions {
  /** Anthropic API key (省略時は ANTHROPIC_API_KEY 環境変数) */
  apiKey?: string;
  /** モデル ID (default: claude-sonnet-4-6) */
  model?: string;
  /** 最大出力トークン (default: 8192) */
  maxTokens?: number;
  /** カスタム LLM 呼び出し関数 (テスト用や他の API に差し替え) */
  callLlm?: CallLlmFn;
}

// ============================================================
// 公開API
// ============================================================

/**
 * デフォルトの Claude API 呼び出し関数を生成する。
 *
 * @param opts API key やモデルの設定
 * @returns CallLlmFn — Phase 1/4 のプロンプトを送って応答テキストを得る関数
 */
export function createClaudeCaller(opts: PdfHideLlmOptions = {}): CallLlmFn {
  if (opts.callLlm) return opts.callLlm;

  const model = opts.model ?? 'claude-sonnet-4-6';
  const defaultMaxTokens = opts.maxTokens ?? 8192;

  return async (input: CallLlmInput): Promise<string> => {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY が設定されていません。' +
        '環境変数に設定するか、opts.apiKey で渡してください。',
      );
    }

    // Dynamic import to keep @anthropic-ai/sdk optional
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const maxTokens = input.maxTokens ?? defaultMaxTokens;

    // Convert content blocks to Anthropic SDK format
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content: any[] = input.userContent.map(block => {
      if (block.type === 'text') {
        return { type: 'text' as const, text: block.text };
      }
      return {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: block.source.media_type as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
          data: block.source.data,
        },
      };
    });

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: input.systemPrompt,
      messages: [{ role: 'user', content }],
    });

    // Extract text from response
    const texts: string[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        texts.push(block.text);
      }
    }
    return texts.join('\n');
  };
}
