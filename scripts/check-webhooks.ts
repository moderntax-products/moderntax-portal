import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.vercel-prod') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  const { data, error } = await supabase
    .from('webhook_deliveries')
    .select('id, request_id, status, attempts, last_status_code, last_error, delivered_at, created_at')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.log('No webhook deliveries found.');
    return;
  }

  console.log(`\nTotal webhook deliveries: ${data.length}\n`);
  console.log(
    'id'.padEnd(10) +
    'request'.padEnd(10) +
    'status'.padEnd(12) +
    'att'.padEnd(5) +
    'code'.padEnd(6) +
    'delivered_at'.padEnd(22) +
    'last_error'
  );
  console.log('-'.repeat(100));

  for (const row of data) {
    const id = row.id.substring(0, 8);
    const reqId = row.request_id.substring(0, 8);
    const status = (row.status || '').padEnd(12);
    const attempts = String(row.attempts ?? '').padEnd(5);
    const code = String(row.last_status_code ?? '-').padEnd(6);
    const delivered = (row.delivered_at ? row.delivered_at.substring(0, 19).replace('T', ' ') : '-').padEnd(22);
    const lastErr = row.last_error ? row.last_error.substring(0, 60) : '-';

    console.log(`${id.padEnd(10)}${reqId.padEnd(10)}${status}${attempts}${code}${delivered}${lastErr}`);
  }
}

main().catch(console.error);
