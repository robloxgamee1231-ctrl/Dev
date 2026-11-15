// Optional Cloudflare Worker proxy for DevTrace on GitHub Pages.
// Deploy on Cloudflare Workers (free tier) and paste the Worker URL into
// DevTrace -> Options -> Custom Proxy URL for full HTTP header + JS bundle scans.

const BLOCKED_HOSTS = /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[::1\])/i;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '*';
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');
    if (!target) {
      return new Response(JSON.stringify({ ok: true, service: 'devtrace-worker' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
      });
    }

    let parsed;
    try {
      parsed = new URL(target);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Bad protocol');
      if (BLOCKED_HOSTS.test(parsed.hostname)) throw new Error('Blocked host');
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid or blocked target URL.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
      });
    }

    try {
      const upstream = await fetch(parsed.toString(), {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; DevTraceWorker/1.0)',
          Accept: 'text/html,application/javascript,text/css,application/json,text/plain,*/*'
        }
      });

      const body = (await upstream.text()).slice(0, 1_500_000);
      const headers = {};
      upstream.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });

      return new Response(
        JSON.stringify({
          status: upstream.status,
          finalUrl: upstream.url || parsed.toString(),
          headers,
          body
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) }
        }
      );
    } catch (err) {
      return new Response(JSON.stringify({ error: err?.message || 'Upstream fetch failed.' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
      });
    }
  }
};
