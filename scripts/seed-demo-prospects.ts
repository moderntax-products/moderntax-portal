/**
 * Seed script: TD Bank + Banc of California demo environments
 *
 * TD Bank — large enterprise SBA lender (east coast, high volume, CSV bulk)
 * Banc of California — small operation (5-6 closers, manual, switching from Tax Guard)
 *
 * Usage: npx tsx scripts/seed-demo-prospects.ts
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

async function ensureUser(email: string, password: string, fullName: string, role: string, clientId: string): Promise<string> {
  const { data: existingUsers } = await supabase.auth.admin.listUsers();
  const existing = existingUsers?.users?.find(u => u.email === email);

  let userId: string;
  if (existing) {
    userId = existing.id;
    console.log(`   User exists: ${email} (${userId})`);
  } else {
    const { data: newUser, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw new Error(`Create user ${email}: ${error.message}`);
    userId = newUser.user.id;
    console.log(`   Created user: ${email} (${userId})`);
  }

  await new Promise(r => setTimeout(r, 1000));
  await restPatch('profiles', `id=eq.${userId}`, {
    role,
    client_id: clientId,
    full_name: fullName,
  });

  return userId;
}

// ── TD Bank Data ─────────────────────────────────────────────

const TD_REQUESTS = [
  // ── Completed (showing fast turnaround vs Tax Guard's 24hr+) ──
  {
    loan_number: 'TD-SBA-2026-0147',
    status: 'completed',
    intake_method: 'csv',
    notes: 'SBA 7(a) - Northeast Hospitality Group LLC, $2.4M working capital',
    created_at: daysAgo(18),
    completed_at: daysAgo(16),
    entities: [
      {
        entity_name: 'Northeast Hospitality Group LLC',
        tid: '46-3928571',
        tid_kind: 'EIN',
        form_type: '1065',
        years: ['2023', '2024', '2025'],
        status: 'completed',
        signer_first_name: 'Robert',
        signer_last_name: 'Antonelli',
        signer_email: 'rantonelli@nehospitality.com',
        address: '120 Broadway',
        city: 'New York',
        state: 'NY',
        zip_code: '10271',
        signed_8821_url: '8821/td-0147-e1/signed-8821.pdf',
        transcript_urls: ['transcripts/td-0147-e1/1065-2023.pdf', 'transcripts/td-0147-e1/1065-2024.pdf', 'transcripts/td-0147-e1/1065-2025.pdf'],
        completed_at: daysAgo(16),
      },
      {
        entity_name: 'Robert Antonelli',
        tid: '073-48-9216',
        tid_kind: 'SSN',
        form_type: '1040',
        years: ['2023', '2024', '2025'],
        status: 'completed',
        signer_first_name: 'Robert',
        signer_last_name: 'Antonelli',
        signer_email: 'rantonelli@nehospitality.com',
        address: '88 Greenwich St Apt 42F',
        city: 'New York',
        state: 'NY',
        zip_code: '10006',
        signed_8821_url: '8821/td-0147-e2/signed-8821.pdf',
        transcript_urls: ['transcripts/td-0147-e2/1040-2023.pdf', 'transcripts/td-0147-e2/1040-2024.pdf', 'transcripts/td-0147-e2/1040-2025.pdf'],
        completed_at: daysAgo(16),
      },
      {
        entity_name: 'Maria Antonelli',
        tid: '073-52-1847',
        tid_kind: 'SSN',
        form_type: '1040',
        years: ['2023', '2024', '2025'],
        status: 'completed',
        signer_first_name: 'Maria',
        signer_last_name: 'Antonelli',
        signer_email: 'mantonelli@nehospitality.com',
        address: '88 Greenwich St Apt 42F',
        city: 'New York',
        state: 'NY',
        zip_code: '10006',
        signed_8821_url: '8821/td-0147-e3/signed-8821.pdf',
        transcript_urls: ['transcripts/td-0147-e3/1040-2023.pdf', 'transcripts/td-0147-e3/1040-2024.pdf', 'transcripts/td-0147-e3/1040-2025.pdf'],
        completed_at: daysAgo(16),
      },
    ],
  },
  {
    loan_number: 'TD-SBA-2026-0152',
    status: 'completed',
    intake_method: 'csv',
    notes: 'SBA 504 - Atlantic Precision Manufacturing Inc, $4.8M equipment + real estate',
    created_at: daysAgo(14),
    completed_at: daysAgo(11),
    entities: [
      {
        entity_name: 'Atlantic Precision Manufacturing Inc',
        tid: '82-5019384',
        tid_kind: 'EIN',
        form_type: '1120S',
        years: ['2023', '2024', '2025'],
        status: 'completed',
        signer_first_name: 'James',
        signer_last_name: 'Whitfield',
        signer_email: 'jwhitfield@atlanticprecision.com',
        address: '2400 Industrial Pkwy',
        city: 'Edison',
        state: 'NJ',
        zip_code: '08817',
        signed_8821_url: '8821/td-0152-e1/signed-8821.pdf',
        transcript_urls: ['transcripts/td-0152-e1/1120S-2023.pdf', 'transcripts/td-0152-e1/1120S-2024.pdf', 'transcripts/td-0152-e1/1120S-2025.pdf'],
        completed_at: daysAgo(11),
      },
      {
        entity_name: 'James Whitfield',
        tid: '158-62-3947',
        tid_kind: 'SSN',
        form_type: '1040',
        years: ['2023', '2024', '2025'],
        status: 'completed',
        signer_first_name: 'James',
        signer_last_name: 'Whitfield',
        signer_email: 'jwhitfield@atlanticprecision.com',
        address: '15 Winding Brook Dr',
        city: 'Westfield',
        state: 'NJ',
        zip_code: '07090',
        signed_8821_url: '8821/td-0152-e2/signed-8821.pdf',
        transcript_urls: ['transcripts/td-0152-e2/1040-2023.pdf', 'transcripts/td-0152-e2/1040-2024.pdf', 'transcripts/td-0152-e2/1040-2025.pdf'],
        completed_at: daysAgo(11),
      },
    ],
  },
  {
    loan_number: 'TD-SBA-2026-0158',
    status: 'completed',
    intake_method: 'csv',
    notes: 'SBA 7(a) - Garden State Medical Partners PLLC, $1.8M practice acquisition',
    created_at: daysAgo(10),
    completed_at: daysAgo(7),
    entities: [
      {
        entity_name: 'Garden State Medical Partners PLLC',
        tid: '27-8361940',
        tid_kind: 'EIN',
        form_type: '1065',
        years: ['2023', '2024', '2025'],
        status: 'completed',
        signer_first_name: 'Anil',
        signer_last_name: 'Kapoor',
        signer_email: 'akapoor@gsmpartners.com',
        address: '300 Campus Dr',
        city: 'Florham Park',
        state: 'NJ',
        zip_code: '07932',
        signed_8821_url: '8821/td-0158-e1/signed-8821.pdf',
        transcript_urls: ['transcripts/td-0158-e1/1065-2023.pdf', 'transcripts/td-0158-e1/1065-2024.pdf', 'transcripts/td-0158-e1/1065-2025.pdf'],
        completed_at: daysAgo(7),
      },
      {
        entity_name: 'Dr. Anil Kapoor',
        tid: '214-73-8502',
        tid_kind: 'SSN',
        form_type: '1040',
        years: ['2023', '2024', '2025'],
        status: 'completed',
        signer_first_name: 'Anil',
        signer_last_name: 'Kapoor',
        signer_email: 'akapoor@gsmpartners.com',
        address: '42 Ridgeview Terrace',
        city: 'Short Hills',
        state: 'NJ',
        zip_code: '07078',
        signed_8821_url: '8821/td-0158-e2/signed-8821.pdf',
        transcript_urls: ['transcripts/td-0158-e2/1040-2023.pdf', 'transcripts/td-0158-e2/1040-2024.pdf', 'transcripts/td-0158-e2/1040-2025.pdf'],
        completed_at: daysAgo(7),
      },
    ],
  },
  // ── In processing (shows entity verification catching issues) ──
  {
    loan_number: 'TD-SBA-2026-0163',
    status: 'processing',
    intake_method: 'csv',
    notes: 'SBA 7(a) - Tri-State Logistics Corp, $3.2M fleet expansion — entity election mismatch detected',
    created_at: daysAgo(5),
    entities: [
      {
        entity_name: 'Tri-State Logistics Corp',
        tid: '61-4827390',
        tid_kind: 'EIN',
        form_type: '1120',
        years: ['2023', '2024', '2025'],
        status: 'processing',
        signer_first_name: 'Kevin',
        signer_last_name: 'Okafor',
        signer_email: 'kokafor@tristatelogistics.com',
        address: '800 Tonnelle Ave',
        city: 'North Bergen',
        state: 'NJ',
        zip_code: '07047',
        signed_8821_url: '8821/td-0163-e1/signed-8821.pdf',
        // Note: borrower claims 1120 but IRS shows 1120S — entity verification caught this
      },
      {
        entity_name: 'Kevin Okafor',
        tid: '135-27-6841',
        tid_kind: 'SSN',
        form_type: '1040',
        years: ['2023', '2024', '2025'],
        status: 'irs_queue',
        signer_first_name: 'Kevin',
        signer_last_name: 'Okafor',
        signer_email: 'kokafor@tristatelogistics.com',
        address: '220 Park Ave Unit 18B',
        city: 'Hoboken',
        state: 'NJ',
        zip_code: '07030',
        signed_8821_url: '8821/td-0163-e2/signed-8821.pdf',
      },
      {
        entity_name: 'Patricia Okafor',
        tid: '135-41-2958',
        tid_kind: 'SSN',
        form_type: '1040',
        years: ['2023', '2024', '2025'],
        status: 'irs_queue',
        signer_first_name: 'Patricia',
        signer_last_name: 'Okafor',
        signer_email: 'pokafor@tristatelogistics.com',
        address: '220 Park Ave Unit 18B',
        city: 'Hoboken',
        state: 'NJ',
        zip_code: '07030',
        signed_8821_url: '8821/td-0163-e3/signed-8821.pdf',
      },
    ],
  },
  {
    loan_number: 'TD-SBA-2026-0165',
    status: 'processing',
    intake_method: 'csv',
    notes: 'SBA Express - Metro Dental Associates PC, $500K equipment',
    created_at: daysAgo(4),
    entities: [
      {
        entity_name: 'Metro Dental Associates PC',
        tid: '83-6140273',
        tid_kind: 'EIN',
        form_type: '1120S',
        years: ['2023', '2024', '2025'],
        status: 'processing',
        signer_first_name: 'Sharon',
        signer_last_name: 'Kim',
        signer_email: 'skim@metrodentalpc.com',
        address: '1515 Northern Blvd',
        city: 'Manhasset',
        state: 'NY',
        zip_code: '11030',
        signed_8821_url: '8821/td-0165-e1/signed-8821.pdf',
      },
      {
        entity_name: 'Dr. Sharon Kim',
        tid: '078-53-2914',
        tid_kind: 'SSN',
        form_type: '1040',
        years: ['2023', '2024', '2025'],
        status: 'irs_queue',
        signer_first_name: 'Sharon',
        signer_last_name: 'Kim',
        signer_email: 'skim@metrodentalpc.com',
        address: '88 Harbor View Ln',
        city: 'Port Washington',
        state: 'NY',
        zip_code: '11050',
        signed_8821_url: '8821/td-0165-e2/signed-8821.pdf',
      },
    ],
  },
  // ── Bulk CSV upload — 5 loans at once (shows enterprise scale) ──
  {
    loan_number: 'TD-SBA-2026-0168',
    status: 'processing',
    intake_method: 'csv',
    notes: 'SBA 7(a) - Hudson Valley Farm Supply Inc, $1.2M inventory line',
    created_at: daysAgo(3),
    entities: [
      {
        entity_name: 'Hudson Valley Farm Supply Inc',
        tid: '14-5839201',
        tid_kind: 'EIN',
        form_type: '1120S',
        years: ['2023', '2024', '2025'],
        status: '8821_signed',
        signer_first_name: 'Thomas',
        signer_last_name: 'Brennan',
        signer_email: 'tbrennan@hvfarmsupply.com',
        address: '450 Route 9W',
        city: 'Newburgh',
        state: 'NY',
        zip_code: '12550',
        signed_8821_url: '8821/td-0168-e1/signed-8821.pdf',
      },
    ],
  },
  // ── 8821 signature collection in progress ──
  {
    loan_number: 'TD-SBA-2026-0171',
    status: '8821_sent',
    intake_method: 'csv',
    notes: 'SBA 504 - Commonwealth Steel Fabricators LLC, $6.1M facility expansion',
    created_at: daysAgo(2),
    entities: [
      {
        entity_name: 'Commonwealth Steel Fabricators LLC',
        tid: '52-7381946',
        tid_kind: 'EIN',
        form_type: '1065',
        years: ['2023', '2024', '2025'],
        status: '8821_sent',
        signer_first_name: 'Daniel',
        signer_last_name: 'Moretti',
        signer_email: 'dmoretti@commonwealthsteel.com',
        address: '3200 Industrial Way',
        city: 'Bridgewater',
        state: 'NJ',
        zip_code: '08807',
      },
      {
        entity_name: 'Daniel Moretti',
        tid: '152-38-7461',
        tid_kind: 'SSN',
        form_type: '1040',
        years: ['2023', '2024', '2025'],
        status: '8821_sent',
        signer_first_name: 'Daniel',
        signer_last_name: 'Moretti',
        signer_email: 'dmoretti@commonwealthsteel.com',
        address: '7 Overlook Rd',
        city: 'Bernardsville',
        state: 'NJ',
        zip_code: '07924',
      },
      {
        entity_name: 'Frank Moretti',
        tid: '152-42-8193',
        tid_kind: 'SSN',
        form_type: '1040',
        years: ['2023', '2024', '2025'],
        status: '8821_sent',
        signer_first_name: 'Frank',
        signer_last_name: 'Moretti',
        signer_email: 'fmoretti@commonwealthsteel.com',
        address: '19 Maple Ct',
        city: 'Far Hills',
        state: 'NJ',
        zip_code: '07931',
      },
    ],
  },
  // ── Just submitted — brand new ──
  {
    loan_number: 'TD-SBA-2026-0174',
    status: 'submitted',
    intake_method: 'csv',
    notes: 'SBA 7(a) - Liberty Square Capital Partners LP, $5.5M acquisition',
    created_at: daysAgo(0),
    entities: [
      {
        entity_name: 'Liberty Square Capital Partners LP',
        tid: '37-9150482',
        tid_kind: 'EIN',
        form_type: '1065',
        years: ['2023', '2024', '2025'],
        status: 'pending',
        signer_first_name: 'William',
        signer_last_name: 'Chen',
        signer_email: 'wchen@libertysquarecap.com',
        address: '1 Liberty Plaza',
        city: 'New York',
        state: 'NY',
        zip_code: '10006',
      },
      {
        entity_name: 'William Chen',
        tid: '086-29-4738',
        tid_kind: 'SSN',
        form_type: '1040',
        years: ['2023', '2024', '2025'],
        status: 'pending',
        signer_first_name: 'William',
        signer_last_name: 'Chen',
        signer_email: 'wchen@libertysquarecap.com',
        address: '400 Central Park West Apt 21A',
        city: 'New York',
        state: 'NY',
        zip_code: '10025',
      },
      {
        entity_name: 'Sarah Mitchell',
        tid: '091-53-6284',
        tid_kind: 'SSN',
        form_type: '1040',
        years: ['2023', '2024', '2025'],
        status: 'pending',
        signer_first_name: 'Sarah',
        signer_last_name: 'Mitchell',
        signer_email: 'smitchell@libertysquarecap.com',
        address: '250 Mercer St Apt 8C',
        city: 'New York',
        state: 'NY',
        zip_code: '10012',
      },
    ],
  },
  {
    loan_number: 'TD-SBA-2026-0175',
    status: 'submitted',
    intake_method: 'manual',
    notes: 'SBA Express - Empire Plumbing & HVAC Inc, $350K working capital',
    created_at: daysAgo(0),
    entities: [
      {
        entity_name: 'Empire Plumbing & HVAC Inc',
        tid: '13-7294581',
        tid_kind: 'EIN',
        form_type: '1120S',
        years: ['2023', '2024', '2025'],
        status: 'pending',
        signer_first_name: 'Anthony',
        signer_last_name: 'Russo',
        signer_email: 'arusso@empireplumbing.com',
        address: '42-15 Queens Blvd',
        city: 'Sunnyside',
        state: 'NY',
        zip_code: '11104',
      },
    ],
  },
];

// ── Banc of California Data ──────────────────────────────────

const BANC_REQUESTS = [
  // ── Completed (demonstrate speed advantage over Tax Guard) ──
  {
    loan_number: 'BANC-2026-031',
    status: 'completed',
    intake_method: 'manual',
    notes: 'SBA 7(a) - Sunset Poke & Ramen LLC, $380K restaurant build-out',
    created_at: daysAgo(21),
    completed_at: daysAgo(19),
    entities: [
      {
        entity_name: 'Sunset Poke & Ramen LLC',
        tid: '88-4261739',
        tid_kind: 'EIN',
        form_type: '1065',
        years: ['2023', '2024'],
        status: 'completed',
        signer_first_name: 'Tyler',
        signer_last_name: 'Nakamura',
        signer_email: 'tyler@sunsetpoke.com',
        address: '1842 Sunset Blvd',
        city: 'Los Angeles',
        state: 'CA',
        zip_code: '90026',
        signed_8821_url: '8821/banc-031-e1/signed-8821.pdf',
        transcript_urls: ['transcripts/banc-031-e1/1065-2023.pdf', 'transcripts/banc-031-e1/1065-2024.pdf'],
        completed_at: daysAgo(19),
      },
      {
        entity_name: 'Tyler Nakamura',
        tid: '612-48-3971',
        tid_kind: 'SSN',
        form_type: '1040',
        years: ['2023', '2024'],
        status: 'completed',
        signer_first_name: 'Tyler',
        signer_last_name: 'Nakamura',
        signer_email: 'tyler@sunsetpoke.com',
        address: '2209 Echo Park Ave',
        city: 'Los Angeles',
        state: 'CA',
        zip_code: '90026',
        signed_8821_url: '8821/banc-031-e2/signed-8821.pdf',
        transcript_urls: ['transcripts/banc-031-e2/1040-2023.pdf', 'transcripts/banc-031-e2/1040-2024.pdf'],
        completed_at: daysAgo(19),
      },
    ],
  },
  {
    loan_number: 'BANC-2026-034',
    status: 'completed',
    intake_method: 'manual',
    notes: 'SBA Express - Westside Physical Therapy Inc, $250K equipment',
    created_at: daysAgo(15),
    completed_at: daysAgo(13),
    entities: [
      {
        entity_name: 'Westside Physical Therapy Inc',
        tid: '95-4183720',
        tid_kind: 'EIN',
        form_type: '1120S',
        years: ['2023', '2024'],
        status: 'completed',
        signer_first_name: 'Jennifer',
        signer_last_name: 'Reyes',
        signer_email: 'jreyes@westsidept.com',
        address: '11740 San Vicente Blvd',
        city: 'Los Angeles',
        state: 'CA',
        zip_code: '90049',
        signed_8821_url: '8821/banc-034-e1/signed-8821.pdf',
        transcript_urls: ['transcripts/banc-034-e1/1120S-2023.pdf', 'transcripts/banc-034-e1/1120S-2024.pdf'],
        completed_at: daysAgo(13),
      },
    ],
  },
  // ── Processing — shows digital signature advantage ──
  {
    loan_number: 'BANC-2026-037',
    status: 'processing',
    intake_method: 'manual',
    notes: 'SBA 7(a) - SoCal Solar Solutions LLC, $820K installation fleet — digital 8821 signed in 4 hours',
    created_at: daysAgo(6),
    entities: [
      {
        entity_name: 'SoCal Solar Solutions LLC',
        tid: '84-7392018',
        tid_kind: 'EIN',
        form_type: '1065',
        years: ['2023', '2024'],
        status: 'processing',
        signer_first_name: 'Marcus',
        signer_last_name: 'Johnson',
        signer_email: 'marcus@socalsolar.com',
        address: '5400 E Olympic Blvd',
        city: 'Commerce',
        state: 'CA',
        zip_code: '90022',
        signed_8821_url: '8821/banc-037-e1/signed-8821.pdf',
      },
      {
        entity_name: 'Marcus Johnson',
        tid: '619-37-8254',
        tid_kind: 'SSN',
        form_type: '1040',
        years: ['2023', '2024'],
        status: 'irs_queue',
        signer_first_name: 'Marcus',
        signer_last_name: 'Johnson',
        signer_email: 'marcus@socalsolar.com',
        address: '1823 S Redondo Blvd',
        city: 'Los Angeles',
        state: 'CA',
        zip_code: '90019',
        signed_8821_url: '8821/banc-037-e2/signed-8821.pdf',
      },
    ],
  },
  // ── Entity verification catching Schedule C → S-Corp mismatch ──
  {
    loan_number: 'BANC-2026-039',
    status: 'processing',
    intake_method: 'manual',
    notes: 'SBA 7(a) - Malibu Coast Catering Co, $450K — ALERT: borrower filed Sched C but claims S-Corp',
    created_at: daysAgo(4),
    entities: [
      {
        entity_name: 'Malibu Coast Catering Co',
        tid: '88-5027194',
        tid_kind: 'EIN',
        form_type: '1120S',
        years: ['2023', '2024'],
        status: 'processing',
        signer_first_name: 'Elena',
        signer_last_name: 'Vasquez',
        signer_email: 'elena@malibucoastcatering.com',
        address: '22741 Pacific Coast Hwy',
        city: 'Malibu',
        state: 'CA',
        zip_code: '90265',
        signed_8821_url: '8821/banc-039-e1/signed-8821.pdf',
        // Entity verification: borrower says 1120S but IRS has Schedule C on 1040
      },
      {
        entity_name: 'Elena Vasquez',
        tid: '607-24-8391',
        tid_kind: 'SSN',
        form_type: '1040',
        years: ['2023', '2024'],
        status: 'irs_queue',
        signer_first_name: 'Elena',
        signer_last_name: 'Vasquez',
        signer_email: 'elena@malibucoastcatering.com',
        address: '340 N Topanga Canyon Blvd',
        city: 'Topanga',
        state: 'CA',
        zip_code: '90290',
        signed_8821_url: '8821/banc-039-e2/signed-8821.pdf',
      },
    ],
  },
  // ── 8821 signed, ready to process ──
  {
    loan_number: 'BANC-2026-041',
    status: '8821_signed',
    intake_method: 'manual',
    notes: 'SBA Express - Valley Auto Detailing LLC, $175K mobile unit',
    created_at: daysAgo(2),
    entities: [
      {
        entity_name: 'Valley Auto Detailing LLC',
        tid: '81-3948270',
        tid_kind: 'EIN',
        form_type: '1065',
        years: ['2023', '2024'],
        status: '8821_signed',
        signer_first_name: 'David',
        signer_last_name: 'Park',
        signer_email: 'david@valleyautodetail.com',
        address: '15233 Ventura Blvd',
        city: 'Sherman Oaks',
        state: 'CA',
        zip_code: '91403',
        signed_8821_url: '8821/banc-041-e1/signed-8821.pdf',
      },
    ],
  },
  // ── 8821 sent — waiting for digital signature ──
  {
    loan_number: 'BANC-2026-042',
    status: '8821_sent',
    intake_method: 'manual',
    notes: 'SBA 7(a) - Inglewood Fitness & Wellness Center Inc, $680K buildout',
    created_at: daysAgo(1),
    entities: [
      {
        entity_name: 'Inglewood Fitness & Wellness Center Inc',
        tid: '95-6281034',
        tid_kind: 'EIN',
        form_type: '1120S',
        years: ['2023', '2024'],
        status: '8821_sent',
        signer_first_name: 'Darnell',
        signer_last_name: 'Washington',
        signer_email: 'darnell@inglewoodfitness.com',
        address: '901 S La Brea Ave',
        city: 'Inglewood',
        state: 'CA',
        zip_code: '90301',
      },
      {
        entity_name: 'Darnell Washington',
        tid: '621-48-7935',
        tid_kind: 'SSN',
        form_type: '1040',
        years: ['2023', '2024'],
        status: '8821_sent',
        signer_first_name: 'Darnell',
        signer_last_name: 'Washington',
        signer_email: 'darnell@inglewoodfitness.com',
        address: '4250 W Century Blvd',
        city: 'Inglewood',
        state: 'CA',
        zip_code: '90304',
      },
    ],
  },
  // ── Brand new submission ──
  {
    loan_number: 'BANC-2026-043',
    status: 'submitted',
    intake_method: 'manual',
    notes: 'SBA Express - Koreatown Boba House LLC, $120K',
    created_at: daysAgo(0),
    entities: [
      {
        entity_name: 'Koreatown Boba House LLC',
        tid: '88-7123940',
        tid_kind: 'EIN',
        form_type: '1065',
        years: ['2023', '2024'],
        status: 'pending',
        signer_first_name: 'Jin',
        signer_last_name: 'Park',
        signer_email: 'jin@ktownboba.com',
        address: '3500 W 6th St',
        city: 'Los Angeles',
        state: 'CA',
        zip_code: '90020',
      },
    ],
  },
];

// ── Main ─────────────────────────────────────────────────────

async function seedClient(
  clientName: string,
  slug: string,
  domain: string,
  users: { email: string; password: string; name: string; role: string }[],
  requests: typeof TD_REQUESTS,
  intakeMethods: string[],
) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${clientName}`);
  console.log(`${'═'.repeat(60)}\n`);

  // 1. Create or find client
  console.log('1. Client...');
  let client: any;
  const existing = await restGet('clients', `slug=eq.${slug}&select=*`);
  if (existing.length > 0) {
    client = existing[0];
    console.log(`   Already exists: ${client.id}`);
  } else {
    const [created] = await restPost('clients', {
      name: clientName,
      slug,
      domain,
      intake_methods: intakeMethods,
      free_trial: true,
    });
    client = created;
    console.log(`   Created: ${client.id}`);
  }

  // 2. Create users
  console.log('2. Users...');
  const userIds: Record<string, string> = {};
  for (const u of users) {
    userIds[u.role] = await ensureUser(u.email, u.password, u.name, u.role, client.id);
    console.log(`   ${u.role}: ${u.name}`);
  }

  // 3. Create requests
  console.log('3. Requests...\n');
  const existingRequests = await restGet('requests', `client_id=eq.${client.id}&select=loan_number`);
  const existingLoans = new Set(existingRequests.map((r: any) => r.loan_number));

  let requestsCreated = 0;
  let entitiesCreated = 0;

  for (const def of requests) {
    if (existingLoans.has(def.loan_number)) {
      console.log(`   ⏭  ${def.loan_number} (already exists)`);
      continue;
    }

    const [request] = await restPost('requests', {
      client_id: client.id,
      requested_by: userIds['processor'],
      loan_number: def.loan_number,
      status: def.status,
      intake_method: def.intake_method,
      notes: def.notes,
      created_at: def.created_at,
      completed_at: (def as any).completed_at || null,
    });
    console.log(`   ✅ ${def.loan_number}  ${def.status.padEnd(12)}  ${def.notes?.split(' - ')[1]?.split(',')[0] || ''}`);
    requestsCreated++;

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
      if ((ent as any).signed_8821_url) entityPayload.signed_8821_url = (ent as any).signed_8821_url;
      if ((ent as any).transcript_urls) entityPayload.transcript_urls = (ent as any).transcript_urls;
      if ((ent as any).completed_at) entityPayload.completed_at = (ent as any).completed_at;

      await restPost('request_entities', entityPayload);
      console.log(`      └─ ${ent.entity_name} (${ent.tid_kind}, ${ent.form_type}) — ${ent.status}`);
      entitiesCreated++;
    }
  }

  return { requestsCreated, entitiesCreated, clientId: client.id };
}

async function main() {
  console.log('\n🏦 Seeding Demo Prospect Environments\n');

  // ── TD Bank ──
  const td = await seedClient(
    'TD Bank',
    'td-bank',
    'td.com',
    [
      { email: 'demo-processor@td.com', password: 'TDDemo2026!', name: 'Tom Richards', role: 'processor' },
      { email: 'demo-manager@td.com', password: 'TDDemo2026!', name: 'Teresa Lombardi', role: 'manager' },
    ],
    TD_REQUESTS,
    ['csv', 'manual', 'api'],
  );

  // ── Banc of California ──
  const banc = await seedClient(
    'Banc of California',
    'banc-of-california',
    'bancofcal.com',
    [
      { email: 'demo@bancofcal.com', password: 'BancDemo2026!', name: 'Aaron Nguyen', role: 'processor' },
      { email: 'demo-manager@bancofcal.com', password: 'BancDemo2026!', name: 'Dawn Patterson', role: 'manager' },
    ],
    BANC_REQUESTS,
    ['manual', 'pdf', 'csv'],
  );

  // ── Summary ──
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  DEMO ENVIRONMENTS READY');
  console.log(`${'═'.repeat(60)}`);

  console.log(`
┌──────────────────────────────────────────────────────┐
│  TD BANK  (Enterprise — largest east coast SBA)      │
├──────────────────────────────────────────────────────┤
│  Processor:  demo-processor@td.com / TDDemo2026!     │
│  Name:       Tom Richards                            │
│  Manager:    demo-manager@td.com / TDDemo2026!       │
│  Name:       Teresa Lombardi                         │
│                                                      │
│  Requests:   ${String(td.requestsCreated).padEnd(4)} created (9 total)                │
│  Entities:   ${String(td.entitiesCreated).padEnd(4)} created (22 total)               │
│  Intake:     CSV bulk upload (primary), manual       │
│  Geography:  NY/NJ metro                             │
│                                                      │
│  KEY DEMO POINTS:                                    │
│  • CSV bulk upload — 9 loans at once                 │
│  • Entity election mismatch on TD-0163 (1120→1120S)  │
│  • 3 completed loans showing fast turnaround         │
│  • $5.5M LP acquisition just submitted               │
│  • 22 entities across pipeline                       │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│  BANC OF CALIFORNIA  (Small operation — 5-6 closers) │
├──────────────────────────────────────────────────────┤
│  Processor:  demo@bancofcal.com / BancDemo2026!      │
│  Name:       Aaron Nguyen                            │
│  Manager:    demo-manager@bancofcal.com / BancDemo26!│
│  Name:       Dawn Patterson                          │
│                                                      │
│  Requests:   ${String(banc.requestsCreated).padEnd(4)} created (7 total)                │
│  Entities:   ${String(banc.entitiesCreated).padEnd(4)} created (12 total)               │
│  Intake:     Manual (primary), PDF                   │
│  Geography:  Greater Los Angeles                     │
│                                                      │
│  KEY DEMO POINTS:                                    │
│  • Manual intake — matches their current workflow    │
│  • Digital 8821 signed in 4 hrs (vs Tax Guard wet)   │
│  • Sched C→S-Corp mismatch on BANC-039              │
│  • $59.98/req vs Tax Guard $120/entity               │
│  • Completed in 2 days vs Tax Guard 24hr+            │
└──────────────────────────────────────────────────────┘
`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
