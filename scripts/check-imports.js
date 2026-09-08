#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['.git', 'node_modules', 'artifacts', 'cache', 'dist']);
const failures = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(file); continue; }
    if (!/\.(sol|js|cjs|mjs|ts)$/.test(entry.name)) continue;
    const content = fs.readFileSync(file, 'utf8');
    const re = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
    for (const match of content.matchAll(re)) {
      const specifier = match[1];
      if (path.isAbsolute(specifier)) failures.push(path.relative(ROOT, file));
      if (specifier.startsWith('.')) {
        const rel = path.relative(ROOT, path.resolve(path.dirname(file), specifier));
        if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
          failures.push(path.relative(ROOT, file));
        }
      }
    }
  }
}
walk(ROOT);
if (failures.length) {
  console.error('[check-imports] imports outside package:', failures);
  process.exit(1);
}
console.log('[check-imports] package boundaries clean');
