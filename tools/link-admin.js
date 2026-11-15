// Links the member site and the admin prototype to each other.
// Safe to run again and again. Run it after every artifact update, before committing.
const fs = require('fs');
const root = process.argv[2] || '.';
function patch(file, marker, find, add, where) {
  const p = root + '/' + file;
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes(marker)) return console.log(file + ': already linked');
  if (!s.includes(find)) return console.log(file + ': anchor not found, NOT linked');
  s = s.replace(find, where === 'before' ? add + find : find + add);
  fs.writeFileSync(p, s);
  console.log(file + ': linked');
}
patch('index.html', 'data-adminlink',
  '<a href="#guidelines">Community guidelines</a>',
  '<a href="admin.html" data-adminlink>Admin</a>', 'after');
patch('admin.html', 'data-backlink',
  '</body>',
  '<a href="index.html" data-backlink style="position:fixed;left:12px;bottom:12px;z-index:99999;font:600 12px/1 system-ui,sans-serif;padding:8px 12px;border-radius:999px;background:#111;color:#fff;text-decoration:none;opacity:.85">&larr; Back to site</a>', 'before');
