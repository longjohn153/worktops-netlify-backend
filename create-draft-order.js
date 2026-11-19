exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  try {
    const data = JSON.parse(event.body);
    const required = ['firstName','lastName','address1','city','postcode','email','depositAmount','totalAmount','productTitle','quoteRef'];
    for (const field of required) {
      if (!data[field]) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing: ' + field }) };
    }

    const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
    const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;

    const note = [
      'Quote Reference: ' + data.quoteRef,
      'Product: ' + data.productTitle,
      'Thickness: ' + (data.thickness || ''),
      'Total Area: ' + (data.area || '') + ' m2',
      'Total Quotation (inc VAT): GBP' + data.totalAmount.toFixed(2),
      'Deposit (10%): GBP' + data.depositAmount.toFixed(2),
      'Balance Due: GBP' + data.balanceAmount.toFixed(2),
      'Polished Edges: ' + (data.edges || 'None'),
      'Cut-outs: ' + (data.cutouts || 'None'),
      'Drainer Grooves: ' + (data.drains || 'None'),
      'Upstands: ' + (data.upstands || 'None'),
      'Kitchen Ready Week: ' + (data.kitchenDate || 'Not specified'),
      'Payment Plan: ' + (data.paymentPlan || 'Not specified'),
      'Phone: ' + (data.phone || 'Not provided')
    ].join('\\n');

    const mutation = `
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            invoiceUrl
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      input: {
        lineItems: [{
          title: 'Worktop Deposit - ' + data.productTitle,
          originalUnitPrice: data.depositAmount.toFixed(2),
          quantity: 1,
          requiresShipping: false,
          taxable: false
        }],
        billingAddress: {
          firstName: data.firstName,
          lastName: data.lastName,
          address1: data.address1,
          address2: data.address2 || '',
          city: data.city,
          zip: data.postcode,
          countryCode: 'GB'
        },
        shippingAddress: {
          firstName: data.firstName,
          lastName: data.lastName,
          address1: data.address1,
          address2: data.address2 || '',
          city: data.city,
          zip: data.postcode,
          countryCode: 'GB'
        },
        email: data.email,
        note: note,
        tags: ['worktop-deposit']
      }
    };

    const response = await fetch(
      'https://' + SHOPIFY_STORE + '/admin/api/2026-04/graphql.json',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_TOKEN
        },
        body: JSON.stringify({ query: mutation, variables })
      }
    );

    const result = await response.json();

    if (result.errors) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'GraphQL error', details: result.errors }) };
    }

    const userErrors = result.data?.draftOrderCreate?.userErrors;
    if (userErrors && userErrors.length > 0) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Shopify error', details: userErrors }) };
    }

    const draftOrder = result.data?.draftOrderCreate?.draftOrder;

    // Send invoice email via separate mutation
    const invoiceMutation = `
      mutation draftOrderInvoiceSend($id: ID!) {
        draftOrderInvoiceSend(id: $id) {
          draftOrder { id }
          userErrors { field message }
        }
      }
    `;

    await fetch(
      'https://' + SHOPIFY_STORE + '/admin/api/2026-04/graphql.json',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_TOKEN
        },
        body: JSON.stringify({ query: invoiceMutation, variables: { id: draftOrder.id } })
      }
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        invoiceUrl: draftOrder.invoiceUrl,
        orderRef: draftOrder.id
      })
    };

  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
