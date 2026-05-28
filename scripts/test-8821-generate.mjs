import { writeFile } from 'fs/promises';
import path from 'path';
import { generate8821PDF } from '../lib/8821-pdf.ts';

const buf = await generate8821PDF({
  taxpayer: {
    name: 'Ram Threading, Inc.',
    tin: '12-3456789',
    address: '123 Industrial Way, San Jose, CA 95113',
  },
  designee: {
    name: 'Joel Abernathy C/O ModernTax Inc',
    address: '12 St Croix Place Apt E',
    city: 'Greensboro',
    state: 'NC',
    zip: '27410',
    caf: '0312-78018R',
    ptin: 'N/A',
    phone: '336-253-5069',
    fax: '415-900-4436',
  },
  formType: '1120',
  years: '2021',
});

const out = path.join('/tmp', `test-8821-${Date.now()}.pdf`);
await writeFile(out, buf);
console.log(`Generated ${buf.length} bytes → ${out}`);
