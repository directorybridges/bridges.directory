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
// Logo (favicon, app icon) and the WhatsApp/social preview image. A new artifact export would drop these head tags,
// so they are put back here. Files live in /brand (logo from Atharva, Frame 9 on white; preview = the globe home hero).
(function () {
  const common = '\n<link rel="icon" href="/favicon.ico" sizes="48x48">\n<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png">\n<link rel="icon" type="image/png" sizes="16x16" href="/brand/favicon-16.png">\n<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">\n<link rel="manifest" href="/site.webmanifest">\n<meta name="theme-color" content="#000000">';
  const og = (t, d, u) => '\n<meta name="description" content="' + d + '">' + common + '\n<meta property="og:type" content="website">\n<meta property="og:site_name" content="Bridges.directory">\n<meta property="og:title" content="' + t + '">\n<meta property="og:description" content="' + d + '">\n<meta property="og:url" content="' + u + '">\n<meta property="og:image" content="https://bridges.directory/brand/og-image.jpg">\n<meta property="og:image:type" content="image/jpeg">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:title" content="' + t + '">\n<meta name="twitter:description" content="' + d + '">\n<meta name="twitter:image" content="https://bridges.directory/brand/og-image.jpg">';
  [['index.html', '<title>Bridges.directory</title>', og('Bridges.directory', "Talk to someone who's already there. Verified alumni and students from India's design schools.", 'https://bridges.directory/')],
   ['admin.html', '<title>Bridges admin</title>', og('Bridges admin', 'Bridges.directory admin', 'https://bridges.directory/admin')]].forEach(([f, anchor, tags]) => {
    const p = root + '/' + f; let s = fs.readFileSync(p, 'utf8');
    if (s.includes('property="og:image"')) return console.log(f + ': logo and preview tags already there');
    if (!s.includes(anchor)) return console.log(f + ': title anchor not found, logo and preview tags NOT added');
    fs.writeFileSync(p, s.replace(anchor, anchor + tags)); console.log(f + ': logo and preview tags added');
  });
})();
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
