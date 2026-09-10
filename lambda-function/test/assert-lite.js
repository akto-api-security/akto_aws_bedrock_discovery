/**
 * Minimal test reporter. Node's built-in test runner would do, but these suites run
 * as plain scripts inside the Lambda bundle's own directory — no dev dependencies,
 * no config, `node test/<name>.test.js` and it works.
 */
let passed = 0, failed = 0;

function section(title) { console.log(`\n── ${title} ──`); }

function check(name, fn) {
    try { fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message.split('\n')[0]}`); }
}

async function acheck(name, fn) {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message.split('\n')[0]}`); }
}

function done() {
    console.log(`\n${'='.repeat(62)}\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

module.exports = { section, check, acheck, done };
