// Removes the prototype's demo faculty passwords from index.html.
// The live site signs faculty in through Supabase, so these were never used; this just stops them shipping.
// Safe to run again and again. Run it after every artifact update, before committing.
const fs = require('fs');
const root = process.argv[2] || '.';
const p = root + '/index.html';
let s = fs.readFileSync(p, 'utf8');
const hint = 'Prototype: try BRF-1042 with the password bridges-demo.';
const n = (s.match(/pw:'bridges-demo'/g) || []).length + (s.includes(hint) ? 1 : 0);
if (!n) return console.log('index.html: no demo passwords left');
s = s.replace(/pw:'bridges-demo'/g, "pw:''").replace(hint, '');
fs.writeFileSync(p, s);
console.log('index.html: removed ' + n + ' demo password item(s)');
