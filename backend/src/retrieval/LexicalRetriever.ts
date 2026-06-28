import * as fssync from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SearchChunk } from "../knowledge/model.ts";
import { termsFor } from "../knowledge/text.ts";

export class LexicalRetriever {
  search(sqlitePath: string, chunks: SearchChunk[], query: string, limit: number): Promise<Array<{ id: string; score: number }>> {
    return sqliteBm25(sqlitePath, query, limit)
      .then((hits) => hits.length > 0 ? hits : bm25(chunks, query))
      .catch(() => bm25(chunks, query));
  }
}

function bm25(chunks: SearchChunk[], query: string): Array<{ id: string; score: number }> {
  const terms = termsFor(query);
  const docs = chunks.map((chunk) => ({
    id: chunk.id,
    terms: termsFor(`${chunk.title ?? ""} ${chunk.heading ?? ""} ${chunk.tags.join(" ")} ${chunk.body}`),
  }));
  const avgLen = docs.reduce((sum, doc) => sum + doc.terms.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const term of new Set(docs.flatMap((doc) => [...new Set(doc.terms)]))) {
    df.set(term, docs.filter((doc) => doc.terms.includes(term)).length);
  }
  return docs.map((doc) => {
    let score = 0;
    for (const term of terms) {
      const freq = doc.terms.filter((value) => value === term).length;
      if (!freq) continue;
      const idf = Math.log(1 + (docs.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      score += idf * ((freq * 2.2) / (freq + 1.2 * (0.25 + 0.75 * (doc.terms.length / Math.max(avgLen, 1)))));
    }
    return { id: doc.id, score };
  }).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score);
}

async function sqliteBm25(sqlitePath: string, query: string, limit: number): Promise<Array<{ id: string; score: number }>> {
  const expression = ftsExpression(query);
  if (!expression) return [];
  if (!fssync.existsSync(sqlitePath)) return [];
  const db = new DatabaseSync(sqlitePath);
  try {
    const rows = db.prepare(`SELECT sc.chunk_id AS id, -bm25(search_chunks_fts, 10.0, 8.0, 6.0, 4.0, 7.0, 1.0) AS score
      FROM search_chunks_fts
      JOIN search_chunks AS sc ON sc.rowid = search_chunks_fts.rowid
      WHERE search_chunks_fts MATCH ?
      ORDER BY bm25(search_chunks_fts, 10.0, 8.0, 6.0, 4.0, 7.0, 1.0), sc.chunk_id
      LIMIT ?`).all(expression, limit) as Array<{ id: string; score: number }>;
    return rows.map((row) => ({ id: row.id, score: row.score }));
  } finally {
    db.close();
  }
}

function ftsExpression(query: string): string {
  return [...new Set(termsFor(query))]
    .filter((term) => /^[\p{Letter}\p{Number}_-]+$/u.test(term))
    .slice(0, 20)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}
