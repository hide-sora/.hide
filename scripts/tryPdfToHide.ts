/**
 * tryPdfToHide.ts — PDF → .hide 変換テスト実行スクリプト
 *
 * Usage: npx tsx scripts/tryPdfToHide.ts <pdf-path> [--no-llm]
 *
 * Audiveris がインストールされている必要があります。
 * LLM レビューには ANTHROPIC_API_KEY 環境変数が必要です。
 */
import { writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { pdfToHideFromFile } from '../src/pdfToHide';

const args = process.argv.slice(2);
const noLlm = args.includes('--no-llm');
const pdfPath = args.find(a => !a.startsWith('--'));

if (!pdfPath) {
  console.error('Usage: npx tsx scripts/tryPdfToHide.ts <pdf-path> [--no-llm]');
  process.exit(1);
}

const resolved = resolve(pdfPath);
console.log(`[input] ${resolved}`);
console.log(`[llm-review] ${noLlm ? 'disabled' : 'enabled'}`);

try {
  const result = await pdfToHideFromFile(resolved, {
    enableLlmReview: !noLlm,
    onProgress: (phase, detail) => console.log(`  [${phase}] ${detail}`),
  });

  console.log('\n=== Result ===');
  console.log(`Parts: ${result.partsCount}`);
  console.log(`Measures: ${result.measuresCount}`);
  console.log(`Pages: ${result.pageCount}`);
  console.log(`Warnings: ${result.warnings.length}`);
  console.log(`Diagnostics: ${result.diagnostics.length}`);
  if (result.llmReview) {
    console.log(`LLM modified: ${result.llmReview.wasModified}`);
    if ('fallbackCount' in result.llmReview) {
      console.log(`LLM fallbacks: ${result.llmReview.fallbackCount} measures reverted to draft`);
    }
  }

  if (result.warnings.length > 0) {
    console.log('\nWarnings (first 10):');
    for (const w of result.warnings.slice(0, 10)) {
      console.log(`  - ${w}`);
    }
    if (result.warnings.length > 10) {
      console.log(`  ... and ${result.warnings.length - 10} more`);
    }
  }

  // Output .hide source
  const outName = basename(resolved, '.pdf') + '.hide';
  const outPath = resolve(process.cwd(), outName);
  writeFileSync(outPath, result.hideSource, 'utf8');
  console.log(`\n[output] ${outPath}`);

  // Also save draft if LLM modified
  if (result.llmReview?.wasModified) {
    const draftPath = resolve(process.cwd(), basename(resolved, '.pdf') + '.draft.hide');
    writeFileSync(draftPath, result.draftHideSource, 'utf8');
    console.log(`[draft]  ${draftPath}`);
  }

  console.log('\n--- .hide source (first 10 lines) ---');
  const lines = result.hideSource.split('\n');
  for (const line of lines.slice(0, 10)) {
    console.log(line.length > 200 ? line.slice(0, 200) + '...' : line);
  }
  if (lines.length > 10) {
    console.log(`... (${lines.length - 10} more lines)`);
  }
} catch (err) {
  console.error('\n[ERROR]', (err as Error).message);
  console.error((err as Error).stack);
  process.exit(1);
}
