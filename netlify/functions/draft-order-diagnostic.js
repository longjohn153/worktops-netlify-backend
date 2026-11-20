const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';

async function getShopifyAccessToken() {
  const shop = String(process.env.SHOPIFY_SHOP || '').trim().replace(/\.myshopify\.com$/i, '');
  const clientId = process.env.SHOPIFY_CLIENT_ID || '';
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || '';
  if (!shop || !clientId || !clientSecret) throw new Error('Missing Shopify environment variables');

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  });

  const r = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) throw new Error('Shopify authentication failed: ' + JSON.stringify(data));
  return { shop: `${shop}.myshopify.com`, accessToken: data.access_token };
}

exports.handler = async function() {
  const out = { apiVersion: API_VERSION, auth: null, draftOrder: null };

  let shop, accessToken;
  try {
    ({ shop, accessToken } = await getShopifyAccessToken());
    out.auth = { ok: true, shop };
  } catch (e) {
    out.auth = { ok: false, error: e.message };
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out, null, 2) };
  }

  const mutation = `mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name invoiceUrl }
      userErrors { field message }
    }
  }`;

  const variables = {
    input: {
      email: 'diagnostic@example.com',
      note: 'Worktops.net diagnostic draft order - safe to delete',
      customAttributes: [
        { key: 'Diagnostic', value: 'true' }
      ],
      lineItems: [{
        title: 'Worktops.net diagnostic payment',
        quantity: 1,
        originalUnitPriceWithCurrency: { amount: '1.00', currencyCode: 'GBP' },
        taxable: false,
        requiresShipping: false
      }]
    }
  };

  try {
    const r = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken
      },
      body: JSON.stringify({ query: mutation, variables })
    });

    let data;
    try { data = await r.json(); }
    catch { data = { raw: 'Non-JSON response from Shopify' }; }

    out.draftOrder = {
      ok: !!(r.ok && data && data.data && data.data.draftOrderCreate && data.data.draftOrderCreate.draftOrder && data.data.draftOrderCreate.draftOrder.invoiceUrl && !(data.data.draftOrderCreate.userErrors || []).length),
      httpStatus: r.status,
      response: data
    };
  } catch (e) {
    out.draftOrder = { ok: false, error: e.message };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(out, null, 2)
  };
};
