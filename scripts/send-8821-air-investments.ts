import * as DropboxSign from '@dropbox/sign';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const API_KEY = process.env.DROPBOX_SIGN_API_KEY || '';
const TEMPLATE_BUSINESS = '6e08048317bb0efd8cf976c2cc14159ca51ef584';

const DESIGNEE = {
  name: 'Matthew Parker C/O ModernTax',
  address: '2 Embarcadero, 8th Floor',
  city: 'San Francisco',
  state: 'CA',
  zip: '94111',
  ptin: 'P01809554',
  caf: '0316-30210R',
};

async function main() {
  const api = new DropboxSign.SignatureRequestApi();
  api.username = API_KEY;

  const entityName = 'Air Investments Inc';
  const entityEIN = '844882436';
  const entityAddress = '5440 Heatherland Dr, San Ramon, CA, 94582';
  const signerEmail = 'komalsarang1@gmail.com';
  const designeeFullAddress = `${DESIGNEE.name}\n${DESIGNEE.address}, ${DESIGNEE.city}, ${DESIGNEE.state} ${DESIGNEE.zip}`;

  const customFields = [
    // Section 1: Taxpayer
    { name: 'Taxpayer Name', value: entityName },
    { name: 'EIN/SSN', value: entityEIN },
    { name: 'Business Address, City, State, Zip Code', value: entityAddress },
    // Section 2: Designee
    { name: 'Designee Name, Address, City State Zip', value: `${designeeFullAddress}\nPTIN: ${DESIGNEE.ptin}` },
    { name: 'CAF', value: DESIGNEE.caf },
  ];

  const signatureData: DropboxSign.SignatureRequestSendWithTemplateRequest = {
    templateIds: [TEMPLATE_BUSINESS],
    signers: [
      {
        role: 'Taxpayer',
        name: entityName,
        emailAddress: signerEmail,
      },
    ],
    ccs: [
      {
        role: 'Credit Analyst',
        emailAddress: 'matt@moderntax.io',
      },
    ],
    subject: `Form 8821 — Tax Information Authorization for ${entityName}`,
    message: `Please sign this IRS Form 8821 to authorize ModernTax to obtain tax transcripts on behalf of ${entityName}. This authorization covers tax years 2022–2025 for Form 1120 (Income). Designee: ${DESIGNEE.name} (PTIN: ${DESIGNEE.ptin}, CAF: ${DESIGNEE.caf}).`,
    metadata: {
      entity_name: entityName,
      form_type: '1120',
      designee_name: DESIGNEE.name,
      designee_ptin: DESIGNEE.ptin,
      designee_caf: DESIGNEE.caf,
      years: '2025, 2024, 2023, 2022',
      tax_type: 'Income',
    },
    customFields,
  };

  console.log('Sending 8821 signature request for Air Investments Inc...');
  console.log('Template: Business (1120)');
  console.log('Signer:', signerEmail);
  console.log('Designee:', DESIGNEE.name);
  console.log('Custom Fields:', JSON.stringify(customFields, null, 2));

  try {
    const result = await api.signatureRequestSendWithTemplate(signatureData);
    const signatureRequestId = result.body?.signatureRequest?.signatureRequestId;
    const signingUrl = result.body?.signatureRequest?.signatures?.[0]?.signerEmailAddress;

    console.log('\n✅ Signature request sent successfully!');
    console.log('Signature Request ID:', signatureRequestId);
    console.log('Signer Email:', signingUrl);
    console.log('\nThe signer will receive an email from Dropbox Sign to complete the form.');
  } catch (error: any) {
    console.error('\n❌ Error:', error?.body || error?.message || error);
  }
}

main();
