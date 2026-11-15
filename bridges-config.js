// Public settings for the browser. The publishable key is meant to be public:
// the database locks (RLS) decide what it can do. Never put the secret key here.
window.BRIDGES = {
  // The live site keeps behaving like the prototype until this is switched on.
  // To try the real backend: open the site with ?backend=1 (sticks in this browser), ?backend=0 turns it off.
  enabled: (function () {
    try {
      var m = /[?&]backend=([01])/.exec(location.search);
      if (m) localStorage.setItem('bridges-backend', m[1]);
      return localStorage.getItem('bridges-backend') === '1' || false;
    } catch (e) { return false; }
  })(),
  supabaseUrl: 'https://fpvqhqjdlqwfjsgblwzq.supabase.co',
  publishableKey: 'sb_publishable_44DFmgOXzrHCUV9xDkh8Ug_zxFIj2FM'
};
