import path from 'node:path';
import { OfficeParser } from 'officeparser';

export const SUPPORTED_FORMATS = ['pdf', 'docx', 'pptx', 'xlsx', 'csv', 'txt', 'md', 'html'];
export const FORMAT_MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', html: 'text/html',
};

export function formatOf(name) {
  return path.extname(name).slice(1).toLowerCase();
}

function locationOf(meta = {}, format) {
  const page = meta.pageNumber ?? null;
  const slide = meta.slideNumber ?? null;
  const sheet = meta.sheetName ?? null;
  const row = meta.rowNumber ?? null;
  const heading = meta.closestHeading ?? null;
  const type = page != null ? 'page' : slide != null ? 'slide' : sheet != null ? 'sheet' : heading ? 'heading' : format === 'txt' ? 'line' : 'unknown';
  return { type, page, slide, sheet, row, heading };
}

function splitPlain(text, size = 900, overlap = 140) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + size);
    if (end < normalized.length) {
      const cut = normalized.lastIndexOf(' ', end);
      if (cut > start + size / 2) end = cut;
    }
    chunks.push({ text: normalized.slice(start, end).trim(), metadata: { lineNumber: normalized.slice(0, start).split('\n').length } });
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks.filter((c) => c.text.length > 0);
}

function tableParts(content) {
  const parts = [];
  for (const sheet of content ?? []) {
    if (sheet.type !== 'sheet') continue;
    const sheetName = sheet.metadata?.sheetName ?? 'Sheet1';
    const rows = (sheet.children ?? []).filter((node) => node.type === 'row');
    const values = (row) => new Map((row.children ?? [])
      .filter((cell) => cell.type === 'cell')
      .map((cell) => [cell.metadata?.col, String(cell.text ?? '').trim()]));
    const headers = values(rows[0] ?? { children: [] });
    for (let index = 1; index < rows.length; index++) {
      const row = rows[index];
      const cells = values(row);
      const columns = [...new Set([...headers.keys(), ...cells.keys()])].sort((a, b) => a - b);
      const text = columns.filter((col) => cells.get(col)).map((col) => {
        const label = headers.get(col) || `Column ${Number(col) + 1}`;
        return `${label}: ${cells.get(col)}`;
      }).join('; ');
      if (text) parts.push({
        text,
        location: { type: 'sheet', page: null, slide: null, sheet: sheetName,
          row: Number(row.children?.find((cell) => cell.type === 'cell')?.metadata?.row ?? index) + 1,
          heading: null },
      });
    }
    if (rows.length === 1 && headers.size) {
      const text = [...headers.values()].filter(Boolean).join('; ');
      if (text) parts.push({ text, location: { type: 'sheet', page: null, slide: null, sheet: sheetName, row: 1, heading: null } });
    }
  }
  return parts;
}

export async function parseDocument(filePath, format, { ocr = false } = {}) {
  if (!SUPPORTED_FORMATS.includes(format)) throw Object.assign(new Error('Unsupported document format'), { code: 'UNSUPPORTED_FORMAT' });
  if (format === 'txt') {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(filePath, 'utf8');
    const parts = splitPlain(text);
    if (!parts.length) throw new Error('No searchable text found in the file.');
    return { parts: parts.map((p) => ({ text: p.text, location: { ...locationOf({}, format), row: p.metadata.lineNumber } })), mode: 'text', warning: null, ocrVerified: false };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ocr ? 120000 : 45000);
  try {
    const ast = await OfficeParser.parseOffice(filePath, {
      abortSignal: controller.signal,
      ocr,
      extractAttachments: ocr,
      ocrConfig: { timeout: { workerLoad: 30000, recognition: 15000, autoTerminate: 10000 } },
    });
    const result = ['csv', 'xlsx'].includes(format) ? null : await ast.to('chunks', { chunksConfig: { strategy: 'document-structure', maxChunkSize: 900, tableSplitStrategy: 'row' } });
    const parts = result
      ? (result.value ?? []).map((chunk) => ({ text: String(chunk.text ?? '').trim(), location: locationOf(chunk.metadata, format) })).filter((chunk) => chunk.text)
      : tableParts(ast.content);
    if (!parts.length) {
      const codes = (ast.warnings ?? []).map((w) => w.code);
      if (ocr && codes.some((code) => /OCR/.test(code))) throw Object.assign(new Error('Local OCR could not extract text. Check OCR language assets and retry.'), { code: 'OCR_UNAVAILABLE' });
      throw new Error(ocr ? 'No searchable text found after local OCR.' : 'No searchable text found. Try OCR for a scanned PDF.');
    }
    const warnings = [...(ast.warnings ?? []), ...(result?.messages ?? [])].filter((w) => w.type === 'warning').map((w) => w.message);
    const ocrVerified = ocr && (ast.attachments ?? []).some((attachment) => typeof attachment.ocrText === 'string' && attachment.ocrText.trim());
    return { parts, mode: ocrVerified ? 'mixed' : 'text', warning: warnings.slice(0, 2).join(' ') || null, ocrVerified: Boolean(ocrVerified) };
  } finally {
    clearTimeout(timeout);
  }
}
