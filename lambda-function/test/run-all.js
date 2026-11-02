#!/usr/bin/env node
/** Runs every *.test.js in this directory and reports a combined total. */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const suites = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
let total = 0, failedSuites = [];

for (const suite of suites) {
    let out = '';
    try {
        out = execFileSync(process.execPath, [path.join(__dirname, suite)], { encoding: 'utf8' });
    } catch (e) {
        out = (e.stdout || '') + (e.stderr || '');
        failedSuites.push(suite);
    }
    // assert-lite suites print "N passed, M failed"; node:test suites print "ℹ pass N" / "ℹ fail M".
    const nodeTest = out.match(/^ℹ pass (\d+)$/m) && out.match(/^ℹ fail (\d+)$/m);
    const summary = (out.match(/^(\d+) passed, (\d+) failed$/m) || [])[0]
        || (nodeTest ? `${out.match(/^ℹ pass (\d+)$/m)[1]} passed, ${out.match(/^ℹ fail (\d+)$/m)[1]} failed` : 'CRASH');
    const count = Number((summary.match(/^(\d+)/) || [])[1] || 0);
    total += count;
    process.stdout.write(`  ${suite.padEnd(30)} ${summary}\n`);
    if (summary === 'CRASH') process.stdout.write(out.split('\n').slice(-12).map((l) => `      ${l}`).join('\n') + '\n');
}

console.log(`  ${'─'.repeat(46)}`);
console.log(`  ${suites.length} suite(s), ${total} test(s)${failedSuites.length ? `, FAILING: ${failedSuites.join(', ')}` : ' — all green'}`);
process.exit(failedSuites.length ? 1 : 0);
