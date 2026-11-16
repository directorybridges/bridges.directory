// Adds the backend scripts to Atharva's pages. Safe to run again and again.
// Run after every artifact update (the update replaces index.html and admin.html), before committing.
const fs = require('fs');
const root = process.argv[2] || '.';
function wire(file, tags) {
  const p = root + '/' + file;
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes('data-wire="backend"')) return console.log(file + ': already wired');
  if (!s.includes('</body>')) return console.log(file + ': no </body>, NOT wired');
  const add = tags.map(t => `<script src="${t}" data-wire="backend"></script>`).join('\n');
  s = s.replace('</body>', add + '\n</body>');
  fs.writeFileSync(p, s);
  console.log(file + ': wired');
}
// Light mode by default (client request): runs first, in <head>, so the page never flashes dark.
function wireTheme(file) {
  const p = root + '/' + file;
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes('data-wire="theme"')) return console.log(file + ': theme already wired');
  if (!s.includes('<head>')) return console.log(file + ': no <head>, theme NOT wired');
  s = s.replace('<head>', '<head>\n<script src="theme-default.js" data-wire="theme"></script>');
  fs.writeFileSync(p, s);
  console.log(file + ': theme wired');
}
wireTheme('index.html');
wireTheme('admin.html');
wire('index.html', ['bridges-config.js', 'vendor/supabase.js', 'redact.js', 'bridges-backend.js']);
wire('admin.html', ['bridges-config.js', 'vendor/supabase.js', 'admin-backend.js']);
