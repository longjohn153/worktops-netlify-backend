// netlify/functions/quote-payment.js
// Creates a Shopify Draft Order checkout only when the customer clicks a
// signed payment button in the Worktops.net estimate email.

const crypto = require('crypto');

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';

function html(status, title, message) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="margin:0;background:#f4f1ec;font-family:Arial,sans-serif;color:#222"><div style="max-width:620px;margin:60px auto;background:#fff;padding:36px;border:1px solid #e8e2d4"><h1 style="margin:0 0 14px;color:#1f3a5f;font-family:Georgia,serif;font-weight:400">${title}</h1><p style="line-height:1.6">${message}</p><p><a href="https://www.worktops.net" style="color:#1f3a5f">Return to Worktops.net</a></p></div></body></html>`
  };
}

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function verifyToken(token, secret) {
  if (!token || !token.includes('.')) throw new Error('Invalid payment link');
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Invalid payment link');
  const encoded = parts[0];
  const supplied = parts[1];
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Payment link signature failed');
  const payload = JSON.parse(b64urlDecode(encoded).toString('utf8'));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error('This payment link has expired');
  if (!payload.quoteRef || !payload.customer || !payload.product) throw new Error('Payment link is incomplete');
  if (!['full', 'half'].includes(payload.mode)) throw new Error('Unknown payment option');
  const amount = Number(payload.amount);
  const total = Number(payload.total);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(total) || total <= 0 || amount > total) throw new Error('Invalid payment amount');
  return payload;
}

function cleanShopDomain(v) {
  return String(v || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'GET') return html(405, 'Method not allowed', 'Please use the payment button in your quote email.');

  const secret = process.env.QUOTE_PAYMENT_SECRET || '';
  const shop = cleanShopDomain(process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || process.env.SHOPIFY_STORE || '');
  const accessToken = process.env.SHOPIFY_TOKEN || process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || '';

  if (!secret || !shop || !accessToken) {
    console.error('Missing QUOTE_PAYMENT_SECRET / Shopify environment variables');
    return html(503, 'Payment setup is not complete', 'Please contact Worktops.net on 0330 088 3391 or sales@worktops.net and quote your reference number.');
  }

  let payload;
  try {
    payload = verifyToken(event.queryStringParameters && event.queryStringParameters.token, secret);
  } catch (err) {
    console.error('Payment token rejected:', err.message);
    return html(400, 'Payment link unavailable', err.message + '. Please contact us if you would still like to proceed.');
  }

  const amount = Math.round(Number(payload.amount) * 100) / 100;
  const total = Math.round(Number(payload.total) * 100) / 100;
  const balance = Math.round(Number(payload.balance || 0) * 100) / 100;
  const modeLabel = payload.mode === 'full' ? 'Full payment' : '50% deposit';
  const customerName = [payload.customer.firstName, payload.customer.lastName].filter(Boolean).join(' ');

  const mutation = `mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id invoiceUrl name }
      userErrors { field message }
    }
  }`;

  const variables = {
    input: {
      email: payload.customer.email || undefined,
      note: `Worktops.net instant quote ${payload.quoteRef} | ${modeLabel} | Quote total £${total.toFixed(2)} | Remaining £${balance.toFixed(2)}`,
      customAttributes: [
        { key: 'Quote reference', value: String(payload.quoteRef) },
        { key: 'Payment option', value: modeLabel },
        { key: 'Quote total', value: `£${total.toFixed(2)}` },
        { key: 'Remaining balance', value: `£${balance.toFixed(2)}` },
        { key: 'Customer', value: customerName || 'Customer' },
        { key: 'Phone', value: String(payload.customer.phone || '') },
        { key: 'Postcode', value: String(payload.customer.postcode || '') }
      ],
      lineItems: [{
        title: `${modeLabel} - ${payload.product.title || 'Worktop order'} - ${payload.quoteRef}`,
        quantity: 1,
        originalUnitPriceWithCurrency: { amount: amount.toFixed(2), currencyCode: 'GBP' },
        taxable: false,
        requiresShipping: false,
        customAttributes: [
          { key: 'Quote reference', value: String(payload.quoteRef) },
          { key: 'Worktop', value: String(payload.product.title || '') },
          { key: 'Thickness', value: String(payload.product.thickness || '') },
          { key: 'Quoted area', value: `${Number(payload.product.area || 0).toFixed(3)} m²` }
        ]
      }]
    }
  };

  let response;
  try {
    response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken
      },
      body: JSON.stringify({ query: mutation, variables })
    });
  } catch (err) {
    console.error('Shopify request failed:', err);
    return html(502, 'Unable to start checkout', 'We could not connect to Shopify. Please try again or contact us.');
  }

  let result;
  try { result = await response.json(); }
  catch (_) { return html(502, 'Unable to start checkout', 'Shopify returned an unexpected response. Please contact us.'); }

  if (!response.ok || result.errors) {
    console.error('Shopify GraphQL error:', JSON.stringify(result));
    return html(502, 'Unable to start checkout', 'Shopify could not create the checkout. Please contact us and quote ' + payload.quoteRef + '.');
  }

  const create = result.data && result.data.draftOrderCreate;
  const userErrors = create && create.userErrors || [];
  if (!create || userErrors.length || !create.draftOrder || !create.draftOrder.invoiceUrl) {
    console.error('Draft order creation failed:', JSON.stringify(userErrors));
    return html(502, 'Unable to start checkout', 'We could not create your checkout. Please contact us and quote ' + payload.quoteRef + '.');
  }

  console.log('Payment checkout created', {
    quoteRef: payload.quoteRef,
    mode: payload.mode,
    draftOrderId: create.draftOrder.id,
    draftOrderName: create.draftOrder.name
  });

  return {
    statusCode: 302,
    headers: {
      Location: create.draftOrder.invoiceUrl,
      'Cache-Control': 'no-store'
    },
    body: ''
  };
};
