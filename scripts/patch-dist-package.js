/**
 * Patches dist/main/package.json with npm overrides to fix dependency hoisting issues.
 * d3-time@1.x gets hoisted over d3-time@3.x, breaking d3-scale which needs timeTickInterval.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const pkgPath = 'dist/main/package.json';
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.overrides = { 'd3-time': '3' };
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
