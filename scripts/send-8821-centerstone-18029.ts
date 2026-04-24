/**
 * Send 8821 signature requests for Centerstone Request #18029 (Peter Geyen entities)
 *
 * Entities:
 * 1. Great Lakes Wood Co LLC — EIN 92-2849546, 1120S, 2023-2024
 * 2. Peter Geyen Inc — EIN 27-0421727, 1120S, 2022-2024
 * 3. Peter Geyen — SSN 346-78-3153, 1040, 2022-2024
 *
 * Signer: Peter Geyen <peter@greatlakeswood.com>
 * Designee: LaTonya Holmes (default Clearfirm designee)
 */

import * as DropboxSign from '@dropbox/sign';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const API_KEY = process.env.DROPBOX_SIGN_API_KEY || '';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const TEMPLATE_INDIVIDUAL = 'a34ce6060750406fc9464d1d46bf99e053c1c177';
const TEMPLATE_BUSINESS = '6e08048317bb0efd8cf976c2cc14159ca51ef584';

const DESIGNEE = {
  name: 'LaTonya Holmes',
  address: '8465 Houndstooth Enclave Dr',
  city: 'New Port Richey',
  state: 'FL',
  zip: '34655',
  ptin: '0316-30210',
  caf: '0315-23541R',
};

const SIGNER = {
  name: 'Peter Geyen',
  email: 'peter@greatlakeswood.com',
  firstName: 'Peter',
  lastName: 'Geyen',
};

const REQUEST_ID = '4c697df8-f7f1-4aea-a309-3c4a0026eccd';

interface Entity {
  entityName: string;
  tid: string;
  tidKind: 'SSN' | 'EIN';
  formType: string;
  years: string;
  address: string;
  isIndividual: boolean;
}

const ENTITIES: Entity[] = [
  {
    entityName: 'Great Lakes Wood Co LLC',
    tid: '922849546',
    tidKind: 'EIN',
    formType: '1120S',
    years: '2023, 2024',
    address: '5579 Gamble Rd, Duluth, MN, 55804',
    isIndividual: false,
  },
  {
    entityName: 'Peter Geyen Inc',
    tid: '270421727',
    tidKind: 'EIN',
    formType: '1120S',
    years: '2022, 2023, 2024',
    address: '5579 Gamble Rd, Duluth, MN, 55804',
    isIndividual: false,
  },
  {
    entityName: 'Peter Geyen',
    tid: '346783153',
    tidKind: 'SSN',
    formType: '1040',
    years: '2022, 2023, 2024',
    address: '5579 Gamble Rd, Duluth, MN, 55804',
    isIndividual: true,
  },
];

async function main() {
  const api = new DropboxSign.SignatureRequestApi();
  api.username = API_KEY;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // First, look up the entity IDs from the database
  const { data: dbEntities, error: fetchError } = await supabase
    .from('request_entities')
    .select('id, entity_name, tid, form_type, status, signature_id, signer_email')
    .eq('request_id', REQUEST_ID);

  if (fetchError) {
    console.error('Failed to fetch entities:', fetchError);
    return;
  }

  console.log(`Found ${dbEntities?.length || 0} entities in DB for request ${REQUEST_ID}:`);
  dbEntities?.forEach((e: any) => console.log(`  - ${e.entity_name} (${e.tid}) — status: ${e.status}, sig: ${e.signature_id || 'none'}`));

  const designeeFullAddress = `${DESIGNEE.name}\n${DESIGNEE.address}, ${DESIGNEE.city}, ${DESIGNEE.state} ${DESIGNEE.zip}`;

  for (const entity of ENTITIES) {
    // Match to DB entity
    const dbEntity = dbEntities?.find((e: any) => e.entity_name === entity.entityName);
    if (!dbEntity) {
      console.error(`\n❌ Entity not found in DB: ${entity.entityName}`);
      continue;
    }

    if (dbEntity.signature_id) {
      console.log(`\n⏭️  Skipping ${entity.entityName} — already has signature_id: ${dbEntity.signature_id}`);
      continue;
    }

    const templateId = entity.isIndividual ? TEMPLATE_INDIVIDUAL : TEMPLATE_BUSINESS;
    const templateLabel = entity.isIndividual ? 'Individual (1040)' : `Business (${entity.formType})`;

    const customFields = entity.isIndividual
      ? [
          { name: 'Taxpayer Name', value: entity.entityName },
          { name: 'EIN/SSN Number', value: entity.tid },
          { name: 'Address, City, State, Zip', value: entity.address },
          { name: 'Tax Practioner', value: DESIGNEE.name },
          { name: 'Tax Practioner City, State, Zip Code', value: `${DESIGNEE.address}, ${DESIGNEE.city}, ${DESIGNEE.state} ${DESIGNEE.zip}` },
          { name: 'CAF Number', value: DESIGNEE.caf },
        ]
      : [
          { name: 'Taxpayer Name', value: entity.entityName },
          { name: 'EIN/SSN', value: entity.tid },
          { name: 'Business Address, City, State, Zip Code', value: entity.address },
          { name: 'Designee Name, Address, City State Zip', value: `${designeeFullAddress}\nPTIN: ${DESIGNEE.ptin}` },
          { name: 'CAF', value: DESIGNEE.caf },
        ];

    const signatureData: DropboxSign.SignatureRequestSendWithTemplateRequest = {
      testMode: true,
      templateIds: [templateId],
      signers: [
        {
          role: 'Taxpayer',
          name: SIGNER.name,
          emailAddress: SIGNER.email,
        },
      ],
      ccs: [
        {
          role: 'Credit Analyst',
          emailAddress: 'matt@moderntax.io',
        },
      ],
      subject: `Form 8821 — Tax Information Authorization for ${entity.entityName}`,
      message: `Please sign this IRS Form 8821 to authorize ModernTax to obtain tax transcripts on behalf of ${entity.entityName}. This covers ${entity.formType} for tax years ${entity.years}. Designee: ${DESIGNEE.name} (PTIN: ${DESIGNEE.ptin}, CAF: ${DESIGNEE.caf}).`,
      metadata: {
        entity_id: dbEntity.id,
        entity_name: entity.entityName,
        form_type: entity.formType,
        request_id: REQUEST_ID,
        client: 'centerstone',
        designee_name: DESIGNEE.name,
        designee_ptin: DESIGNEE.ptin,
        designee_caf: DESIGNEE.caf,
        years: entity.years,
      },
      customFields,
    };

    console.log(`\nSending 8821 for ${entity.entityName}...`);
    console.log(`  Template: ${templateLabel}`);
    console.log(`  Signer: ${SIGNER.name} <${SIGNER.email}>`);
    console.log(`  TID: ${entity.tid} (${entity.tidKind})`);
    console.log(`  Years: ${entity.years}`);

    try {
      const result = await api.signatureRequestSendWithTemplate(signatureData);
      const signatureRequestId = result.body?.signatureRequest?.signatureRequestId;

      if (signatureRequestId) {
        console.log(`  ✅ Sent! Signature Request ID: ${signatureRequestId}`);

        // Update entity in DB
        const { error: updateError } = await supabase
          .from('request_entities')
          .update({
            signature_id: signatureRequestId,
            status: '8821_sent',
            signer_email: SIGNER.email,
            signer_first_name: SIGNER.firstName,
            signer_last_name: SIGNER.lastName,
          })
          .eq('id', dbEntity.id);

        if (updateError) {
          console.error(`  ⚠️  DB update failed:`, updateError.message);
        } else {
          console.log(`  ✅ DB updated — status: 8821_sent`);
        }
      } else {
        console.error(`  ❌ No signature request ID returned`);
      }
    } catch (error: any) {
      console.error(`  ❌ Error:`, error?.body || error?.message || error);
    }

    // Rate limit: 1 second between Dropbox Sign API calls
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log('\nDone!');
}

main();
