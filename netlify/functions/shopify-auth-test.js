const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';

async function getShopifyAccessToken() {
  const shop = String(process.env.SHOPIFY_SHOP || '').trim().replace(/\.myshopify\.com$/i, '');
  const clientId = process.env.SHOPIFY_CLIENT_ID || '';
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || '';
  if (!shop || !clientId || !clientSecret) throw new Error('Missing SHOPIFY_SHOP / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET');

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  });

  const response = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error('Shopify authentication failed: ' + JSON.stringify(data));
  }
  return { shop: `${shop}.myshopify.com`, accessToken: data.access_token };
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }) };
  }
  try {
    const { shop, accessToken } = await getShopifyAccessToken();
    const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query: 'query { shop { name myshopifyDomain } }' })
    });
    const data = await response.json();
    if (!response.ok || data.errors) throw new Error(JSON.stringify(data));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: true, shop: data.data.shop.name, domain: data.data.shop.myshopifyDomain })
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
