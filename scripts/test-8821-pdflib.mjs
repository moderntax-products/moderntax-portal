import { readFile } from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import path from 'path';

async function inspect(name) {
  const p = path.join(process.cwd(), 'public', 'templates', name);
  const bytes = await readFile(p);
  const doc = await PDFDocument.load(bytes);
  const form = doc.getForm();
  const fields = form.getFields();
  console.log(`\n${name}: ${fields.length} fields`);
  const matches = fields.filter(f => /\bf1_(\d+)/.test(f.getName())).slice(0, 30);
  for (const f of matches.slice(0, 10)) {
    console.log(`  ${f.getName()}  [${f.constructor.name}]`);
  }
  if (matches.length > 10) console.log(`  ... and ${matches.length - 10} more`);
}

await inspect('8821-individual-v2.pdf');
await inspect('8821-business-v2.pdf');
