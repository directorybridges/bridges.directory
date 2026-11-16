// Public settings for the browser. The publishable key is meant to be public:
// the database locks (RLS) decide what it can do. Never put the secret key here.
window.BRIDGES = {
  // The real backend is ON for everyone. ?backend=0 turns it off in one browser (for debugging), ?backend=1 turns it back on.
  enabled: (function () {
    try {
      var m = /[?&]backend=([01])/.exec(location.search);
      if (m) localStorage.setItem('bridges-backend', m[1]);
      return localStorage.getItem('bridges-backend') !== '0';
    } catch (e) { return true; }
  })(),
  // Address of the certificate Worker (Cloudflare R2). Empty = certificates stay in the database, as before.
  certWorkerUrl: '',
  supabaseUrl: 'https://fpvqhqjdlqwfjsgblwzq.supabase.co',
  publishableKey: 'sb_publishable_44DFmgOXzrHCUV9xDkh8Ug_zxFIj2FM'
};
