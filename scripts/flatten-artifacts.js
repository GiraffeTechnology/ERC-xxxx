#!/usr/bin/env node
/**
 * Hardhat writes artifacts to artifacts/<source path>/<Name>.json.
 * check-frozen-erc-constants.js reads artifacts/<Name>.json.
 * Copy the two interface artifacts up to where it looks.
 */

const fs = require('fs');
const path = require('path');

const ARTIFACTS = path.join(__dirname, '..', 'artifacts');
const WANTED = ['IRegisterProjection', 'IProjectionSettlement'];

function find(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = find(full, name);
      if (hit) return hit;
    } else if (entry.name === `${name}.json` && path.dirname(full) !== ARTIFACTS) {
      return full;
    }
  }
  return null;
}

let missing = false;
for (const name of WANTED) {
  const src = find(ARTIFACTS, name);
  if (!src) {
    console.error(`[flatten-artifacts] no compiled artifact for ${name}`);
    missing = true;
    continue;
  }
  fs.copyFileSync(src, path.join(ARTIFACTS, `${name}.json`));
  console.log(`[flatten-artifacts] ${name}.json <- ${path.relative(ARTIFACTS, src)}`);
}
if (missing) process.exit(1);
