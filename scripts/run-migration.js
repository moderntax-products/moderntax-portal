#!/usr/bin/env node
/**
 * Database Migration Runner
 * Reads DATABASE_URL from .env.local or env var
 *
 * Usage:
 *   node scripts/run-migration.js <migration-file.sql>
 *   e.g., node scripts/run-migration.js supabase/migration-expert-system.sql
 */
require('dotenv').config({ path: '.env.local' });

const { Client } = require('pg');
const fs = require('fs');

const sqlFile = process.argv[2];
if (!sqlFile) {
  console.error('Usage: node scripts/run-migration.js <sql-file>');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL not set in .env.local');
  process.exit(1);
}

async function runMigration() {
  const client = new Client({ connectionString });

  try {
    await client.connect();
    console.log('Connected to database');

    const sql = fs.readFileSync(sqlFile, 'utf8');
    await client.query(sql);
    console.log('Migration completed successfully');
  } catch (err) {
    console.error('Migration error:', err.message);
    console.log('\nRetrying individual statements...');

    const sql = fs.readFileSync(sqlFile, 'utf8');
    const lines = sql.split('\n');
    let currentStmt = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('--') && currentStmt.trim() === '') continue;
      currentStmt += line + '\n';

      if (trimmed.endsWith(';')) {
        const stmt = currentStmt.trim();
        if (stmt && stmt !== ';') {
          try {
            await client.query(stmt);
            console.log('OK:', stmt.substring(0, 70).replace(/\n/g, ' '));
          } catch (stmtErr) {
            console.error('ERR:', stmtErr.message, '|', stmt.substring(0, 60).replace(/\n/g, ' '));
          }
        }
        currentStmt = '';
      }
    }
    console.log('Individual statements done');
  } finally {
    await client.end();
  }
}

runMigration();
