#!/usr/bin/env npx tsx
/**
 * Migrate Centerstone Dropbox Files to Database + Supabase Storage
 *
 * Scans all Centerstone processor folders in Dropbox, parses transcript
 * filenames and HTML content, creates DB records, uploads files to
 * Supabase storage, and runs compliance screening.
 *
 * Usage:
 *   npx tsx scripts/migrate-centerstone-dropbox.ts                    # full migration
 *   npx tsx scripts/migrate-centerstone-dropbox.ts --dry-run          # preview only
 *   npx tsx scripts/migrate-centerstone-dropbox.ts --processor "Andrew Yu"  # single processor
 *   npx tsx scripts/migrate-centerstone-dropbox.ts --loan 18015       # single loan
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import {
  screenTranscriptHtml,
  parseTranscriptMetadata,
  parseFilename,
} from '../lib/compliance-screening';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DROPBOX_ROOT = path.join(
  process.env.HOME || '/Users/matthewparker',
  'Library/CloudStorage/Dropbox/teamcenterstone.com'
);

const CENTERSTONE_CLIENT_ID = '60f80d60-03ad-42d7-95da-c0f1cd311523';
const ADMIN_USER_ID = '4a62ae4c-c3c4-4399-87e1-63f4f6851153'; // matt@moderntax.io

const PROCESSOR_MAP: Record<string, string> = {
  'Andrew Yu Requests': '1c741bf2-2da3-43f3-8e55-817944f50d15',
  'Robin Kim Requests': '61aa35ba-c684-42cb-b064-7b8dbc4956b2',
  'Soobin Song Requests': 'ccae8b19-5f52-4c3a-8431-6bcaeec11a65',
  'Justin Kim Requests': 'f276c394-26e5-4a83-992a-0217ec49b0fa',
  'Timothy Suk Requests': '776be82d-4acf-4a2f-b9db-f818cedf2a43',
  // Deactivated processors → assign to admin
  'Christopher Ahn Requests (deactivated)': ADMIN_USER_ID,
  'Katie Kim Requests (deactivated)': ADMIN_USER_ID,
};

// Skip these folders — not transcript data
const SKIP_FOLDERS = ['Centerstone Orders', 'Mathew Peake Referals (ModernTax)'];

// Rate limit: ms between Supabase storage uploads
const UPLOAD_DELAY_MS = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MigrationStats {
  processorsScanned: number;
  loanFoldersScanned: number;
  entityFoldersScanned: number;
  filesProcessed: number;
  filesUploaded: number;
  filesSkipped: number;
  requestsCreated: number;
  entitiesCreated: number;
  entitiesUpdated: number;
  complianceFlags: number;
  errors: { path: string; error: string }[];
}

interface EntityRecord {
  id: string;
  entity_name: string;
  tid: string;
  form_type: string;
  transcript_urls: string[];
  transcript_html_urls: string[];
  gross_receipts: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractLoanNumber(folderName: string): { loanNumber: string; borrowerName: string } {
  const match = folderName.match(/^(\d+)\s+(.+)/);
  if (match) {
    return { loanNumber: match[1], borrowerName: match[2] };
  }
  // No loan number in folder name — use folder name as borrower
  return { loanNumber: '', borrowerName: folderName };
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 200);
}

/** Map transcript type string to the gross_receipts key short type */
function shortTypeKey(transcriptType: string): string {
  switch (transcriptType) {
    case 'return_transcript': return 'RT';
    case 'record_of_account': return 'RoA';
    case 'entity_transcript': return 'Entity';
    case 'wage_income': return 'W2';
    case 'account_transcript': return 'AT';
    default: return 'Other';
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main migration
// ---------------------------------------------------------------------------

async function migrate() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const processorFilter = args.includes('--processor')
    ? args[args.indexOf('--processor') + 1]
    : null;
  const loanFilter = args.includes('--loan')
    ? args[args.indexOf('--loan') + 1]
    : null;

  console.log('=== Centerstone Dropbox Migration ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
  if (processorFilter) console.log(`Processor filter: ${processorFilter}`);
  if (loanFilter) console.log(`Loan filter: ${loanFilter}`);
  console.log('');

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const stats: MigrationStats = {
    processorsScanned: 0,
    loanFoldersScanned: 0,
    entityFoldersScanned: 0,
    filesProcessed: 0,
    filesUploaded: 0,
    filesSkipped: 0,
    requestsCreated: 0,
    entitiesCreated: 0,
    entitiesUpdated: 0,
    complianceFlags: 0,
    errors: [],
  };

  // Scan processor folders
  const rootEntries = await readdir(DROPBOX_ROOT);
  const processorFolders = rootEntries.filter(
    (f) => PROCESSOR_MAP[f] && !SKIP_FOLDERS.includes(f)
  );

  for (const processorFolder of processorFolders) {
    if (processorFilter && !processorFolder.toLowerCase().includes(processorFilter.toLowerCase())) {
      continue;
    }

    const processorId = PROCESSOR_MAP[processorFolder];
    const processorPath = path.join(DROPBOX_ROOT, processorFolder);
    stats.processorsScanned++;

    console.log(`\n--- Processor: ${processorFolder} ---`);

    // Check if it's a directory
    const processorStat = await stat(processorPath).catch(() => null);
    if (!processorStat?.isDirectory()) continue;

    // Scan loan folders
    const loanEntries = await readdir(processorPath);

    for (const loanFolder of loanEntries) {
      if (loanFolder.startsWith('.')) continue;

      const loanPath = path.join(processorPath, loanFolder);
      const loanStat = await stat(loanPath).catch(() => null);
      if (!loanStat?.isDirectory()) continue;

      const { loanNumber, borrowerName } = extractLoanNumber(loanFolder);

      if (loanFilter && loanNumber !== loanFilter) continue;

      stats.loanFoldersScanned++;
      console.log(`  Loan: ${loanFolder} (${loanNumber || 'no number'})`);

      // Find or create request in DB
      let requestId: string | null = null;

      if (!dryRun) {
        requestId = await findOrCreateRequest(
          supabase,
          loanNumber || `HIST-${sanitizeFilename(loanFolder)}`,
          borrowerName,
          processorId,
          stats
        );
      }

      // Scan entity subfolders
      const entityEntries = await readdir(loanPath);

      for (const entityFolder of entityEntries) {
        if (entityFolder.startsWith('.')) continue;

        const entityPath = path.join(loanPath, entityFolder);
        const entityStat = await stat(entityPath).catch(() => null);

        if (entityStat?.isDirectory()) {
          // Entity subfolder with files inside
          stats.entityFoldersScanned++;
          await processEntityFolder(
            supabase, entityPath, entityFolder, requestId, stats, dryRun
          );
        } else if (entityStat?.isFile()) {
          // File directly in the loan folder (no entity subfolder)
          // This can happen for single-entity loans
          // Create/use borrowerName as entity name
          if (!requestId && !dryRun) {
            requestId = await findOrCreateRequest(
              supabase,
              loanNumber || `HIST-${sanitizeFilename(loanFolder)}`,
              borrowerName,
              processorId,
              stats
            );
          }
          await processFile(
            supabase, path.join(loanPath, entityFolder), borrowerName,
            requestId, null, stats, dryRun
          );
        }
      }
    }
  }

  // Print summary
  console.log('\n=== Migration Summary ===');
  console.log(`Processors scanned: ${stats.processorsScanned}`);
  console.log(`Loan folders scanned: ${stats.loanFoldersScanned}`);
  console.log(`Entity folders scanned: ${stats.entityFoldersScanned}`);
  console.log(`Files processed: ${stats.filesProcessed}`);
  console.log(`Files uploaded: ${stats.filesUploaded}`);
  console.log(`Files skipped: ${stats.filesSkipped}`);
  console.log(`Requests created: ${stats.requestsCreated}`);
  console.log(`Entities created: ${stats.entitiesCreated}`);
  console.log(`Entities updated: ${stats.entitiesUpdated}`);
  console.log(`Compliance flags found: ${stats.complianceFlags}`);
  if (stats.errors.length > 0) {
    console.log(`\nErrors (${stats.errors.length}):`);
    stats.errors.forEach((e) => console.log(`  ${e.path}: ${e.error}`));
  }
}

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

async function findOrCreateRequest(
  supabase: SupabaseClient,
  loanNumber: string,
  borrowerName: string,
  processorId: string,
  stats: MigrationStats
): Promise<string> {
  // Check if request already exists for this loan
  const { data: existing } = await supabase
    .from('requests')
    .select('id')
    .eq('loan_number', loanNumber)
    .eq('client_id', CENTERSTONE_CLIENT_ID)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle() as { data: { id: string } | null; error: any };

  if (existing) return existing.id;

  // Create new request
  const { data: newReq, error } = await supabase
    .from('requests')
    .insert({
      client_id: CENTERSTONE_CLIENT_ID,
      requested_by: processorId,
      loan_number: loanNumber,
      intake_method: 'manual',
      status: 'completed',
      notes: `Historical import from Dropbox: ${borrowerName}`,
    })
    .select('id')
    .single() as { data: { id: string } | null; error: any };

  if (error || !newReq) {
    console.error(`    ERROR creating request for ${loanNumber}:`, error?.message);
    return '';
  }

  stats.requestsCreated++;
  console.log(`    Created request: ${loanNumber} → ${newReq.id}`);
  return newReq.id;
}

async function findOrCreateEntity(
  supabase: SupabaseClient,
  requestId: string,
  entityName: string,
  tid: string,
  formType: string,
  stats: MigrationStats
): Promise<EntityRecord | null> {
  // First try to match by TID within this request
  if (tid) {
    const { data: byTid } = await supabase
      .from('request_entities')
      .select('id, entity_name, tid, form_type, transcript_urls, transcript_html_urls, gross_receipts')
      .eq('request_id', requestId)
      .eq('tid', tid.replace(/-/g, ''))
      .maybeSingle() as { data: EntityRecord | null; error: any };

    if (byTid) {
      stats.entitiesUpdated++;
      return byTid;
    }
  }

  // Try to match by entity name within this request
  const { data: byName } = await supabase
    .from('request_entities')
    .select('id, entity_name, tid, form_type, transcript_urls, transcript_html_urls, gross_receipts')
    .eq('request_id', requestId)
    .ilike('entity_name', entityName)
    .maybeSingle() as { data: EntityRecord | null; error: any };

  if (byName) {
    stats.entitiesUpdated++;
    return byName;
  }

  // Create new entity — normalize to valid DB values: 1040, 1065, 1120, 1120S
  const validForms = ['1040', '1065', '1120', '1120S'];
  let normalizedForm = formType?.replace(/[\s-]/g, '').toUpperCase() || '1040';
  if (normalizedForm === 'BMF_ENTITY' || normalizedForm === 'W2_INCOME') normalizedForm = '1040';
  if (!validForms.includes(normalizedForm)) {
    // Try stripping FORM prefix
    const stripped = normalizedForm.replace('FORM', '');
    normalizedForm = validForms.includes(stripped) ? stripped : '1040';
  }
  const cleanTid = tid ? tid.replace(/-/g, '') : '';
  const { data: newEntity, error } = await supabase
    .from('request_entities')
    .insert({
      request_id: requestId,
      entity_name: entityName,
      tid: cleanTid,
      tid_kind: cleanTid.length === 9 && cleanTid.length <= 11 ? (cleanTid.match(/^\d{3}\d{2}\d{4}$/) ? 'SSN' : 'EIN') : 'EIN',
      form_type: normalizedForm,
      years: ['2022', '2023', '2024'],
      status: 'completed',
    })
    .select('id, entity_name, tid, form_type, transcript_urls, transcript_html_urls, gross_receipts')
    .single() as { data: EntityRecord | null; error: any };

  if (error || !newEntity) {
    console.error(`    ERROR creating entity ${entityName}:`, error?.message);
    return null;
  }

  stats.entitiesCreated++;
  return newEntity;
}

// ---------------------------------------------------------------------------
// File processing
// ---------------------------------------------------------------------------

async function processEntityFolder(
  supabase: SupabaseClient,
  folderPath: string,
  entityName: string,
  requestId: string | null,
  stats: MigrationStats,
  dryRun: boolean
) {
  const files = await readdir(folderPath);
  const transcriptFiles = files.filter(
    (f) => !f.startsWith('.') && (f.endsWith('.html') || f.endsWith('.pdf'))
  );

  if (transcriptFiles.length === 0) return;

  console.log(`    Entity: ${entityName} (${transcriptFiles.length} files)`);

  // Shared entity record across all files in this folder
  let entityRecord: EntityRecord | null = null;

  for (const file of transcriptFiles) {
    entityRecord = await processFile(
      supabase, path.join(folderPath, file), entityName,
      requestId, entityRecord, stats, dryRun
    );
  }
}

async function processFile(
  supabase: SupabaseClient,
  filePath: string,
  entityName: string,
  requestId: string | null,
  entityRecord: EntityRecord | null,
  stats: MigrationStats,
  dryRun: boolean,
): Promise<EntityRecord | null> {
  const filename = path.basename(filePath);
  const ext = path.extname(filename).toLowerCase();
  stats.filesProcessed++;

  // Skip non-transcript files
  if (ext !== '.html' && ext !== '.pdf') {
    stats.filesSkipped++;
    return entityRecord;
  }

  // Skip signed 8821 PDFs
  if (/8821|consent/i.test(filename)) {
    stats.filesSkipped++;
    return entityRecord;
  }

  // Parse filename for metadata
  const filenameMeta = parseFilename(filename);

  let formType = filenameMeta?.formType || '';
  let taxYear = filenameMeta?.taxYear || '';
  let transcriptType = filenameMeta?.transcriptType || 'unknown';
  let tin = '';
  let complianceData: Record<string, any> | null = null;
  let entityData: Record<string, string> | undefined;

  // For HTML files: parse content for metadata + compliance screening
  if (ext === '.html') {
    try {
      const htmlContent = await readFile(filePath, 'utf-8');
      const meta = parseTranscriptMetadata(htmlContent);

      // Use HTML-extracted metadata as fallback/override
      if (meta.tin) tin = meta.tin;
      if (meta.formType && !formType) formType = meta.formType;
      if (meta.taxYear && !taxYear) taxYear = meta.taxYear;
      if (meta.transcriptType !== 'unknown' && transcriptType === 'unknown') {
        transcriptType = meta.transcriptType;
      }
      if (meta.entityData) entityData = meta.entityData;
      if (meta.taxpayerName && !entityName) entityName = meta.taxpayerName;

      // Run compliance screening
      const screening = screenTranscriptHtml(htmlContent);
      if (screening.flags.length > 0 || screening.financials.grossReceipts !== null) {
        const key = `${formType || 'UNK'}_${shortTypeKey(transcriptType)}_${taxYear || 'UNK'}`;
        complianceData = {
          [key]: {
            severity: screening.severity,
            flags: screening.flags,
            financials: screening.financials,
            screened_at: new Date().toISOString(),
          },
        };
        stats.complianceFlags += screening.flags.length;

        if (screening.flags.length > 0) {
          console.log(`      ${filename}: ${screening.severity} (${screening.flags.length} flags)`);
        }
      }

      // Entity transcript data
      if (entityData && Object.keys(entityData).length > 0) {
        complianceData = complianceData || {};
        complianceData['entity_transcript'] = {
          ...entityData,
          retrieved_at: new Date().toISOString(),
        };
      }
    } catch (err) {
      stats.errors.push({ path: filePath, error: `HTML parse error: ${err}` });
    }
  }

  if (dryRun) {
    console.log(`      [DRY RUN] ${filename} → form=${formType} year=${taxYear} type=${transcriptType} tin=${tin ? '***' + tin.slice(-4) : 'N/A'}`);
    return entityRecord;
  }

  if (!requestId) return entityRecord;

  // Find or create entity
  if (!entityRecord) {
    entityRecord = await findOrCreateEntity(
      supabase, requestId, entityName, tin, formType, stats
    );
  }

  if (!entityRecord) return entityRecord;

  // Update entity TID if we extracted one and entity doesn't have it
  if (tin && !entityRecord.tid) {
    await supabase
      .from('request_entities')
      .update({ tid: tin.replace(/-/g, '') })
      .eq('id', entityRecord.id);
  }

  // Check for duplicate — skip if already uploaded
  const existingUrls = [
    ...(entityRecord.transcript_urls || []),
    ...(entityRecord.transcript_html_urls || []),
  ];
  const filenameStem = filename.replace(/\.\w+$/, '');
  if (existingUrls.some((u: string) => u.includes(filenameStem))) {
    stats.filesSkipped++;
    return entityRecord;
  }

  // Upload file to Supabase storage
  try {
    const fileBuffer = await readFile(filePath);
    const storagePath = `transcripts/${entityRecord.id}/${Date.now()}-${sanitizeFilename(filename)}`;
    const contentType = ext === '.html' ? 'text/html' : 'application/pdf';

    const { error: uploadError } = await supabase.storage
      .from('uploads')
      .upload(storagePath, fileBuffer, {
        contentType,
        upsert: true,
      });

    if (uploadError) {
      stats.errors.push({ path: filePath, error: `Upload error: ${uploadError.message}` });
      return entityRecord;
    }

    stats.filesUploaded++;

    // Append to appropriate URL array
    const urlField = ext === '.html' ? 'transcript_html_urls' : 'transcript_urls';
    const currentUrls = entityRecord[urlField as keyof EntityRecord] as string[] || [];
    const updatedUrls = [...currentUrls, storagePath];

    const updatePayload: Record<string, any> = {
      [urlField]: updatedUrls,
    };

    // Merge compliance data into gross_receipts
    if (complianceData) {
      const existingGr = entityRecord.gross_receipts || {};
      updatePayload.gross_receipts = { ...existingGr, ...complianceData };
    }

    await supabase
      .from('request_entities')
      .update(updatePayload)
      .eq('id', entityRecord.id);

    // Update local record for next file in same entity
    if (ext === '.html') {
      entityRecord.transcript_html_urls = updatedUrls;
    } else {
      entityRecord.transcript_urls = updatedUrls;
    }
    if (complianceData) {
      entityRecord.gross_receipts = { ...(entityRecord.gross_receipts || {}), ...complianceData };
    }

    await delay(UPLOAD_DELAY_MS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stats.errors.push({ path: filePath, error: msg });
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
