// Search and speed set-up for the member site and the admin. Safe to run again and again.
// Run it after every artifact update, after link-admin.js, before committing:  node tools/seo-speed.js .
//   - page title, canonical link, robots, structured data (JSON-LD) on the member site
//   - admin: noindex (it must never show in search)
//   - fonts served from this site (fonts/fonts.css) instead of Google Fonts; the main font is preloaded
//   - the 3 hidden slideshow pictures load only if they are ever shown
const fs = require('fs');
const root = process.argv[2] || '.';
const HOME_T = "Bridges.directory | Talk to someone who's already there";
const DESC = "A free, verified directory of students and alumni from India's design schools: the NIFTs, the NIDs and the IITs. Find someone from your branch and ask about entrances, portfolios, campus life or work.";

function read(f) { return fs.readFileSync(root + '/' + f, 'utf8'); }
function write(f, s) { fs.writeFileSync(root + '/' + f, s); }

// fonts: drop the Google Fonts links, add the local ones
function fonts(s) {
  if (s.includes('fonts/fonts.css')) return [s, false];
  const before = s;
  s = s.replace(/<link rel="preconnect" href="https:\/\/fonts\.(googleapis|gstatic)\.com"[^>]*>\s*/g, '');
  s = s.replace(/<link href="https:\/\/fonts\.googleapis\.com\/css2[^>]*>\s*/g, '');
  const add = '<link rel="preload" href="/fonts/geist-latin.woff2" as="font" type="font/woff2" crossorigin>\n<link rel="stylesheet" href="/fonts/fonts.css">\n';
  s = s.replace(/<style>/, add + '<style>');
  return [s, s !== before];
}

// the database host is contacted on every page load, so the connection is opened while the scripts download
function preconnect(s) {
  if (s.includes('rel="preconnect" href="https://fpvqhqjdlqwfjsgblwzq')) return [s, false];
  return [s.replace(/(<meta name="viewport"[^>]*>)/, '$1\n<link rel="preconnect" href="https://fpvqhqjdlqwfjsgblwzq.supabase.co" crossorigin>'), true];
}

// ---- member site
(function () {
  let s = read('index.html'), did = [];
  const t = s.replace(/<title>[^<]*<\/title>/, '<title>' + HOME_T + '</title>');
  if (t !== s) { s = t; did.push('title'); }
  if (!s.includes('rel="canonical"')) {
    const ld = JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', '@id': 'https://bridges.directory/#website', url: 'https://bridges.directory/', name: 'Bridges.directory', description: DESC, inLanguage: 'en', publisher: { '@id': 'https://bridges.directory/#org' } },
        { '@type': 'Organization', '@id': 'https://bridges.directory/#org', name: 'Bridges.directory', url: 'https://bridges.directory/', logo: { '@type': 'ImageObject', url: 'https://bridges.directory/brand/logo-512.png', width: 512, height: 512 }, description: DESC }
      ]
    });
    const block = '\n<link rel="canonical" href="https://bridges.directory/">\n<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">\n<meta property="og:locale" content="en_IN">\n<script type="application/ld+json">' + ld + '</script>';
    s = s.replace(/(<meta name="viewport"[^>]*>)/, '$1' + block); did.push('canonical, robots, structured data');
  }
  s = s.replace(/<meta name="description" content="[^"]*">/, '<meta name="description" content="' + DESC + '">');
  { const [pc, ch] = preconnect(s); s = pc; if (ch) did.push('database preconnect'); }
  const [f, fc] = fonts(s); s = f; if (fc) did.push('local fonts');
  // slideshow pictures: the globe replaced them, so they keep their address in data-src and are not downloaded (214 KB saved)
  const sl = s.replace(/<img class="slide"([^>]*?) src="([^"]+)"/g, '<img class="slide"$1 data-src="$2"');
  if (sl !== s) { s = sl; did.push('slideshow pictures not downloaded'); }
  // the globe replaced the slideshow (hero-globe.js hides the pictures), so keep the browser from downloading them (214 KB)
  if (!s.includes('data-seo-slides')) { s = s.replace(/<style>/, '<style data-seo-slides>#v-home .stage .slide{display:none!important}</style>\n<style>'); did.push('slides hidden from the start'); }
  write('index.html', s);
  console.log('index.html: ' + (did.join(', ') || 'already done'));
})();

// ---- admin
(function () {
  let s = read('admin.html'), did = [];
  if (!s.includes('name="robots"')) { s = s.replace(/(<meta name="viewport"[^>]*>)/, '$1\n<meta name="robots" content="noindex,nofollow,noarchive">'); did.push('noindex'); }
  { const [pc, ch] = preconnect(s); s = pc; if (ch) did.push('database preconnect'); }
  const [f, fc] = fonts(s); s = f; if (fc) did.push('local fonts');
  write('admin.html', s);
  console.log('admin.html: ' + (did.join(', ') || 'already done'));
})();
