import { readFile, writeFile } from 'fs/promises';
import { generate8821PDF } from '../lib/8821-pdf.ts';

const joelTemplate = await readFile('/Users/matthewparker/Downloads/Joel template.pdf');

// Test: overlay Jaykumar Patel's taxpayer info onto Joel's template.
// (Reusing Jaykumar since Joel's template already has Jaykumar's name in
// the taxpayer block — should overwrite it with the same data, validating
// the overlay path.)
const buf = await generate8821PDF({
  taxpayer: {
    name: 'Jaykumar Patel',
    tin: '341-02-3099',
    address: '123 Example St, Somewhere, CA 90001',
  },
  // designee is required by the type but ignored when expertTemplateBytes is set
  designee: {
    name: 'Joel Abernathy C/O ModernTax Inc',
    address: '12 St Croix Place Apt E',
    city: 'Greensboro',
    state: 'NC',
    zip: '27410',
    caf: '0312-78018R',
    ptin: 'N/A',
    phone: '336-253-5069',
  },
  formType: '1120',
  years: '2021',
  expertTemplateBytes: joelTemplate,
});

const out = `/tmp/test-joel-overlay-${Date.now()}.pdf`;
await writeFile(out, buf);
console.log(`✓ Generated ${buf.length} bytes → ${out}`);
console.log(`  open ${out} to inspect the rendered output`);
