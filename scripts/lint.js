#!/usr/bin/env node
/**
 * Style checks with no external linter, so CI needs nothing beyond npm ci.
 *
 * Solidity: every file carries an SPDX identifier and a pragma.
 * Everything tracked: LF endings, no tabs, no trailing whitespace, ends with a
 * newline. Solidity additionally must be ASCII -- a homoglyph in an identifier
 * is a real hazard there. Markdown is prose and JS scanners must be able to
 * spell the tokens they look for, so neither is checked for ASCII.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP = /node_modules|\.git|artifacts|cache|dist|package-lock\.json/;
const TEXT = /\.(sol|js|cjs|mjs|ts|json|yml|yaml|md)$/i;

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (SKIP.test(full)) continue;
    if (entry.isDirectory()) out.push(...walk(full));
    else if (TEXT.test(entry.name)) out.push(full);
  }
  return out;
}

const problems = [];
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  const raw = fs.readFileSync(file, 'utf8');

  if (raw.includes('\r')) problems.push(`${rel}: CRLF line ending`);
  if (raw.length && !raw.endsWith('\n')) problems.push(`${rel}: no trailing newline`);
  raw.split('\n').forEach((line, i) => {
    if (line.includes('\t')) problems.push(`${rel}:${i + 1}: tab character`);
    if (/[ ]+$/.test(line)) problems.push(`${rel}:${i + 1}: trailing whitespace`);
  });

  if (/\.sol$/i.test(file)) {
    if (!/SPDX-License-Identifier:/.test(raw)) problems.push(`${rel}: missing SPDX identifier`);
    if (!/^pragma solidity /m.test(raw)) problems.push(`${rel}: missing solidity pragma`);
  }
  if (/\.sol$/i.test(file) && /[^\x00-\x7F]/.test(raw)) {
    problems.push(`${rel}: non-ASCII character in Solidity source`);
  }
}

if (problems.length) {
  console.error('[lint] problems found:');
  for (const p of problems.slice(0, 50)) console.error(`  ${p}`);
  if (problems.length > 50) console.error(`  ... and ${problems.length - 50} more`);
  process.exit(1);
}
console.log('[lint] clean');
