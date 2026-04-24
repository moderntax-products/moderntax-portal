import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.vercel-prod') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  // Get all non-delivered webhook deliveries
  const { data: deliveries } = await supabase
    .from('webhook_deliveries')
    .select('id, request_id, status, attempts, max_attempts, last_error, last_status_code, webhook_url, payload, next_retry_at')
    .in('status', ['pending', 'failed', 'sending', 'dead'])
    .order('created_at');

  console.log(`Found ${deliveries?.length || 0} non-delivered webhook deliveries:\n`);

  for (const d of (deliveries || [])) {
    const payload = d.payload as any;
    const payloadSize = JSON.stringify(payload).length;
    const filesCount = payload?.files?.length || payload?.reports?.length || 0;

    console.log(`ID: ${d.id.slice(0, 8)}  Request: ${d.request_id.slice(0, 8)}`);
    console.log(`  Status: ${d.status}  Attempts: ${d.attempts}/${d.max_attempts}`);
    console.log(`  Last error: ${d.last_error || 'none'}`);
    console.log(`  Payload status: ${payload?.status}  Files/Reports: ${filesCount}  Size: ${(payloadSize / 1024).toFixed(1)}KB`);
    console.log(`  Token: ${payload?.request_token}`);
    console.log(`  URL: ${d.webhook_url}`);
    console.log(`  Next retry: ${d.next_retry_at || 'none'}`);

    // Show file details
    if (payload?.files) {
      for (const f of payload.files) {
        console.log(`    File: ${f.type} ${f.year || ''} ${f.entity_name} (${(f.html?.length || 0)} chars HTML)`);
      }
    }
    if (payload?.reports) {
      for (const r of payload.reports) {
        console.log(`    Report: ${r.type} ${r.tax_period || ''} (${(r.html?.length || 0)} chars HTML)`);
      }
    }
    console.log('');
  }

  // Also show delivered count by request
  const { data: allDeliveries } = await supabase
    .from('webhook_deliveries')
    .select('request_id, status')
    .order('created_at');

  const byRequest = new Map<string, { delivered: number; failed: number; pending: number; dead: number }>();
  for (const d of (allDeliveries || [])) {
    if (!byRequest.has(d.request_id)) byRequest.set(d.request_id, { delivered: 0, failed: 0, pending: 0, dead: 0 });
    const counts = byRequest.get(d.request_id)!;
    if (d.status === 'delivered') counts.delivered++;
    else if (d.status === 'failed') counts.failed++;
    else if (d.status === 'pending') counts.pending++;
    else if (d.status === 'dead') counts.dead++;
  }

  console.log('=== DELIVERY SUMMARY BY REQUEST ===');
  for (const [reqId, counts] of byRequest) {
    console.log(`Request ${reqId.slice(0, 8)}: delivered=${counts.delivered} failed=${counts.failed} pending=${counts.pending} dead=${counts.dead}`);
  }
}

main().catch(console.error);
