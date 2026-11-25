// Safety patches on Atharva's pages. Safe to run again and again.
// Run after every artifact update, after seo-speed.js, before committing:  node tools/harden-client.js .
//   - avatar drawing no longer crashes on odd stored values (negative numbers, unknown preset)
//   - leftover prototype code that used Math.random for codes/passwords now uses the secure generator
//   - frame protection: the member site and the admin hide themselves and break out if shown inside another site's frame (clickjacking)
const fs = require('fs');
const root = process.argv[2] || '.';
const read = f => fs.readFileSync(root + '/' + f, 'utf8');
const write = (f, s) => fs.writeFileSync(root + '/' + f, s);

const GUARD = '<script data-frame-guard>if(window.top!==window.self){document.documentElement.style.display="none";try{window.top.location.href=window.self.location.href}catch(e){}}</script>';
function frame(f) {
  let s = read(f);
  if (s.includes('data-frame-guard')) return console.log(f + ': frame protection already there');
  if (!/<head>/.test(s)) return console.log(f + ': no <head>, frame protection NOT added');
  s = s.replace('<head>', '<head>\n' + GUARD);
  write(f, s); console.log(f + ': frame protection added');
}

(function () {
  let s = read('index.html');
  const oldA = "  if(!AV_HAIR[s.h]) s.h = AV_PRESET_DEF[s.p].h;\n  s.f = +s.f % 6 || 0; s.g = +s.g % 6 || 0; s.b = +s.b % 7 || 0; s.s = +s.s % 16 || 0; s.bg = +s.bg % 15 || 0;";
  const newA = "  if(!Object.prototype.hasOwnProperty.call(AV_PRESET_DEF, s.p)) s.p = 'a';\n  if(!Object.prototype.hasOwnProperty.call(AV_HAIR, s.h)) s.h = AV_PRESET_DEF[s.p].h;\n  const md = (v, n) => (((+v % n) + n) % n) || 0;\n  s.f = md(s.f, 6); s.g = md(s.g, 6); s.b = md(s.b, 7); s.s = md(s.s, 16); s.bg = md(s.bg, 15);";
  if (s.includes(newA)) console.log('index.html: avatar safety already there');
  else if (s.includes(oldA)) { s = s.replace(oldA, newA); write('index.html', s); console.log('index.html: avatar safety added'); }
  else console.log('index.html: avatar lines not found (design file changed?), NOT patched');
})();
frame('index.html');
frame('admin.html');

// Prototype leftovers that make codes, passwords and IDs with Math.random (predictable). The live site does not use them (the server makes the real
// ones), but they are switched to the browser's secure random generator so they are safe even if something ever calls them.
const RND = 'const rnd = n => crypto.getRandomValues(new Uint32Array(1))[0] % n;';
function secureRandom(f) {
  let s = read(f), did = [];
  if (f === 'index.html') {
    const before = s;
    s = s.split('String(100000 + Math.floor(Math.random() * 900000))').join('String(100000 + rnd(900000))');
    s = s.replace("const refCode = () => 'BR-'+Math.random().toString(36).slice(2, 6).toUpperCase();",
      RND + "\nconst refCode = () => 'BR-'+Array.from({length:4}, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[rnd(32)]).join('');");
    if (s !== before) did.push('codes');
  } else {
    const before = s;
    s = s.replace("function newFid(){ let id; do { id = 'BRF-'+(1000 + Math.floor(Math.random() * 9000)); }",
      RND + "\nfunction newFid(){ let id; do { id = 'BRF-'+(1000 + rnd(9000)); }");
    s = s.replace("const w = () => WORDS[Math.floor(Math.random() * WORDS.length)];", "const w = () => WORDS[rnd(WORDS.length)];");
    s = s.replace("(10 + Math.floor(Math.random() * 90))", "(10 + rnd(90))");
    if (s !== before) did.push('faculty ID and password');
  }
  if (did.length) { write(f, s); console.log(f + ': secure random for ' + did.join(', ')); } else console.log(f + ': secure random already there (or lines not found)');
}
secureRandom('index.html');
secureRandom('admin.html');

// Students who joined before the "fields" question have no field picked. The edit form refused to save ANYTHING until they picked one, with only a small
// line of text, so their edits looked like "not saving". Now only someone who had fields and removes them all is stopped; the join form still requires one.
(function () {
  let s = read('index.html');
  const oldF = "if(!fl.length){ err.textContent = 'Pick at least one field you work in.'; return; } u.fields = fl;";
  const newF = "if(!fl.length && (u.fields || []).length){ err.textContent = 'Pick at least one field you work in.'; return; } u.fields = fl;";
  if (s.includes(newF)) console.log('index.html: fields rule already relaxed for students with none');
  else if (s.includes(oldF)) { s = s.replace(oldF, newF); write('index.html', s); console.log('index.html: students with no fields can now save other changes'); }
  else console.log('index.html: fields rule line not found (design file changed?), NOT patched');
})();

// Alums with no experience saved (or an empty row left in the editor) could not save ANY change: the editor always shows one empty row, it cannot be
// removed when it is the only one, and the form demanded a role in it. Now a completely empty row is simply ignored; a row with a company but no role is still stopped.
(function () {
  let s = read('index.html');
  const oldA = "exp = xpRead($('#pf'));";
  const newA = "exp = xpRead($('#pf')).filter(x => x.role || x.org);";
  const oldB = "const blank = exp.findIndex(x => !x.role);";
  const newB = "const blank = $$('#pf .xp').findIndex(r => !$('[data-k=\"role\"]', r).value.trim() && $('[data-k=\"org\"]', r).value.trim());";
  if (s.includes(newA) && s.includes(newB)) console.log('index.html: empty experience row already ignored on save');
  else if (s.includes(oldA) && s.includes(oldB)) { s = s.replace(oldA, newA).replace(oldB, newB); write('index.html', s); console.log('index.html: an empty experience row no longer blocks saving'); }
  else console.log('index.html: experience rule lines not found (design file changed?), NOT patched');
})();
