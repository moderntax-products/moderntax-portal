/**
 * Seed script: Pacific Commercial Bank demo environment
 *
 * Creates a complete demo bank client with users and sample requests
 * at various pipeline stages for demonstration purposes.
 *
 * Usage: npx tsx scripts/seed-demo-bank.ts
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const API_HEADERS = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

// ── Helpers ──────────────────────────────────────────────────

async function restGet(table: string, query: string = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${query ? '?' + query : ''}`;
  const res = await fetch(url, { headers: API_HEADERS });
  if (!res.ok) throw new Error(`GET ${table}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function restPost(table: string, body: any) {
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...API_HEADERS, Prefer: 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${table}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function restPatch(table: string, query: string, body: any) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: API_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${table}: ${res.status} ${await res.text()}`);
  return res.json();
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log('=== Seeding Pacific Commercial Bank Demo ===\n');

  // ── 1. Create or find the bank client ──────────────────────
  console.log('1. Creating bank client...');
  let client: any;
  const existing = await restGet('clients', 'slug=eq.pacific-commercial&select=*');
  if (existing.length > 0) {
    client = existing[0];
    console.log(`   Already exists: ${client.id}`);
  } else {
    const [created] = await restPost('clients', {
      name: 'Pacific Commercial Bank',
      slug: 'pacific-commercial',
      domain: 'pacificcommercialbank.com',
      intake_methods: ['csv', 'manual', 'pdf'],
      free_trial: true,
    });
    client = created;
    console.log(`   Created: ${client.id}`);
  }
  const clientId = client.id;

  // ── 2. Create demo processor user ──────────────────────────
  console.log('2. Creating demo processor user...');
  const processorEmail = 'demo@pacificcommercialbank.com';
  let processorId: string;

  // Check if user already exists
  const { data: existingUsers } = await supabase.auth.admin.listUsers();
  const existingProcessor = existingUsers?.users?.find(u => u.email === processorEmail);

  if (existingProcessor) {
    processorId = existingProcessor.id;
    console.log(`   Processor already exists: ${processorId}`);
  } else {
    const { data: newUser, error } = await supabase.auth.admin.createUser({
      email: processorEmail,
      password: 'Demo2026!',
      email_confirm: true,
    });
    if (error) throw new Error(`Create processor: ${error.message}`);
    processorId = newUser.user.id;
    console.log(`   Created processor: ${processorId}`);
  }

  // Wait a moment for the profile trigger to fire
  await new Promise(r => setTimeout(r, 1500));

  // Update processor profile
  await restPatch('profiles', `id=eq.${processorId}`, {
    role: 'processor',
    client_id: clientId,
    full_name: 'Sarah Chen',
  });
  console.log('   Updated processor profile: Sarah Chen');

  // ── 3. Create demo manager user ────────────────────────────
  console.log('3. Creating demo manager user...');
  const managerEmail = 'manager@pacificcommercialbank.com';
  let managerId: string;

  const existingManager = existingUsers?.users?.find(u => u.email === managerEmail);

  if (existingManager) {
    managerId = existingManager.id;
    console.log(`   Manager already exists: ${managerId}`);
  } else {
    const { data: newMgr, error } = await supabase.auth.admin.createUser({
      email: managerEmail,
      password: 'Demo2026!',
      email_confirm: true,
    });
    if (error) throw new Error(`Create manager: ${error.message}`);
    managerId = newMgr.user.id;
    console.log(`   Created manager: ${managerId}`);
  }

  await new Promise(r => setTimeout(r, 1500));

  await restPatch('profiles', `id=eq.${managerId}`, {
    role: 'manager',
    client_id: clientId,
    full_name: 'James Wilson',
  });
  console.log('   Updated manager profile: James Wilson');

  // ── 4. Create demo requests ────────────────────────────────
  console.log('4. Creating demo requests...\n');

  // Check if requests already exist for this client
  const existingRequests = await restGet('requests', `client_id=eq.${clientId}&select=loan_number`);
  const existingLoans = new Set(existingRequests.map((r: any) => r.loan_number));

  // Request definitions
  const requestDefs = [
    {
      loan_number: 'PCB-2026-001',
      status: 'completed',
      intake_method: 'csv',
      notes: 'SBA 7(a) - Golden Dragon Restaurant Group refinancing',
      created_at: daysAgo(12),
      completed_at: daysAgo(5),
      entities: [
        {
          entity_name: 'Golden Dragon Restaurant Group LLC',
          tid: '83-2947561',
          tid_kind: 'EIN',
          form_type: '1065',
          years: ['2023', '2024'],
          status: 'completed',
          signer_first_name: 'Wei',
          signer_last_name: 'Zhang',
          signer_email: 'wei.zhang@goldendragongroup.com',
          address: '1420 Pacific Ave',
          city: 'San Francisco',
          state: 'CA',
          zip_code: '94109',
          signed_8821_url: '8821/pcb-001-e1/signed-8821.pdf',
          transcript_urls: ['transcripts/pcb-001-e1/1065-2023.pdf', 'transcripts/pcb-001-e1/1065-2024.pdf'],
          completed_at: daysAgo(5),
        },
        {
          entity_name: 'Wei Zhang',
          tid: '591-82-4673',
          tid_kind: 'SSN',
          form_type: '1040',
          years: ['2023', '2024'],
          status: 'completed',
          signer_first_name: 'Wei',
          signer_last_name: 'Zhang',
          signer_email: 'wei.zhang@goldendragongroup.com',
          address: '1420 Pacific Ave',
          city: 'San Francisco',
          state: 'CA',
          zip_code: '94109',
          signed_8821_url: '8821/pcb-001-e2/signed-8821.pdf',
          transcript_urls: ['transcripts/pcb-001-e2/1040-2023.pdf', 'transcripts/pcb-001-e2/1040-2024.pdf'],
          completed_at: daysAgo(5),
        },
      ],
    },
    {
      loan_number: 'PCB-2026-002',
      status: 'completed',
      intake_method: 'manual',
      notes: 'SBA 504 - Pacific Ridge Construction expansion',
      created_at: daysAgo(8),
      completed_at: daysAgo(2),
      entities: [
        {
          entity_name: 'Pacific Ridge Construction Inc',
          tid: '47-6183920',
          tid_kind: 'EIN',
          form_type: '1120S',
          years: ['2023', '2024'],
          status: 'completed',
          signer_first_name: 'Michael',
          signer_last_name: 'Torres',
          signer_email: 'mtorres@pacificridgeconstruction.com',
          address: '8900 Harbor Blvd',
          city: 'Long Beach',
          state: 'CA',
          zip_code: '90802',
          signed_8821_url: '8821/pcb-002-e1/signed-8821.pdf',
          transcript_urls: ['transcripts/pcb-002-e1/1120S-2023.pdf', 'transcripts/pcb-002-e1/1120S-2024.pdf'],
          completed_at: daysAgo(2),
        },
      ],
    },
    {
      loan_number: 'PCB-2026-003',
      status: 'processing',
      intake_method: 'csv',
      notes: 'SBA 7(a) - Bay Area Medical Associates working capital',
      created_at: daysAgo(3),
      entities: [
        {
          entity_name: 'Bay Area Medical Associates PLLC',
          tid: '92-5038174',
          tid_kind: 'EIN',
          form_type: '1065',
          years: ['2023', '2024'],
          status: 'processing',
          signer_first_name: 'Priya',
          signer_last_name: 'Sharma',
          signer_email: 'psharma@bayareamedical.com',
          address: '2300 El Camino Real',
          city: 'Palo Alto',
          state: 'CA',
          zip_code: '94306',
          signed_8821_url: '8821/pcb-003-e1/signed-8821.pdf',
        },
        {
          entity_name: 'Dr. Priya Sharma',
          tid: '628-41-7390',
          tid_kind: 'SSN',
          form_type: '1040',
          years: ['2023', '2024'],
          status: 'irs_queue',
          signer_first_name: 'Priya',
          signer_last_name: 'Sharma',
          signer_email: 'psharma@bayareamedical.com',
          address: '2300 El Camino Real',
          city: 'Palo Alto',
          state: 'CA',
          zip_code: '94306',
          signed_8821_url: '8821/pcb-003-e2/signed-8821.pdf',
        },
      ],
    },
    {
      loan_number: 'PCB-2026-004',
      status: '8821_signed',
      intake_method: 'pdf',
      notes: 'SBA Express - Coastal Brewing Co. equipment purchase',
      created_at: daysAgo(2),
      entities: [
        {
          entity_name: 'Coastal Brewing Company LLC',
          tid: '61-8294037',
          tid_kind: 'EIN',
          form_type: '1065',
          years: ['2023', '2024'],
          status: '8821_signed',
          signer_first_name: 'Derek',
          signer_last_name: 'Nakamura',
          signer_email: 'derek@coastalbrewing.com',
          address: '550 Waterfront Dr',
          city: 'Monterey',
          state: 'CA',
          zip_code: '93940',
          signed_8821_url: '8821/pcb-004-e1/signed-8821.pdf',
        },
        {
          entity_name: 'Derek Nakamura',
          tid: '574-29-8361',
          tid_kind: 'SSN',
          form_type: '1040',
          years: ['2023', '2024'],
          status: '8821_signed',
          signer_first_name: 'Derek',
          signer_last_name: 'Nakamura',
          signer_email: 'derek@coastalbrewing.com',
          address: '550 Waterfront Dr',
          city: 'Monterey',
          state: 'CA',
          zip_code: '93940',
          signed_8821_url: '8821/pcb-004-e2/signed-8821.pdf',
        },
        {
          entity_name: 'Lisa Nakamura',
          tid: '574-31-6428',
          tid_kind: 'SSN',
          form_type: '1040',
          years: ['2023', '2024'],
          status: '8821_signed',
          signer_first_name: 'Lisa',
          signer_last_name: 'Nakamura',
          signer_email: 'lisa@coastalbrewing.com',
          address: '550 Waterfront Dr',
          city: 'Monterey',
          state: 'CA',
          zip_code: '93940',
          signed_8821_url: '8821/pcb-004-e3/signed-8821.pdf',
        },
      ],
    },
    {
      loan_number: 'PCB-2026-005',
      status: '8821_sent',
      intake_method: 'manual',
      notes: 'SBA 7(a) - Redwood Property Management acquisition',
      created_at: daysAgo(1),
      entities: [
        {
          entity_name: 'Redwood Property Management Inc',
          tid: '38-7041926',
          tid_kind: 'EIN',
          form_type: '1120S',
          years: ['2023', '2024'],
          status: '8821_sent',
          signer_first_name: 'Angela',
          signer_last_name: 'Rivera',
          signer_email: 'arivera@redwoodpm.com',
          address: '4100 Redwood Hwy',
          city: 'San Rafael',
          state: 'CA',
          zip_code: '94903',
        },
        {
          entity_name: 'Angela Rivera',
          tid: '602-53-8194',
          tid_kind: 'SSN',
          form_type: '1040',
          years: ['2023', '2024'],
          status: '8821_sent',
          signer_first_name: 'Angela',
          signer_last_name: 'Rivera',
          signer_email: 'arivera@redwoodpm.com',
          address: '4100 Redwood Hwy',
          city: 'San Rafael',
          state: 'CA',
          zip_code: '94903',
        },
      ],
    },
    {
      loan_number: 'PCB-2026-006',
      status: 'submitted',
      intake_method: 'manual',
      notes: 'SBA Community Advantage - Sunrise Auto Body new location',
      created_at: new Date().toISOString(),
      entities: [
        {
          entity_name: 'Sunrise Auto Body & Repair LLC',
          tid: '54-9172038',
          tid_kind: 'EIN',
          form_type: '1120S',
          years: ['2023', '2024'],
          status: 'pending',
          signer_first_name: 'Carlos',
          signer_last_name: 'Mendez',
          signer_email: 'carlos@sunriseautobody.com',
          address: '7200 Mission St',
          city: 'Daly City',
          state: 'CA',
          zip_code: '94014',
        },
      ],
    },
  ];

  let requestsCreated = 0;
  let entitiesCreated = 0;

  for (const def of requestDefs) {
    if (existingLoans.has(def.loan_number)) {
      console.log(`   Skipping ${def.loan_number} (already exists)`);
      continue;
    }

    // Create request
    const [request] = await restPost('requests', {
      client_id: clientId,
      requested_by: processorId,
      loan_number: def.loan_number,
      status: def.status,
      intake_method: def.intake_method,
      notes: def.notes,
      created_at: def.created_at,
      completed_at: def.completed_at || null,
    });
    console.log(`   Created request ${def.loan_number} (${def.status}): ${request.id}`);
    requestsCreated++;

    // Create entities
    for (const ent of def.entities) {
      const entityPayload: any = {
        request_id: request.id,
        entity_name: ent.entity_name,
        tid: ent.tid,
        tid_kind: ent.tid_kind,
        form_type: ent.form_type,
        years: ent.years,
        status: ent.status,
        signer_first_name: ent.signer_first_name,
        signer_last_name: ent.signer_last_name,
        signer_email: ent.signer_email,
        address: ent.address,
        city: ent.city,
        state: ent.state,
        zip_code: ent.zip_code,
        created_at: def.created_at,
      };

      if (ent.signed_8821_url) entityPayload.signed_8821_url = ent.signed_8821_url;
      if (ent.transcript_urls) entityPayload.transcript_urls = ent.transcript_urls;
      if (ent.completed_at) entityPayload.completed_at = ent.completed_at;

      const [entity] = await restPost('request_entities', entityPayload);
      console.log(`     Entity: ${ent.entity_name} (${ent.status})`);
      entitiesCreated++;
    }
  }

  // ── Summary ────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log('DEMO ENVIRONMENT SEEDED SUCCESSFULLY');
  console.log('='.repeat(60));
  console.log(`\nClient: Pacific Commercial Bank (${clientId})`);
  console.log(`Requests created: ${requestsCreated}`);
  console.log(`Entities created: ${entitiesCreated}`);
  console.log('\n--- Login Credentials ---');
  console.log('Processor:');
  console.log('  Email:    demo@pacificcommercialbank.com');
  console.log('  Password: Demo2026!');
  console.log('  Name:     Sarah Chen (Loan Processor)');
  console.log('\nManager:');
  console.log('  Email:    manager@pacificcommercialbank.com');
  console.log('  Password: Demo2026!');
  console.log('  Name:     James Wilson (VP Commercial Lending)');
  console.log('\n--- Pipeline Overview ---');
  console.log('  PCB-2026-001  completed    Golden Dragon Restaurant Group (2 entities)');
  console.log('  PCB-2026-002  completed    Pacific Ridge Construction (1 entity)');
  console.log('  PCB-2026-003  processing   Bay Area Medical Associates (2 entities)');
  console.log('  PCB-2026-004  8821_signed  Coastal Brewing Company (3 entities)');
  console.log('  PCB-2026-005  8821_sent    Redwood Property Management (2 entities)');
  console.log('  PCB-2026-006  submitted    Sunrise Auto Body & Repair (1 entity)');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
