import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OfficeParser } from 'officeparser';
import { parseDocument } from './parser.mjs';

test('common document formats produce searchable text and source coordinates', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pro-rag-parser-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const markdown = '# Warranty\n\nWarranty coverage lasts 24 months from purchase.\n';
  const mdPath = join(dir, 'warranty.md');
  writeFileSync(mdPath, markdown);
  const ast = await OfficeParser.parseOffice(mdPath);
  for (const format of ['pdf', 'docx', 'pptx', 'xlsx']) {
    const output = await ast.to(format, format === 'pdf' ? { pdfConfig: { engine: 'native' } } : {});
    writeFileSync(join(dir, `warranty.${format}`), Buffer.from(output.value));
  }
  writeFileSync(join(dir, 'warranty.csv'), 'Topic,Value\nWarranty,24 months\n');
  writeFileSync(join(dir, 'metrics.csv'), 'month,region,tickets\n2026-07,South,100\n2026-08,South,110\n');
  writeFileSync(join(dir, 'warranty.txt'), 'Warranty coverage lasts 24 months from purchase.\n');
  writeFileSync(join(dir, 'warranty.html'), '<h1>Warranty</h1><p>Warranty coverage lasts 24 months from purchase.</p>');
  for (const format of ['pdf', 'docx', 'pptx', 'xlsx', 'csv', 'txt', 'md', 'html']) {
    const parsed = await parseDocument(join(dir, `warranty.${format}`), format);
    assert.ok(parsed.parts.length, `${format} should yield chunks`);
    assert.match(parsed.parts.map((part) => part.text).join(' '), /Warranty|24 months/i, `${format} text`);
    if (format === 'pdf') assert.ok(parsed.parts.some((part) => part.location.page != null), 'PDF page');
    if (format === 'pptx') assert.ok(parsed.parts.some((part) => part.location.slide != null), 'PPTX slide');
    if (format === 'xlsx') assert.ok(parsed.parts.some((part) => part.location.sheet != null), 'XLSX sheet');
  }
  const metrics = await parseDocument(join(dir, 'metrics.csv'), 'csv');
  assert.equal(metrics.parts.length, 2);
  assert.deepEqual(metrics.parts.map((part) => part.location.row), [2, 3]);
  assert.match(metrics.parts[1].text, /month: 2026-08; region: South; tickets: 110/);
  assert.doesNotMatch(metrics.parts[1].text, /100/);
  const xlsx = await parseDocument(join(fileURLToPath(new URL('../tests/integration/fixtures/metrics.xlsx', import.meta.url))), 'xlsx');
  assert.ok(xlsx.parts.some((part) => /Metric: Revenue; Value: 120000/.test(part.text)));
});
