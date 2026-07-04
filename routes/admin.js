const express = require('express');
const router = express.Router();
const cleanupService = require('../services/cleanupService');
const usageService = require('../services/usageService');

// Gate the AI-usage/spend views. If ADMIN_KEY is set, callers must pass a
// matching ?key=... (or X-Admin-Key header). If it's unset, the view is open
// (dev) — set ADMIN_KEY in Railway to lock it down.
function requireAdmin(req, res, next) {
  const need = process.env.ADMIN_KEY;
  if (!need) return next();
  const got = req.query.key || req.headers['x-admin-key'];
  if (got === need) return next();
  return res.status(401).json({ success: false, error: 'Unauthorized. Add ?key=YOUR_ADMIN_KEY.' });
}

/**
 * GET /api/admin/status - Get storage status and job list
 */
router.get('/status', async (req, res) => {
  try {
    const status = await cleanupService.getStatus();
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/admin/cleanup - Manually trigger cleanup
 */
router.post('/cleanup', async (req, res) => {
  try {
    const result = await cleanupService.forceCleanup();
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Manual cleanup error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/ai-usage - Per-user AI spend (doc-factory + audio-rant), JSON.
 * GET /api/admin/ai-usage/user/:id - One user's detail (recent AI jobs).
 */
router.get('/ai-usage', requireAdmin, async (req, res) => {
  try {
    const report = await usageService.getReport();
    res.json({ success: true, data: report });
  } catch (error) {
    console.error('[admin] ai-usage error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/ai-usage/user/:id', requireAdmin, async (req, res) => {
  try {
    const user = await usageService.getUser(req.params.id);
    res.json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/ai-usage/dashboard - A self-contained page Mosh can just open.
 * Shows who is using AI (doc-factory + audio-rant) and their estimated spend.
 */
router.get('/ai-usage/dashboard', requireAdmin, (req, res) => {
  res.type('html').send(DASHBOARD_HTML);
});

const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>AI Usage — devrant</title>
<style>
  :root { --bg:#0a0f1e; --card:#111a30; --line:#22304f; --ink:#e6ecf7; --muted:#8aa0c4;
          --blue:#3b82f6; --glow:0 0 0 1px #22304f, 0 8px 30px rgba(0,0,0,.35); }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; padding:28px; }
  h1 { margin:0 0 4px; font-size:22px; } .sub { color:var(--muted); margin:0 0 22px; font-size:13px; }
  .cards { display:flex; gap:14px; flex-wrap:wrap; margin-bottom:22px; }
  .stat { background:var(--card); box-shadow:var(--glow); border-radius:14px; padding:16px 20px; min-width:150px; }
  .stat .k { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .stat .v { font-size:26px; font-weight:700; margin-top:4px; }
  .stat .v.blue { color:#60a5fa; }
  table { width:100%; border-collapse:collapse; background:var(--card); box-shadow:var(--glow);
    border-radius:14px; overflow:hidden; }
  th,td { padding:11px 14px; text-align:left; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.03em; cursor:pointer; user-select:none; }
  th.num,td.num { text-align:right; } tr:last-child td { border-bottom:none; }
  tbody tr:hover { background:#16223d; } .uid { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; color:#a9bde0; }
  .money { font-weight:700; color:#4ade80; } .zero { color:var(--muted); }
  .foot { color:var(--muted); font-size:12px; margin-top:16px; }
  .err { color:#f87171; } .pill { display:inline-block; background:#0e1830; border:1px solid var(--line);
    border-radius:20px; padding:2px 10px; font-size:12px; color:var(--muted); margin-left:8px; }
</style></head>
<body>
  <h1>AI Usage &amp; Spend <span class="pill" id="updated"></span></h1>
  <p class="sub">Who is using Doc Factory AI and Audio Rant AI, and their estimated AI-credit cost. Estimates for visibility, not a bill.</p>
  <div class="cards" id="cards"></div>
  <div id="tablewrap"></div>
  <p class="foot" id="foot"></p>
<script>
  var KEY = new URLSearchParams(location.search).get('key') || '';
  var usd = function(n){ return '$' + (Number(n||0)).toFixed(n>=1?2:4); };
  var when = function(ts){ if(!ts) return '—'; var d=new Date(ts);
    return d.toLocaleDateString()+' '+d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); };
  var rows = [], sortKey = 'costUsd', sortDir = -1;
  function feat(u,f){ return (u.byFeature && u.byFeature[f]) || {runs:0,costUsd:0}; }
  function render(){
    rows.sort(function(a,b){
      var av,bv;
      if(sortKey==='doc'){av=feat(a,'doc-factory').costUsd;bv=feat(b,'doc-factory').costUsd;}
      else if(sortKey==='aud'){av=feat(a,'audio-rant').costUsd;bv=feat(b,'audio-rant').costUsd;}
      else {av=a[sortKey];bv=b[sortKey];}
      if(typeof av==='string'){return (av<bv?-1:av>bv?1:0)*sortDir;}
      return ((av||0)-(bv||0))*sortDir;
    });
    var h = '<table><thead><tr>'
      + th('User','userId') + th('Email','email')
      + th('Doc Factory','doc',true) + th('Audio Rant','aud',true)
      + th('Total runs','runs',true) + th('Est. spend','costUsd',true) + th('Last used','lastSeen',true)
      + '</tr></thead><tbody>';
    rows.forEach(function(u){
      var d=feat(u,'doc-factory'), a=feat(u,'audio-rant');
      h += '<tr>'
        + '<td class="uid">'+esc(u.userId)+'</td>'
        + '<td>'+esc(u.email||'—')+'</td>'
        + '<td class="num">'+cell(d)+'</td>'
        + '<td class="num">'+cell(a)+'</td>'
        + '<td class="num">'+(u.runs||0)+'</td>'
        + '<td class="num money">'+usd(u.costUsd)+'</td>'
        + '<td class="num">'+when(u.lastSeen)+'</td>'
        + '</tr>';
    });
    h += '</tbody></table>';
    if(!rows.length) h = '<p class="sub">No AI usage recorded yet. It will appear here after the next Doc Factory run or AI voiceover.</p>';
    document.getElementById('tablewrap').innerHTML = h;
  }
  function cell(x){ if(!x.runs) return '<span class="zero">—</span>'; return x.runs+' &middot; '+usd(x.costUsd); }
  function th(label,key,num){ return '<th class="'+(num?'num':'')+'" data-k="'+key+'">'+label+'</th>'; }
  function esc(s){ return String(s==null?'':s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }
  function sortBy(k){ if(sortKey===k){sortDir*=-1;}else{sortKey=k;sortDir=(k==='userId'||k==='email')?1:-1;} render(); }
  document.getElementById('tablewrap').addEventListener('click', function(e){
    var th = e.target.closest('th[data-k]'); if(th) sortBy(th.getAttribute('data-k'));
  });
  fetch('../ai-usage'+(KEY?('?key='+encodeURIComponent(KEY)):''))
    .then(function(r){ return r.json(); })
    .then(function(j){
      if(!j.success){ document.getElementById('tablewrap').innerHTML='<p class="err">'+esc(j.error||'Error')+'</p>'; return; }
      var d=j.data, t=d.totals||{byFeature:{}};
      var doc=(t.byFeature&&t.byFeature['doc-factory'])||{runs:0,costUsd:0};
      var aud=(t.byFeature&&t.byFeature['audio-rant'])||{runs:0,costUsd:0};
      document.getElementById('cards').innerHTML =
        card('Total AI spend', usd(t.costUsd), true)
        + card('Users', t.users||0)
        + card('Doc Factory', usd(doc.costUsd)+' · '+(doc.runs||0)+' runs')
        + card('Audio Rant', usd(aud.costUsd)+' · '+(aud.runs||0)+' runs');
      document.getElementById('updated').textContent = d.updatedAt ? ('updated '+when(d.updatedAt)) : '';
      rows = d.users || [];
      render();
      document.getElementById('foot').textContent =
        'Doc Factory = Claude passes (cost from the CLI, or estimated from tokens). Audio Rant = OpenAI/ElevenLabs text-to-voice (estimated from characters).';
    })
    .catch(function(e){ document.getElementById('tablewrap').innerHTML='<p class="err">'+esc(e.message)+'</p>'; });
  function card(k,v,blue){ return '<div class="stat"><div class="k">'+k+'</div><div class="v'+(blue?' blue':'')+'">'+v+'</div></div>'; }
</script>
</body></html>`;

module.exports = router;
