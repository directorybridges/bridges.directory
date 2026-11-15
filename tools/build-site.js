// Builds the small public site (docs/) from Aman's original demo (index.html).
// Run: node build-site.js "<repo folder>"
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = process.argv[2];
const SRC = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const OUT = path.join(REPO, 'docs');

/* ---- details Aman still has to confirm. Leave null to keep the visible [bracket] placeholder. ---- */
const FILL = {
  legalName: null,       // "[legal name of the team or entity, to be confirmed]"
  grievanceName: null,   // "[Name]" (grievance officer)
  jurisdictionCity: null // "[city, to be confirmed]"
};
const CONTACT = 'directorybridges@gmail.com'; // Aman: "the email for all communications"
const UPDATED = '15 November 2026';

/* ---- pull the CSS and the About/legal text out of the original ---- */
const css = SRC.slice(SRC.indexOf('<style>') + 7, SRC.indexOf('</style>'));
const dStart = SRC.indexOf('const DOCS = {');
const dEnd = SRC.indexOf('function renderDoc');
let objText = SRC.slice(dStart + 'const DOCS = '.length, dEnd).trim().replace(/;$/, '');
const DOCS = vm.runInNewContext('(' + objText + ')');

const edits = [];
function swap(s, a, b, why) {
  if (s.indexOf(a) < 0) return s;
  edits.push(why);
  return s.split(a).join(b);
}
function fix(id, body) {
  // dead mailboxes -> the one address Aman gave
  for (const m of ['hello@bridges.directory', 'safety@bridges.directory', 'grievances@bridges.directory']) {
    body = swap(body, 'mailto:' + m, 'mailto:' + CONTACT, 'mailbox ' + m + ' replaced with ' + CONTACT);
    body = swap(body, '>' + m + '<', '>' + CONTACT + '<', 'mailbox text ' + m + ' replaced');
  }
  // certificate deletion: Aman chose 15 days after approval, 30 after rejection
  body = swap(body, 'and the file is deleted once they decide.', 'and the file is deleted 15 days after approval, or 30 days after rejection.', 'About: deletion wording now 15/30 days');
  body = swap(body, 'Certificates are deleted as soon as a decision is made.', 'Certificates are deleted 15 days after approval, or 30 days after rejection.', 'Privacy: deletion wording now 15/30 days');
  body = swap(body, 'To report a listing, use <b>Report</b> on that person’s card, or write to', 'To report a listing or a safety concern, write to', 'About: removed the Report-button sentence (no app yet)');
  body = swap(body, 'Use <b>Report</b> on any card, or write to', 'Write to', 'Guidelines: removed the Report-button sentence (no app yet)');
  // bracketed details
  if (FILL.legalName) body = swap(body, '[legal name of the team or entity, to be confirmed]', FILL.legalName, 'filled legal name');
  if (FILL.grievanceName) body = swap(body, '[Name]', FILL.grievanceName, 'filled grievance officer');
  if (FILL.jurisdictionCity) body = swap(body, '[city, to be confirmed]', FILL.jurisdictionCity, 'filled jurisdiction city');
  return body;
}

const EXTRA = {
  refund: {
    tab: 'Refunds', eyebrow: 'Legal', t: 'Refund and cancellation policy',
    lede: 'Contributions are voluntary and one-time. Here is what that means if something goes wrong.',
    body: `
<h3>What a contribution is</h3>
<p>A contribution is a voluntary, one-time payment towards the running costs of Bridges.directory. It doesn’t buy a product, a service or a subscription, so there is nothing to cancel and nothing is charged again.</p>
<h3>When we refund</h3>
<p>Contributions are refundable only for duplicate or mistaken payments reported within 7 days. Write to <a href="mailto:${CONTACT}">${CONTACT}</a> with the date, the amount and the payment reference.</p>
<h3>How refunds are paid</h3>
<p>Approved refunds go back to the original payment method. Your bank or card provider may take a few working days to show it.</p>
<h3>Tax</h3>
<p>Contributions are not tax-deductible unless we say so in writing.</p>`
  }
};

const ORDER = ['about', 'privacy', 'terms', 'refund', 'cookies', 'guidelines'];
const pages = {};
for (const id of ORDER) {
  const d = DOCS[id] || EXTRA[id];
  pages[id] = Object.assign({}, d, { body: fix(id, d.body) });
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const head = (title, desc) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Roboto:wght@500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="styles.css">
<style>.links{display:flex;flex-wrap:wrap}.nav-in{flex-wrap:wrap}.menu-btn{display:none!important}.ft-col a{display:block}</style>
</head>`;
const nav = cur => `<header class="nav"><div class="nav-in">
<a class="brand" href="index.html" aria-label="Bridges.directory home"><span>Bridges<span class="tld">.directory</span></span></a>
<nav class="links" aria-label="Primary">
${[['index.html', 'Home', 'home'], ['about.html', 'About', 'about'], ['contribute.html', 'Contribute', 'contribute'], ['contact.html', 'Contact', 'contact']]
  .map(([h, l, k]) => `<a class="btn ghost sm" href="${h}"${k === cur ? ' aria-current="page"' : ''}>${l}</a>`).join('\n')}
</nav></div></header>`;
const foot = `<footer class="ft"><div class="ft-in">
<div class="ft-about"><a class="brand" href="index.html"><span>Bridges<span class="tld">.directory</span></span></a>
<p>A free, verified directory of students and alumni from India's design schools: all 19 NIFT campuses, the NIDs and the IITs that teach design. Built by students, kept running by contributions.</p></div>
<nav class="ft-col" aria-label="Bridges"><b>Bridges</b><a href="about.html">About</a><a href="about.html#verify">How verification works</a><a href="contribute.html">Contribute</a></nav>
<nav class="ft-col" aria-label="Get in touch"><b>Get in touch</b><a href="contact.html">Contact us</a><a href="mailto:${CONTACT}">${CONTACT}</a></nav>
<nav class="ft-col" aria-label="Legal"><b>Legal</b><a href="privacy.html">Privacy policy</a><a href="terms.html">Terms of use</a><a href="refund.html">Refund policy</a><a href="cookies.html">Cookie policy</a><a href="guidelines.html">Community guidelines</a></nav>
</div><div class="ft-b"><span>&copy; 2026 Bridges.directory</span></div></footer>`;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'styles.css'), css);
for (const f of ['campus-1.webp', 'campus-2.webp']) fs.copyFileSync(path.join(REPO, f), path.join(OUT, f));

/* ---- home ---- */
const home = `${head('Bridges.directory: talk to someone who\'s already there', 'A free, verified directory of students and alumni from India\'s design schools.')}
<body data-view="home">
${nav('home')}
<main class="home" id="v-home" data-view="home">
  <div class="stage" id="stage">
    <img class="slide" src="campus-1.webp" alt="Dithered illustration of a long, low campus building behind a wide lawn">
    <img class="slide" src="campus-2.webp" alt="Dithered aerial view of a hillside campus with a circular plaza">
    <canvas id="grain" aria-hidden="true"></canvas>
  </div>
  <div class="home-copy" id="homeCopy">
    <h1 class="rise" style="--i:0">Talk to someone<br>who's already there.</h1>
    <div class="home-side">
      <p class="rise" style="--i:1">Verified alumni and current students from India's design schools: all 19 NIFT campuses, the NIDs and the IITs that teach design. Find someone from your branch and ask them about entrances, portfolios, campus life or work.</p>
      <div class="cta rise" style="--i:2"><span class="btn primary" aria-disabled="true">Launching soon</span><a class="btn secondary" href="about.html">How it works</a></div>
    </div>
  </div>
</main>
${foot}
<script>
(function(){
  var slides = [].slice.call(document.querySelectorAll('.slide')), i = 0;
  document.getElementById('stage').classList.add('landed');
  document.getElementById('grain').hidden = true;
  document.getElementById('homeCopy').classList.add('ready');
  slides[0].classList.add('on');
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) setInterval(function(){ slides[i].classList.remove('on'); i = (i + 1) % slides.length; slides[i].classList.add('on'); }, 7000);
})();
</script>
</body></html>`;
fs.writeFileSync(path.join(OUT, 'index.html'), home);

/* ---- doc pages ---- */
const tabs = id => `<nav class="doc-tabs" aria-label="About and legal">${ORDER.map(k => `<a href="${k}.html"${k === id ? ' aria-current="page"' : ''}>${pages[k].tab}</a>`).join('')}</nav>`;
for (const id of ORDER) {
  const D = pages[id];
  const html = `${head(D.t + ' · Bridges.directory', D.lede)}
<body data-view="doc">
${nav(id === 'about' ? 'about' : '')}
<main class="page" id="v-doc" data-view="doc"><article class="lgl">${tabs(id)}<div class="head"><span class="eyebrow">${D.eyebrow}</span><h1 class="h2">${D.t}</h1><p class="lede">${D.lede}</p>${id === 'about' ? '' : `<p class="help">Last updated ${UPDATED}</p>`}</div><div class="doc-b">${D.body}</div></article></main>
${foot}
</body></html>`;
  fs.writeFileSync(path.join(OUT, id + '.html'), html);
}

/* ---- contribute ---- */
fs.writeFileSync(path.join(OUT, 'contribute.html'), `${head('Contribute · Bridges.directory', 'Help keep Bridges.directory free.')}
<body data-view="doc">
${nav('contribute')}
<main class="page" data-view="doc"><article class="lgl"><div class="head"><span class="eyebrow">Contribute</span><h1 class="h2">Help keep it free</h1>
<p class="lede">Keeping this platform free and accessible to everyone costs ₹10,000 each year. If it has been useful to you, please consider contributing. Every contribution, large or small, helps us keep it running.</p></div>
<div class="doc-b">
<h3>How it works</h3>
<ul>
<li>Any amount is welcome. ₹10,000 is the yearly target, not a limit.</li>
<li>We keep collecting all year. Once a year's ₹10,000 is met, new contributions count towards the next year.</li>
<li>Contributions are voluntary and pay for running costs. They don't buy anything.</li>
<li>Online payments will open when the platform launches.</li>
</ul>
<h3>Questions</h3>
<p>Read the <a href="refund.html">refund policy</a>, or write to <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
</div></article></main>
${foot}
</body></html>`);

/* ---- contact ---- */
fs.writeFileSync(path.join(OUT, 'contact.html'), `${head('Contact · Bridges.directory', 'Get in touch with Bridges.directory.')}
<body data-view="doc">
${nav('contact')}
<main class="page" data-view="doc"><article class="lgl"><div class="head"><span class="eyebrow">Contact</span><h1 class="h2">Get in touch</h1>
<p class="lede">Questions, feedback or a safety concern? Write to us and we'll read it.</p></div>
<div class="doc-b"><h3>Email</h3><p><a href="mailto:${CONTACT}">${CONTACT}</a></p>
<h3>Before you write</h3><p>For payments, see the <a href="refund.html">refund policy</a>. For how your data is used, see the <a href="privacy.html">privacy policy</a>.</p></div></article></main>
${foot}
</body></html>`);

fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

/* ---- report ---- */
const left = [];
for (const f of fs.readdirSync(OUT).filter(x => x.endsWith('.html'))) {
  const t = fs.readFileSync(path.join(OUT, f), 'utf8');
  (t.match(/\[[^\]<]{3,80}\]/g) || []).forEach(m => left.push(f + ': ' + m));
}
console.log('pages:', fs.readdirSync(OUT).join(', '));
console.log('edits made to the original text:', [...new Set(edits)]);
console.log('placeholders still showing:', left.length ? left : 'none');
