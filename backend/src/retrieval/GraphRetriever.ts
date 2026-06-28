import * as fssync from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { GraphHit, GraphQueryPlan, SupportingRelation } from "../knowledge/model.ts";
import { normalizeGraphText } from "../knowledge/text.ts";
import { normalizeWhitespace } from "../util.ts";

export class GraphRetriever {
  wantsTraversal(query: string): boolean {
    return Boolean(graphQueryPlan(query));
  }

  search(sqlitePath: string, query: string, limit: number): Promise<GraphHit[]> {
    return sqliteGraphHits(sqlitePath, query, limit);
  }
}

async function sqliteGraphHits(sqlitePath: string, query: string, limit: number): Promise<GraphHit[]> {
  const plan = graphQueryPlan(query);
  if (!plan) return [];
  if (!fssync.existsSync(sqlitePath)) return [];
  const db = new DatabaseSync(sqlitePath);
  try {
    const rows = db.prepare(`SELECT chunk_id, subject, predicate, object, subject_norm, predicate_norm, object_norm, evidence_count
      FROM search_graph_edges
      ORDER BY chunk_id, predicate, subject, object
      LIMIT 2500`).all() as Array<{
        chunk_id: string;
        subject: string;
        predicate: string;
        object: string;
        subject_norm: string;
        predicate_norm: string;
        object_norm: string;
        evidence_count: number;
      }>;
    const byChunk = new Map<string, { score: number; relations: SupportingRelation[] }>();
    for (const row of rows) {
      const matched = graphMatchScore(row, plan);
      if (matched <= 0) continue;
      const evidence = Math.max(1, Number(row.evidence_count) || 1);
      const contribution = matched * (1 + Math.log(evidence));
      const current = byChunk.get(row.chunk_id) ?? { score: 0, relations: [] };
      current.score += contribution;
      current.relations.push({ subject: row.subject, predicate: row.predicate, object: row.object, evidence_count: evidence });
      byChunk.set(row.chunk_id, current);
    }
    const max = Math.max(1, ...[...byChunk.values()].map((hit) => hit.score));
    return [...byChunk.entries()]
      .map(([id, hit]) => ({
        id,
        score: hit.score / max,
        relations: topRelations(hit.relations),
      }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
  } finally {
    db.close();
  }
}

function graphMatchScore(row: { subject_norm: string; predicate_norm: string; object_norm: string }, plan: GraphQueryPlan): number {
  if (row.predicate_norm !== normalizeGraphText(plan.predicate)) return 0;
  const haystack = plan.knownSide === "subject" ? row.subject_norm : row.object_norm;
  const matches = plan.knownTerms.filter((term) => haystack.includes(term)).length;
  if (matches === 0) return 0;
  const score = matches / Math.max(1, plan.knownTerms.length);
  return score >= graphMatchThreshold(plan.knownTerms.length) ? score : 0;
}

function wantsGraphTraversal(query: string): boolean {
  return Boolean(graphQueryPlan(query));
}

function graphQueryPlan(query: string): GraphQueryPlan | null {
  const relation = graphRelationMatch(query);
  if (!relation) return null;
  const normalized = normalizeWhitespace(query.trim());
  const lower = normalized.toLowerCase();
  const objectDirection = /^(?:what|which|who)\s+(?:endpoints?|interfaces?|commands?|apis?|routes?|entrypoints?)\s+/u.test(lower);
  const subjectQuestion = lower.match(/^(?:what|which)\s+(?:methods?|functions?|apis?)\s+(?:does|do)\s+(.+?)\s+(?:use|uses|used|using|invoke|invokes|invoked|invoking|call|calls|called|calling)\b/u);
  const knownText = subjectQuestion?.[1]
    ?? (objectDirection ? normalized.slice(relation.index + relation.word.length) : normalized.slice(0, relation.index));
  const cleaned = cleanGraphKnownText(knownText);
  const knownTerms = graphKnownTerms(cleaned);
  if (knownTerms.length === 0) return null;
  return {
    predicate: "uses_l3_method",
    knownSide: objectDirection && !subjectQuestion ? "object" : "subject",
    knownText: cleaned,
    knownTerms,
  };
}

function graphRelationMatch(query: string): { word: string; index: number } | null {
  const match = /\b(use|uses|used|using|invoke|invokes|invoked|invoking|call|calls|called|calling)\b/iu.exec(query);
  return match?.[0] ? { word: match[0], index: match.index } : null;
}

function cleanGraphKnownText(text: string): string {
  return text
    .replace(/^[\s:,-]+|[\s:,.?;!-]+$/gu, "")
    .replace(/^(?:the|a|an)\s+/iu, "")
    .replace(/\s+(?:method|methods|function|functions|api|apis|endpoint|endpoints|interface|interfaces|command|commands)$/iu, "")
    .trim();
}

function graphKnownTerms(text: string): string[] {
  const stop = new Set(["what", "which", "who", "does", "do", "the", "a", "an", "method", "methods", "function", "functions", "api", "apis", "endpoint", "endpoints", "interface", "interfaces", "command", "commands", "use", "uses", "used", "using", "invoke", "invokes", "invoked", "invoking", "call", "calls", "called", "calling"]);
  return [...new Set(normalizeGraphText(text).split(/\s+/u).filter((term) => term && !stop.has(term)))].slice(0, 20);
}

function graphMatchThreshold(termCount: number): number {
  if (termCount <= 2) return 1;
  return 0.67;
}

function topRelations(relations: SupportingRelation[]): SupportingRelation[] {
  const unique = new Map<string, SupportingRelation>();
  for (const relation of relations) {
    const key = `${relation.subject}\0${relation.predicate}\0${relation.object}`;
    const existing = unique.get(key);
    if (!existing || relation.evidence_count > existing.evidence_count) unique.set(key, relation);
  }
  return [...unique.values()]
    .sort((a, b) => b.evidence_count - a.evidence_count || a.predicate.localeCompare(b.predicate) || a.subject.localeCompare(b.subject))
    .slice(0, 3);
}
