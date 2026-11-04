import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class LocalStore {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.filesDir = path.join(dataDir, 'files');
    fs.mkdirSync(this.filesDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'rag.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=NORMAL;');
    this.db.exec('CREATE TABLE IF NOT EXISTS records (type TEXT NOT NULL, id TEXT NOT NULL, collection_id TEXT, created_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(type,id));');
    this.db.exec('CREATE INDEX IF NOT EXISTS records_type_collection ON records(type,collection_id);');
  }

  put(type, value) {
    const row = {
      ...value,
      createdAt: value.createdAt ?? new Date().toISOString(),
      updatedAt: value.updatedAt ?? new Date().toISOString(),
    };
    this.db.prepare('INSERT INTO records(type,id,collection_id,created_at,data) VALUES(?,?,?,?,?) ON CONFLICT(type,id) DO UPDATE SET collection_id=excluded.collection_id, created_at=excluded.created_at, data=excluded.data')
      .run(type, row.id, row.collectionId ?? null, row.createdAt, JSON.stringify(row));
    return row;
  }

  get(type, id) {
    const row = this.db.prepare('SELECT data FROM records WHERE type=? AND id=?').get(type, id);
    return row ? JSON.parse(row.data) : null;
  }

  all(type, collectionId = null) {
    const rows = collectionId == null
      ? this.db.prepare('SELECT data FROM records WHERE type=?').all(type)
      : this.db.prepare('SELECT data FROM records WHERE type=? AND collection_id=?').all(type, collectionId);
    return rows.map((row) => JSON.parse(row.data));
  }

  delete(type, id) {
    return this.db.prepare('DELETE FROM records WHERE type=? AND id=?').run(type, id).changes > 0;
  }

  deleteWhere(type, predicate, collectionId = null) {
    const items = this.all(type, collectionId).filter(predicate);
    const del = this.db.prepare('DELETE FROM records WHERE type=? AND id=?');
    for (const item of items) del.run(type, item.id);
    return items;
  }

  replaceChunks(document, chunks) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.deleteWhere('chunk', (c) => c.documentId === document.id, document.collectionId);
      for (const chunk of chunks) this.put('chunk', chunk);
      this.put('document', { ...document, status: 'ready', progress: 100, chunkCount: chunks.length, error: null, updatedAt: new Date().toISOString() });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  page(items, limit = 20, cursor = null) {
    const max = Number(limit);
    if (!Number.isInteger(max) || max < 1 || max > 100) throw Object.assign(new Error('limit must be 1 to 100'), { status: 400, code: 'VALIDATION_ERROR', details: { limit: 'Use an integer from 1 to 100.' } });
    const sorted = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    let offset = 0;
    if (cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!Number.isInteger(parsed.offset) || parsed.offset < 0 || parsed.count !== sorted.length || parsed.offset > sorted.length) throw new Error();
        offset = parsed.offset;
      } catch {
        throw Object.assign(new Error('Invalid or stale cursor'), { status: 400, code: 'VALIDATION_ERROR', details: { cursor: 'Invalid or stale cursor.' } });
      }
    }
    const nextOffset = offset + max;
    return {
      items: sorted.slice(offset, nextOffset),
      nextCursor: nextOffset < sorted.length ? Buffer.from(JSON.stringify({ offset: nextOffset, count: sorted.length })).toString('base64url') : null,
    };
  }

  close() { this.db.close(); }
}
