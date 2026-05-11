import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data } = await supabase.from('profiles').select('id, email, full_name, role').eq('id', 'e5534e60-ea77-434c-90b5-605ca8ffcbe2');
  console.log('Other expert:', JSON.stringify(data, null, 2));

  // Also pull the full row of that open assignment for context
  const { data: assignment } = await supabase
    .from('expert_assignments')
    .select('*')
    .eq('id', 'b640eb74-5323-48c9-884b-6fd111d57c6f')
    .single();
  console.log('\nOpen assignment:', JSON.stringify(assignment, null, 2));
}
main();
