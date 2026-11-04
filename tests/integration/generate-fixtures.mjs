/** Deterministic, dependency-free Office/PDF/text fixtures for integration tests. */
import { deflateRawSync, deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const outputDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

const crcTable = Array.from({ length: 256 }, (_, start) => {
  let value = start;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const localBytes = Buffer.concat([local, nameBytes, compressed]);
    locals.push(localBytes);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([dir, nameBytes]));
    offset += localBytes.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

function pdf(objects) {
  const parts = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  let offset = parts[0].length;
  for (let index = 0; index < objects.length; index++) {
    offsets.push(offset);
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), objects[index], Buffer.from('\nendobj\n')]);
    parts.push(object);
    offset += object.length;
  }
  const xrefOffset = offset;
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`];
  for (const position of offsets.slice(1)) xref.push(`${String(position).padStart(10, '0')} 00000 n \n`);
  xref.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  parts.push(Buffer.from(xref.join('')));
  return Buffer.concat(parts);
}

function stream(data, extra = '') {
  return Buffer.concat([Buffer.from(`<< /Length ${data.length} ${extra} >>\nstream\n`), data, Buffer.from('\nendstream')]);
}

function textPdf() {
  const text = 'Harbor shipping is free on orders above 50 dollars.';
  const commands = Buffer.from(`BT /F1 16 Tf 72 720 Td (${text}) Tj ET\n`);
  return pdf([
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'),
    stream(commands),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  ]);
}

const font = {
  A:['01110','10001','10001','11111','10001','10001','10001'],
  C:['01111','10000','10000','10000','10000','10000','01111'],
  D:['11110','10001','10001','10001','10001','10001','11110'],
  E:['11111','10000','10000','11110','10000','10000','11111'],
  F:['11111','10000','10000','11110','10000','10000','10000'],
  N:['10001','11001','10101','10011','10001','10001','10001'],
  O:['01110','10001','10001','10001','10001','10001','01110'],
  P:['11110','10001','10001','11110','10000','10000','10000'],
  R:['11110','10001','10001','11110','10100','10010','10001'],
  S:['01111','10000','10000','01110','00001','00001','11110'],
  W:['10001','10001','10001','10101','10101','10101','01010'],
  ' ':['00000','00000','00000','00000','00000','00000','00000']
};

function scannedPdf() {
  const phrase = 'SCANNED PROOF';
  const width = 800;
  const height = 160;
  const scale = 7;
  const pixels = Buffer.alloc(width * height, 255);
  let x = 35;
  for (const character of phrase) {
    const glyph = font[character];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] !== '1') continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) pixels[(42 + row * scale + dy) * width + x + col * scale + dx] = 0;
        }
      }
    }
    x += 6 * scale;
  }
  const image = deflateSync(pixels);
  const commands = Buffer.from('q 540 0 0 108 36 650 cm /Im0 Do Q\n');
  return pdf([
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>'),
    stream(commands),
    stream(image, `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`)
  ]);
}

function docx() {
  const fact = xml('The Apollo return window is 42 days after delivery.');
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${fact}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`]
  ]);
}

function pptx() {
  const fact = xml('Project Nova launches in July 2026.');
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>'],
    ['ppt/presentation.xml', '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>'],
    ['ppt/_rels/presentation.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'],
    ['ppt/slides/slide1.xml', `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${fact}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`]
  ]);
}

function xlsx() {
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Metrics" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Metric</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Revenue</t></is></c><c r="B2"><v>120000</v></c></row></sheetData></worksheet>']
  ]);
}

await mkdir(outputDir, { recursive: true });
const fixtures = [
  ['shipping.pdf', textPdf()],
  ['scanned.pdf', scannedPdf()],
  ['returns.docx', docx()],
  ['launch.pptx', pptx()],
  ['metrics.xlsx', xlsx()],
  ['products.csv', 'product,region,inventory\nBeacon,West,73\nOrbit,East,28\n'],
  ['policy.txt', 'Aster warranty coverage lasts 24 months from the date of purchase.\n'],
  ['onboarding.md', '# Onboarding\nThe Helix onboarding owner is Priya Shah.\n'],
  ['incident.html', '<!doctype html><html><head><title>Incident response</title></head><body><h1>Incident response</h1><p>The first escalation step is to page the on-call engineer.</p></body></html>'],
  ['conflict-a.txt', 'The Helix support desk closes at 18:00 on weekdays.\n'],
  ['conflict-b.txt', 'The Helix support desk closes at 20:00 on weekdays.\n'],
  ['incremental.txt', 'The Lyra retention policy keeps records for 90 days.\n'],
  ['empty.txt', ''],
  ['broken.pdf', '%PDF-1.4\nnot a real PDF'],
  ['unsupported.bin', Buffer.from([0, 1, 2, 3, 4])]
];
for (const [name, content] of fixtures) await writeFile(path.join(outputDir, name), content);
console.log(`Generated ${fixtures.length} fixtures in ${outputDir}`);
