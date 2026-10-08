
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const r = await fetch('https://eleduck.com/categories/5', { headers: { 'user-agent': UA } });
const h = await r.text();
const m = h.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
if (!m) { console.log('no __NEXT_DATA__'); process.exit(0); }
const j = JSON.parse(m[1]);
const pp = j.props && j.props.pageProps ? j.props.pageProps : {};
console.log('pageProps keys:', Object.keys(pp).join(', '));
for (const k of Object.keys(pp)) {
  const v = pp[k];
  if (Array.isArray(v)) console.log('  ' + k + ' = array[' + v.length + ']', v[0] && typeof v[0] === 'object' ? ('first keys: ' + Object.keys(v[0]).join(',')) : '');
  else if (v && typeof v === 'object') console.log('  ' + k + ' = object{' + Object.keys(v).slice(0, 12).join(',') + '}');
  else console.log('  ' + k + ' =', typeof v);
}
// try to find any array of post-like objects anywhere in the tree
function walk(o, path, depth) {
  if (depth > 4 || !o) return;
  if (Array.isArray(o)) {
    if (o.length && o[0] && typeof o[0] === 'object' && (o[0].title || o[0].content)) {
      console.log('FOUND posts at', path, 'len=' + o.length, 'keys=' + Object.keys(o[0]).slice(0, 14).join(','));
      console.log('SAMPLE:', JSON.stringify({ id: o[0].id, title: o[0].title, published_at: o[0].published_at, url: o[0].url, comments: o[0].comments_count }).slice(0, 300));
    }
    o.slice(0, 2).forEach((x, i) => walk(x, path + '[' + i + ']', depth + 1));
  } else if (typeof o === 'object') {
    for (const k of Object.keys(o).slice(0, 30)) walk(o[k], path + '.' + k, depth + 1);
  }
}
walk(j, 'root', 0);
