// netlify/functions/test-estimate-email.js
// Test-only helper: renders a simple form and sends a sample estimate through
// the real send-estimate handler so payment buttons receive genuine signed tokens.

const { handler: sendEstimateHandler } = require('./send-estimate.js');

function page(body) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Worktops.net test estimate</title></head><body style="font-family:Arial,sans-serif;background:#f4f1ec;color:#222;margin:0"><div style="max-width:620px;margin:60px auto;background:#fff;border:1px solid #e8e2d4;padding:32px"><h1 style="font-family:Georgia,serif;color:#1f3a5f;font-weight:400">Send a test estimate</h1>${body}</div></body></html>`
  };
}

exports.handler = async function(event) {
  if (event.httpMethod === 'GET') {
    return page(`
      <p>This sends a sample quote through the real Worktops.net email function. Use your own email address.</p>
      <form method="post">
        <label style="display:block;margin:0 0 8px"><strong>Email address</strong></label>
        <input name="email" type="email" required style="width:100%;box-sizing:border-box;padding:12px;border:1px solid #bbb;margin-bottom:16px">
        <button type="submit" style="background:#1f3a5f;color:#fff;border:0;padding:12px 18px;cursor:pointer">Send test quote</button>
      </form>
      <p style="font-size:13px;color:#666;margin-top:20px">Test quote total: £1,000.00. The online deposit button should create a £100.00 checkout (10% initial payment toward the 50% deposit).</p>
    `);
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const params = new URLSearchParams(event.body || '');
  const email = String(params.get('email') || '').trim();
  if (!email || !email.includes('@')) return page('<p>Please enter a valid email address.</p><p><a href="">Try again</a></p>');

  const payload = {
    customer: {
      first_name: 'Test',
      last_name: 'Customer',
      email,
      phone: '07000000000',
      postcode: 'LA9 4AA'
    },
    product: {
      title: 'Diore Quartz Test Colour',
      type: 'Quartz',
      thickness: '20mm',
      price_per_m2: 500,
      image_url: 'https://www.worktops.net/cdn/shop/files/placeholder.jpg',
      product_url: 'https://www.worktops.net/'
    },
    measurements: {
      total_area_m2: 2,
      pieces: [
        { label: 'Main Run', dims: { A: 2000, B: 600 }, area_m2: 1.2 },
        { label: 'Island', dims: { A: 1333, B: 600 }, area_m2: 0.8 }
      ]
    },
    pricing: {
      total_inc_vat: 1000,
      total_ex_vat: 833.33,
      vat: 166.67,
      compare_at_ppm: 0,
      price_per_m2: 500,
      deposit_amount: 100,
      balance_amount: 900
    },
    meta: {
      quote_ref: 'WTQ-TEST-' + Date.now().toString().slice(-6),
      marketing_consent: false,
      polished_edges_m: 3,
      cutouts_polished: 1,
      cutouts_unpolished: 0,
      drainer_sets: 0,
      upstands: [],
      splashbacks: [],
      waterfalls: [],
      quooker: null
    }
  };

  const result = await sendEstimateHandler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });

  let parsed = {};
  try { parsed = JSON.parse(result.body || '{}'); } catch (_) {}

  if (result.statusCode >= 200 && result.statusCode < 300) {
    return page(`<p><strong>Test quote sent to ${email}.</strong></p><p>Open the email and test both payment buttons.</p><p><a href="">Send another</a></p><pre style="white-space:pre-wrap;background:#f6f6f6;padding:12px">${JSON.stringify(parsed, null, 2)}</pre>`);
  }

  return page(`<p><strong>The test email failed.</strong></p><pre style="white-space:pre-wrap;background:#f6f6f6;padding:12px">${String(result.body || '')}</pre><p><a href="">Try again</a></p>`);
};
