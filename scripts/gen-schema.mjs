// Generates docs/note.schema.json from the zod schema (built via esbuild on the fly).
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const dir = mkdtempSync(join(tmpdir(), 'rn-schema-'));
const out = join(dir, 'schema.mjs');
await build({ entryPoints: ['src/shared/schema.ts'], outfile: out, bundle: true, format: 'esm', platform: 'node', logLevel: 'error' });
const mod = await import(pathToFileURL(out).href);
const schema = z.toJSONSchema(mod.NoteSchema);
writeFileSync('docs/note.schema.json', JSON.stringify({ title: 'Review Notes Note (schemaVersion 1)', ...schema }, null, 2) + '\n');
console.log('docs/note.schema.json written');
