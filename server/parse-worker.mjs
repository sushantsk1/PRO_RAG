import { parseDocument } from './parser.mjs';

process.on('message', async ({ filePath, format, options }) => {
  try {
    const value = await parseDocument(filePath, format, options);
    process.send?.({ ok: true, value }, () => process.exit(0));
  } catch (cause) {
    process.send?.({ ok: false, code: cause.code ?? 'PARSER_FAILED', message: String(cause.message ?? 'Document parsing failed.').slice(0, 220) }, () => process.exit(1));
  }
});
