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
// The admin used to get a floating "Back to site" pill. It covered the save bar, the sidebar footer and pop-up buttons
// (on phones and on desktop), and the admin's top bar already has "Open site". So the pill is removed, and stays removed.
(function () {
  const p = root + '/admin.html';
  let s = fs.readFileSync(p, 'utf8');
  const re = /<a href="index\.html" data-backlink[^>]*>[^<]*<\/a>/g;
  if (!re.test(s)) return console.log('admin.html: no floating back link (good)');
  fs.writeFileSync(p, s.replace(re, ''));
  console.log('admin.html: floating back link removed');
})();
