exports.handler = async function () {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const out = { resend: null, klaviyo: null };

  // RESEND CHECK
  try {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      out.resend = { ok: false, error: 'RESEND_API_KEY is missing in Netlify' };
    } else {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Worktops.net <quotes@worktops.net>',
          to: ['sales@worktops.net'],
          subject: 'Worktops.net backend diagnostic',
          html: '<p>This is a backend diagnostic email from the new Netlify test project.</p>'
        })
      });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      out.resend = { ok: r.ok, status: r.status, response: body };
    }
  } catch (e) {
    out.resend = { ok: false, error: e.message };
  }

  // KLAVIYO CHECK
  try {
    const key = process.env.KLAVIYO_API_KEY;
    if (!key) {
      out.klaviyo = { ok: false, error: 'KLAVIYO_API_KEY is missing in Netlify' };
    } else {
      const r = await fetch('https://a.klaviyo.com/api/profiles/', {
        method: 'POST',
        headers: {
          Authorization: `Klaviyo-API-Key ${key}`,
          accept: 'application/json',
          'content-type': 'application/json',
          revision: '2024-10-15'
        },
        body: JSON.stringify({
          data: {
            type: 'profile',
            attributes: {
              email: `diagnostic-${Date.now()}@example.com`,
              first_name: 'Backend',
              last_name: 'Diagnostic'
            }
          }
        })
      });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      out.klaviyo = { ok: r.ok, status: r.status, response: body };
    }
  } catch (e) {
    out.klaviyo = { ok: false, error: e.message };
  }

  return { statusCode: 200, headers, body: JSON.stringify(out, null, 2) };
};
