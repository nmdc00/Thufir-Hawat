#!/usr/bin/env tsx
import { openDatabase, closeDatabase } from '../src/memory/db.js';
import { applyRetentionPolicies } from '../src/memory/retention.js';
import '../src/memory/decision_artifacts.js';
import '../src/memory/opportunity_rank_logs.js';
import '../src/memory/llm_entry_gate_log.js';

function parseDbPath(argv: string[]): string | undefined {
  const dbArg = argv.find((arg) => arg.startsWith('--db='));
  return dbArg ? dbArg.slice('--db='.length) : undefined;
}

const dbPath = parseDbPath(process.argv.slice(2));
const db = openDatabase(dbPath);

try {
  const beforePages = db.prepare('PRAGMA page_count').get() as Record<string, unknown>;
  const beforeFreelist = db.prepare('PRAGMA freelist_count').get() as Record<string, unknown>;
  const result = applyRetentionPolicies(db);
  console.log(`Retention delete counts: ${JSON.stringify(result.countsByTable)}`);
  console.log(`Incremental vacuum status: ${result.vacuum.message}`);
  console.log(
    `Before VACUUM: page_count=${Object.values(beforePages)[0] ?? 0} freelist_count=${Object.values(beforeFreelist)[0] ?? 0}`
  );
  console.log('Running VACUUM. This can take a long time on the production backlog.');
  db.exec('VACUUM');
  const afterPages = db.prepare('PRAGMA page_count').get() as Record<string, unknown>;
  const afterFreelist = db.prepare('PRAGMA freelist_count').get() as Record<string, unknown>;
  console.log(
    `After VACUUM: page_count=${Object.values(afterPages)[0] ?? 0} freelist_count=${Object.values(afterFreelist)[0] ?? 0}`
  );
} finally {
  closeDatabase(dbPath);
}
