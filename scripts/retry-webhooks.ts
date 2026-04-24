import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import crypto from 'crypto';

dotenv.config({ path: path.resolve(__dirname, '../.env.vercel-prod') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function deliverWithLongTimeout(deliveryId: string): Promise<boolean> {
  const { data: delivery } = await supabase
    .from('webhook_deliveries')
    .select('*')
    .eq('id', deliveryId)
    .single();

  if (!delivery) {
    console.error(`Delivery ${deliveryId} not found`);
    return false;
  }

  console.log(`\nAttempting delivery ${deliveryId.slice(0, 8)}...`);
  console.log(`  Token: ${delivery.payload?.request_token}`);
  console.log(`  Status: ${delivery.payload?.status}`);
  console.log(`  Payload size: ${(JSON.stringify(delivery.payload).length / 1024).toFixed(1)}KB`);

  const payloadString = JSON.stringify(delivery.payload);
  const now = new Date().toISOString();

  // Mark as sending
  await supabase
    .from('webhook_deliveries')
    .update({ status: 'sending', updated_at: now })
    .eq('id', deliveryId);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'ModernTax-Webhook/1.0',
    };

    // Sign if we have a secret
    const { data: client } = await supabase
      .from('clients')
      .select('webhook_secret')
      .eq('id', delivery.client_id)
      .single();

    if (client?.webhook_secret) {
      headers['X-ModernTax-Signature'] = crypto
        .createHmac('sha256', client.webhook_secret)
        .update(payloadString)
        .digest('hex');
    }

    // 60 second timeout for cold starts
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    console.log(`  POSTing to ${delivery.webhook_url}...`);
    const startTime = Date.now();

    const response = await fetch(delivery.webhook_url, {
      method: 'POST',
      headers,
      body: payloadString,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const elapsed = Date.now() - startTime;
    const statusCode = response.status;
    const responseText = await response.text().catch(() => '');

    console.log(`  Response: HTTP ${statusCode} in ${elapsed}ms`);
    console.log(`  Body: ${responseText.slice(0, 200)}`);

    if (statusCode >= 200 && statusCode < 300) {
      await supabase
        .from('webhook_deliveries')
        .update({
          status: 'delivered',
          attempts: delivery.attempts + 1,
          last_attempt_at: now,
          last_status_code: statusCode,
          last_error: null,
          delivered_at: now,
          updated_at: now,
        })
        .eq('id', deliveryId);
      console.log(`  ✅ DELIVERED`);
      return true;
    } else {
      await supabase
        .from('webhook_deliveries')
        .update({
          status: 'failed',
          attempts: delivery.attempts + 1,
          last_attempt_at: now,
          last_status_code: statusCode,
          last_error: `HTTP ${statusCode}: ${responseText.slice(0, 500)}`,
          updated_at: now,
        })
        .eq('id', deliveryId);
      console.log(`  ❌ FAILED: HTTP ${statusCode}`);
      return false;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    await supabase
      .from('webhook_deliveries')
      .update({
        status: 'failed',
        attempts: delivery.attempts + 1,
        last_attempt_at: now,
        last_error: errorMessage,
        updated_at: now,
      })
      .eq('id', deliveryId);
    console.log(`  ❌ ERROR: ${errorMessage}`);
    return false;
  }
}

async function main() {
  // Get all non-delivered deliveries
  const { data: deliveries } = await supabase
    .from('webhook_deliveries')
    .select('id, status')
    .in('status', ['pending', 'failed', 'sending'])
    .order('created_at');

  console.log(`Found ${deliveries?.length || 0} deliveries to retry`);

  // Wake up Render first with a HEAD request
  console.log('\nWaking up ClearFirm endpoint...');
  try {
    const wakeResponse = await fetch('https://clearfirm-api.onrender.com/api/v1/webhook/moderntax', {
      method: 'HEAD',
    });
    console.log(`  Wake response: ${wakeResponse.status}`);
    // Wait a moment for cold start
    await new Promise(resolve => setTimeout(resolve, 3000));
  } catch (e) {
    console.log('  Wake request failed, proceeding anyway');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  let delivered = 0;
  let failed = 0;

  for (const d of (deliveries || [])) {
    const success = await deliverWithLongTimeout(d.id);
    if (success) delivered++;
    else failed++;
    // Small delay between deliveries
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Delivered: ${delivered}`);
  console.log(`Failed: ${failed}`);
}

main().catch(console.error);
