// Safety patches on Atharva's pages. Safe to run again and again.
// Run after every artifact update, after seo-speed.js, before committing:  node tools/harden-client.js .
//   - avatar drawing no longer crashes on odd stored values (negative numbers, unknown preset)
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
