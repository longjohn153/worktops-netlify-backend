// netlify/functions/send-estimate.js
//
// Receives a POST from the instant-quote page when the customer clicks
// "See my instant quote" at Step 3.
//
// KLAVIYO (lead tracking only, no longer sends email):
//   Upserts a Klaviyo profile, optionally subscribes to the Email List
//   if marketing consent was ticked, then fires an "Estimate Generated"
//   event with the full quote payload. This event is what powers the
//   Activity Feed lead list and the fortnightly sales_contacted review.
//   It no longer triggers any Klaviyo flow email — the flow's email
//   action should be paused/removed in Klaviyo once this is deployed.
//
// RESEND (actual email delivery):
//   Sends two transactional emails directly via Resend's API:
//     1. The customer estimate email -> data.customer.email
//     2. The internal notification email -> sales@worktops.net
//   Both HTML bodies are built in this file (buildCustomerEmailHtml /
//   buildInternalEmailHtml), mirroring the content that used to live in
//   the Klaviyo templates customer-email-with-shapes.html and
//   internal-email-with-shapes.html.
//
// Philosophy: this function MUST NOT block the customer from seeing
// their quote. All Klaviyo and Resend calls are wrapped so any failure
// is logged and the function still returns 200. The frontend continues
// to Step 3 regardless.
//
// Env vars required:
//   KLAVIYO_API_KEY          private key, scope: profiles+events+lists+metrics
//   KLAVIYO_LIST_ID          the Email List ID (currently: Yp6ypR)
//   RESEND_API_KEY           Resend API key (sending domain: worktops.net)
//   RESEND_INTERNAL_EMAIL    team inbox for internal estimate notifications
//                            (optional — defaults to sales@worktops.net)
//
// Klaviyo API ref: https://developers.klaviyo.com/en/reference/api_overview
// Resend API ref:  https://resend.com/docs/api-reference/emails/send-email

const KLAVIYO_API_BASE = 'https://a.klaviyo.com/api';
const KLAVIYO_REVISION = '2024-10-15';
const RESEND_API_BASE = 'https://api.resend.com';
const RESEND_FROM = 'Worktops.net <quotes@worktops.net>';
const DEFAULT_INTERNAL_EMAIL = 'sales@worktops.net';

exports.handler = async function (event) {
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

  let data;
  try {
    data = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // -------------------------------------------------------------
  // Validate required fields (the estimate flow only — different
  // from the deposit flow which needs full address etc.)
  // -------------------------------------------------------------
  const required = [
    'customer',          // { first_name, last_name, email, phone, postcode }
    'product',           // { title, price_per_m2, ... }
    'measurements',      // { pieces, total_area_m2, ... }
    'pricing',           // { total_inc_vat, deposit_amount, ... }
    'meta'               // { quote_ref, marketing_consent, ... }
  ];

  for (const field of required) {
    if (!data[field]) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required field: ' + field })
      };
    }
  }

  if (!data.customer.email) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Missing customer email' })
    };
  }

  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const INTERNAL_EMAIL = process.env.RESEND_INTERNAL_EMAIL || DEFAULT_INTERNAL_EMAIL;

  // -------------------------------------------------------------
  // KLAVIYO — lead tracking (profile + event). Best-effort throughout;
  // none of this blocks the customer from seeing their quote.
  // -------------------------------------------------------------
  let profileId = null;
  let eventQueued = false;

  if (!KLAVIYO_API_KEY) {
    console.error('KLAVIYO_API_KEY not set — lead tracking skipped');
  } else {
    try {
      profileId = await upsertProfile(KLAVIYO_API_KEY, data.customer);
    } catch (err) {
      console.error('Klaviyo profile upsert failed:', err.message);
      // Continue anyway — the event call below can still create the profile implicitly
    }

    if (data.meta.marketing_consent === true && KLAVIYO_LIST_ID) {
      try {
        await subscribeToList(KLAVIYO_API_KEY, KLAVIYO_LIST_ID, data.customer);
      } catch (err) {
        console.error('Klaviyo list subscription failed:', err.message);
        // Continue — they're still a profile, just not on the marketing list
      }
    }

    try {
      await fireEvent(KLAVIYO_API_KEY, data);
      eventQueued = true;
    } catch (err) {
      console.error('Klaviyo event fire failed:', err.message);
    }
  }

  // -------------------------------------------------------------
  // RESEND — actual email delivery. Best-effort, never blocks the
  // customer response. Sent regardless of whether the Klaviyo calls
  // above succeeded, since email delivery and lead tracking are now
  // fully independent of each other.
  // -------------------------------------------------------------
  let customerEmailSent = false;
  let internalEmailSent = false;

  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set — transactional emails skipped');
  } else {
    try {
      await sendResendEmail(RESEND_API_KEY, {
        from: RESEND_FROM,
        to: data.customer.email,
        subject: customerSubject(data),
        html: buildCustomerEmailHtml(data)
      });
      customerEmailSent = true;
    } catch (err) {
      console.error('Resend customer email failed:', err.message);
    }

    try {
      await sendResendEmail(RESEND_API_KEY, {
        from: RESEND_FROM,
        to: INTERNAL_EMAIL,
        subject: internalSubject(data),
        html: buildInternalEmailHtml(data)
      });
      internalEmailSent = true;
    } catch (err) {
      console.error('Resend internal email failed:', err.message);
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      profileId: profileId,
      leadEventQueued: eventQueued,
      customerEmailSent: customerEmailSent,
      internalEmailSent: internalEmailSent
    })
  };
};

// ============================================================
// Klaviyo helpers
// ============================================================

function klaviyoHeaders(apiKey) {
  return {
    'Authorization': 'Klaviyo-API-Key ' + apiKey,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'revision': KLAVIYO_REVISION
  };
}

async function upsertProfile(apiKey, customer) {
  const body = {
    data: {
      type: 'profile',
      attributes: {
        email:      customer.email,
        first_name: customer.first_name || '',
        last_name:  customer.last_name  || '',
        phone_number: formatPhone(customer.phone),
        location: {
          zip:     customer.postcode || '',
          country: 'United Kingdom'
        }
      }
    }
  };

  const res = await fetch(KLAVIYO_API_BASE + '/profiles/', {
    method: 'POST',
    headers: klaviyoHeaders(apiKey),
    body: JSON.stringify(body)
  });

  if (res.status === 201) {
    const json = await res.json();
    return json.data.id;
  }

  // 409 = profile already exists. Klaviyo returns the existing profile's
  // ID in the error meta, which we can use to PATCH updated details.
  if (res.status === 409) {
    const json = await res.json();
    const existingId = json?.errors?.[0]?.meta?.duplicate_profile_id;
    if (existingId) {
      await patchProfile(apiKey, existingId, customer);
      return existingId;
    }
  }

  const errText = await res.text();
  throw new Error('Profile upsert failed: ' + res.status + ' ' + errText);
}

async function patchProfile(apiKey, profileId, customer) {
  const body = {
    data: {
      type: 'profile',
      id: profileId,
      attributes: {
        first_name: customer.first_name || '',
        last_name:  customer.last_name  || '',
        phone_number: formatPhone(customer.phone),
        location: {
          zip:     customer.postcode || '',
          country: 'United Kingdom'
        }
      }
    }
  };

  const res = await fetch(KLAVIYO_API_BASE + '/profiles/' + profileId + '/', {
    method: 'PATCH',
    headers: klaviyoHeaders(apiKey),
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Profile PATCH failed: ' + res.status + ' ' + errText);
  }
}

async function subscribeToList(apiKey, listId, customer) {
  const body = {
    data: {
      type: 'profile-subscription-bulk-create-job',
      attributes: {
        profiles: {
          data: [{
            type: 'profile',
            attributes: {
              email: customer.email,
              subscriptions: {
                email: {
                  marketing: {
                    consent: 'SUBSCRIBED'
                  }
                }
              }
            }
          }]
        }
      },
      relationships: {
        list: {
          data: { type: 'list', id: listId }
        }
      }
    }
  };

  const res = await fetch(KLAVIYO_API_BASE + '/profile-subscription-bulk-create-jobs/', {
    method: 'POST',
    headers: klaviyoHeaders(apiKey),
    body: JSON.stringify(body)
  });

  if (!res.ok && res.status !== 202) {
    const errText = await res.text();
    throw new Error('List subscription failed: ' + res.status + ' ' + errText);
  }
}

async function fireEvent(apiKey, data) {
  // Klaviyo /events/ endpoint: creates/updates the profile AND fires
  // the event in one atomic call. This event no longer triggers any
  // email — it exists purely as the lead record for the Activity Feed
  // and the fortnightly sales_contacted review.
  //
  // A handful of top-level properties are flattened alongside the full
  // nested payload so the Activity Feed shows something scannable
  // instead of a raw JSON dump (Klaviyo can't render nested objects
  // cleanly in that view).
  const body = {
    data: {
      type: 'event',
      attributes: {
        properties: {
          // Flattened — for readability in the Klaviyo Activity Feed
          customer_name:  ((data.customer.first_name || '') + ' ' + (data.customer.last_name || '')).trim(),
          customer_email: data.customer.email || '',
          customer_phone: data.customer.phone || '',
          quote_ref:      data.meta.quote_ref || '',
          product_title:  data.product.title || '',
          total_inc_vat:  data.pricing.total_inc_vat,
          deposit_amount: data.pricing.deposit_amount,
          // Full nested payload — kept for anything that needs the detail
          customer:     data.customer,
          product:      data.product,
          measurements: data.measurements,
          pricing:      data.pricing,
          meta:         data.meta
        },
        metric: {
          data: {
            type: 'metric',
            attributes: { name: 'Estimate Generated' }
          }
        },
        profile: {
          data: {
            type: 'profile',
            attributes: {
              email:      data.customer.email,
              first_name: data.customer.first_name || '',
              last_name:  data.customer.last_name  || '',
              phone_number: formatPhone(data.customer.phone)
            }
          }
        },
        time: new Date().toISOString(),
        unique_id: data.meta.quote_ref || ('quote-' + Date.now()),
        value: data.pricing.total_inc_vat,
        value_currency: 'GBP'
      }
    }
  };

  const res = await fetch(KLAVIYO_API_BASE + '/events/', {
    method: 'POST',
    headers: klaviyoHeaders(apiKey),
    body: JSON.stringify(body)
  });

  if (!res.ok && res.status !== 202) {
    const errText = await res.text();
    throw new Error('Event fire failed: ' + res.status + ' ' + errText);
  }
}

// ------------------------------------------------------------------
// Format a UK phone number for Klaviyo. Klaviyo expects E.164 format
// (+447700900000). Best-effort — leaves the value blank if it can't
// confidently produce a valid E.164 number.
// ------------------------------------------------------------------
function formatPhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.startsWith('07') && digits.length === 11) {
    return '+44' + digits.slice(1);
  }
  if (digits.startsWith('44') && digits.length === 12) {
    return '+' + digits;
  }
  if (String(raw).startsWith('+') && digits.length >= 10 && digits.length <= 15) {
    return '+' + digits;
  }
  return '';
}

// ============================================================
// Resend helper
// ============================================================

async function sendResendEmail(apiKey, { from, to, subject, html }) {
  const res = await fetch(RESEND_API_BASE + '/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to, subject, html })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Resend send failed: ' + res.status + ' ' + errText);
  }

  return res.json();
}

// ============================================================
// Formatting helpers (replace Klaviyo's Liquid filters)
// ============================================================

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(v) {
  const n = Number(v);
  return isNaN(n) ? '0.00' : n.toFixed(2);
}

function area3(v) {
  const n = Number(v);
  return isNaN(n) ? '0.000' : n.toFixed(3);
}

function formatDateUK(v) {
  if (!v) return 'Not specified';
  const d = new Date(v + 'T00:00:00');
  if (isNaN(d.getTime())) return esc(v);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
}

function pieceDimsStr(dims) {
  dims = dims || {};
  let out = '';
  ['A', 'B', 'C', 'D', 'E', 'F'].forEach(function (k) {
    if (dims[k]) out += ' ' + k + '=' + esc(dims[k]);
  });
  return out;
}

function customerSubject(data) {
  const first = data.customer.first_name || 'there';
  return 'Your worktop estimate is ready, ' + first + ' \u2014 quote ' + (data.meta.quote_ref || '');
}

function internalSubject(data) {
  return 'New estimate ' + (data.meta.quote_ref || '') + ' \u2014 ' +
    (data.customer.first_name || '') + ' ' + (data.customer.last_name || '') +
    ' (' + (data.product.title || '') + ')';
}

// ============================================================
// CUSTOMER EMAIL — mirrors customer-email-with-shapes.html
// ============================================================

function buildCustomerEmailHtml(data) {
  const c = data.customer;
  const p = data.product;
  const m = data.measurements;
  const pr = data.pricing;
  const meta = data.meta;

  const firstName = esc(c.first_name) || 'there';
  const productImage = esc(p.image_url) || 'https://www.worktops.net/cdn/shop/files/homepage-image.jpg?v=1751037870&width=400';
  const productType = esc(p.type) || 'Worktop';
  const productThickness = esc(p.thickness) || '&mdash;';

  const productUrlBlock = p.product_url ? `
    <p style="margin:14px 0 0 0; font-size:13px; line-height:18px;">
      <a href="${esc(p.product_url)}" style="color:#1f3a5f; text-decoration:underline;">View this colour on our website &rarr;</a>
    </p>` : '';

  const polishedEdgesRow = (m.polished_edges_m > 0) ? `
    <tr>
      <td style="padding:8px 0; border-bottom:1px solid #f0ebdf; color:#6b6b6b;" width="60%">Polished edges</td>
      <td style="padding:8px 0; border-bottom:1px solid #f0ebdf; text-align:right;"><strong>${money(m.polished_edges_m)} m</strong></td>
    </tr>` : '';

  const polishedCutoutsRow = (m.polished_cutouts > 0) ? `
    <tr>
      <td style="padding:8px 0; border-bottom:1px solid #f0ebdf; color:#6b6b6b;">Polished cut-outs</td>
      <td style="padding:8px 0; border-bottom:1px solid #f0ebdf; text-align:right;"><strong>${esc(m.polished_cutouts)}</strong></td>
    </tr>` : '';

  const unpolishedCutoutsRow = (m.unpolished_cutouts > 0) ? `
    <tr>
      <td style="padding:8px 0; border-bottom:1px solid #f0ebdf; color:#6b6b6b;">Unpolished cut-outs</td>
      <td style="padding:8px 0; border-bottom:1px solid #f0ebdf; text-align:right;"><strong>${esc(m.unpolished_cutouts)}</strong></td>
    </tr>` : '';

  const drainerRow = (m.drainer_grooves_sets > 0) ? `
    <tr>
      <td style="padding:8px 0; border-bottom:1px solid #f0ebdf; color:#6b6b6b;">Drainer groove sets</td>
      <td style="padding:8px 0; border-bottom:1px solid #f0ebdf; text-align:right;"><strong>${esc(m.drainer_grooves_sets)}</strong></td>
    </tr>` : '';

  const upstandsRow = (m.upstands_m > 0) ? `
    <tr>
      <td style="padding:8px 0; border-bottom:1px solid #f0ebdf; color:#6b6b6b;">Upstands</td>
      <td style="padding:8px 0; border-bottom:1px solid #f0ebdf; text-align:right;"><strong>${money(m.upstands_m)} m</strong></td>
    </tr>` : '';

  const splashbacksRow = (m.splashbacks_m > 0) ? `
    <tr>
      <td style="padding:8px 0; border-bottom:1px solid #f0ebdf; color:#6b6b6b;">Splashbacks</td>
      <td style="padding:8px 0; border-bottom:1px solid #f0ebdf; text-align:right;"><strong>${money(m.splashbacks_m)} m</strong></td>
    </tr>` : '';

  const waterfallRow = (m.waterfall_m > 0) ? `
    <tr>
      <td style="padding:8px 0; border-bottom:1px solid #f0ebdf; color:#6b6b6b;">Waterfall edges (mitred)</td>
      <td style="padding:8px 0; border-bottom:1px solid #f0ebdf; text-align:right;"><strong>${money(m.waterfall_m)} m</strong></td>
    </tr>` : '';

  const tapRow = (m.quooker_tap) ? `
    <tr>
      <td style="padding:8px 0; border-bottom:1px solid #f0ebdf; color:#6b6b6b;">Boiling water tap</td>
      <td style="padding:8px 0; border-bottom:1px solid #f0ebdf; text-align:right;"><strong>${esc(m.quooker_tap.product)}, ${esc(m.quooker_tap.colour)}, ${esc(m.quooker_tap.tank)}</strong></td>
    </tr>` : '';

  const cubeRow = (m.quooker_cube) ? `
    <tr>
      <td style="padding:8px 0; border-bottom:1px solid #f0ebdf; color:#6b6b6b;">Quooker CUBE</td>
      <td style="padding:8px 0; border-bottom:1px solid #f0ebdf; text-align:right;"><strong>Included</strong></td>
    </tr>` : '';

  const pieces = m.pieces || [];
  const piecesListRows = pieces.map((piece, idx) => `
    <tr>
      <td style="padding:3px 0;"><span style="display:inline-block; width:18px; color:#9a8c6e;">${idx + 1}.</span>
        <strong>${esc(piece.label)}</strong>${pieceDimsStr(piece.dims)} mm
        &mdash; ${area3(piece.area_m2)} m&sup2;
      </td>
    </tr>`).join('');

  const piecesBlock = pieces.length ? `
    <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:12px; font-family: Arial, Helvetica, sans-serif; font-size:13px; line-height:20px; color:#6b6b6b;" width="100%">
      ${piecesListRows}
    </table>` : '';

  const discountBlock = (pr.discount_inc_vat > 0) ? `
    <tr>
      <td class="totals-label" style="padding:5px 0; font-size:14px; line-height:20px; color:#c9d4e4;">Was (inc VAT)</td>
      <td class="totals-value" style="padding:5px 0; font-size:14px; line-height:20px; text-align:right; text-decoration:line-through; color:#9aaac0;">&pound;${money(pr.was_price_inc_vat)}</td>
    </tr>
    <tr>
      <td class="totals-label" style="padding:5px 0; font-size:14px; line-height:20px; color:#f5d76e;"><strong>You save</strong></td>
      <td class="totals-value" style="padding:5px 0; font-size:14px; line-height:20px; text-align:right; color:#f5d76e;"><strong>&minus;&pound;${money(pr.discount_inc_vat)}</strong></td>
    </tr>
    <tr>
      <td colspan="2" style="border-top:1px solid #3a5478; padding-top:8px; line-height:1px;">&nbsp;</td>
    </tr>` : '';

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8"/>
  <meta content="IE=edge" http-equiv="X-UA-Compatible"/>
  <meta content="width=device-width, initial-scale=1.0" name="viewport"/>
  <meta content="telephone=no,address=no,email=no,date=no,url=no" name="format-detection"/>
  <meta content="light only" name="color-scheme"/>
  <meta content="light only" name="supported-color-schemes"/>
  <title>Your worktop estimate</title>
  <!--[if mso]>
  <style type="text/css">
    table, td, div, h1, h2, h3, p, a { font-family: Georgia, 'Times New Roman', serif !important; }
    .body-font { font-family: Arial, sans-serif !important; }
  </style>
  <xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch><o:AllowPNG/></o:OfficeDocumentSettings></xml>
  <![endif]-->
  <style type="text/css">
    body, table, td, p, a, h1, h2, h3 { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
    img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; display: block; }
    body { margin: 0 !important; padding: 0 !important; width: 100% !important; background-color: #f4f1ec; }
    a { color: #1f3a5f; text-decoration: underline; }
    @media only screen and (max-width: 620px) {
      .container { width: 100% !important; }
      .px-mobile { padding-left: 20px !important; padding-right: 20px !important; }
      .stack { display: block !important; width: 100% !important; max-width: 100% !important; }
      .stack-half { display: block !important; width: 100% !important; max-width: 100% !important; padding: 0 !important; }
      .stack-half + .stack-half { padding-top: 16px !important; }
      .hero-title { font-size: 26px !important; line-height: 32px !important; }
      .product-image { width: 120px !important; height: 120px !important; }
      .totals-label, .totals-value { font-size: 15px !important; }
      .totals-final { font-size: 22px !important; }
      .center-mobile { text-align: center !important; }
      .center-mobile img { margin-left: auto !important; margin-right: auto !important; }
      .trust-cell { padding: 14px 8px !important; }
    }
  </style>
</head>
<body style="margin:0; padding:0; background-color:#f4f1ec; font-family: Arial, Helvetica, sans-serif;">
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#f4f1ec; opacity:0;">
    Your ${esc(p.title) || 'worktop'} quote with full price breakdown &mdash; quote ref ${esc(meta.quote_ref)}.
  </div>
  <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#f4f1ec;" width="100%">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table border="0" cellpadding="0" cellspacing="0" class="container" role="presentation" style="width:600px; max-width:600px; background-color:#ffffff;" width="600">
          <tr>
            <td class="px-mobile" style="background-color:#1f3a5f; padding:24px 32px;">
              <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%">
                <tr>
                  <td align="left" class="stack center-mobile" style="vertical-align:middle;" width="50%">
                    <a href="https://www.worktops.net" style="text-decoration:none; display:inline-block;">
                      <img alt="Worktops.net" src="https://www.worktops.net/cdn/shop/files/Worktops-net-shopify-Logo-white.png?v=1743165149&amp;width=480" style="display:block; width:180px; height:auto; border:0;" width="180"/>
                    </a>
                  </td>
                  <td align="right" class="stack center-mobile" style="vertical-align:middle; color:#ffffff; font-family: Arial, Helvetica, sans-serif; font-size:14px; line-height:20px;" width="50%">
                    <span style="display:block; color:#c9d4e4; font-size:11px; text-transform:uppercase; letter-spacing:1.2px; font-weight:bold;">Speak to us</span>
                    <a href="tel:+443300883391" style="color:#ffffff; text-decoration:none; font-size:18px; font-weight:bold; letter-spacing:0.3px;">0330 088 3391</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="px-mobile" style="padding:40px 32px 24px 32px;">
              <p style="margin:0 0 8px 0; font-family: Arial, Helvetica, sans-serif; font-size:12px; line-height:16px; letter-spacing:1.5px; text-transform:uppercase; color:#9a8c6e; font-weight:bold;">Your instant estimate</p>
              <h1 class="hero-title" style="margin:0 0 16px 0; font-family: Georgia, 'Times New Roman', serif; font-size:32px; line-height:38px; color:#1f3a5f; font-weight:normal;">Hello ${firstName},</h1>
              <p style="margin:0 0 12px 0; font-family: Arial, Helvetica, sans-serif; font-size:16px; line-height:24px; color:#2c2c2c;">
                Thank you for requesting an estimate from Worktops.net. Below is the full breakdown for your
                <strong>${esc(p.title)}</strong> worktop, based on the measurements you provided.
              </p>
              <p style="margin:0; font-family: Arial, Helvetica, sans-serif; font-size:14px; line-height:20px; color:#6b6b6b;">
                Quote reference: <strong style="color:#1f3a5f;">${esc(meta.quote_ref)}</strong>
              </p>
            </td>
          </tr>
          <tr>
            <td class="px-mobile" style="padding:0 32px 24px 32px;">
              <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#faf8f4; border:1px solid #e8e2d4;" width="100%">
                <tr>
                  <td style="padding:24px;">
                    <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%">
                      <tr>
                        <td class="stack-half" style="padding-right:20px;" valign="top" width="160">
                          <img alt="${esc(p.title)}" class="product-image" height="140" src="${productImage}" style="display:block; width:140px; height:140px; border:1px solid #e8e2d4; object-fit:cover;" width="140"/>
                        </td>
                        <td class="stack-half" style="font-family: Arial, Helvetica, sans-serif;" valign="top">
                          <p style="margin:0 0 4px 0; font-size:11px; line-height:14px; letter-spacing:1px; text-transform:uppercase; color:#9a8c6e; font-weight:bold;">${productType}</p>
                          <h2 style="margin:0 0 10px 0; font-family: Georgia, 'Times New Roman', serif; font-size:22px; line-height:26px; color:#1f3a5f; font-weight:normal;">${esc(p.title)}</h2>
                          <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="font-size:14px; line-height:22px; color:#2c2c2c;" width="100%">
                            <tr><td style="padding:2px 0; color:#6b6b6b;" width="110">Thickness</td><td style="padding:2px 0;"><strong>${productThickness}</strong></td></tr>
                            <tr><td style="padding:2px 0; color:#6b6b6b;">Price per m&sup2;</td><td style="padding:2px 0;"><strong>&pound;${money(p.price_per_m2)}</strong></td></tr>
                            <tr><td style="padding:2px 0; color:#6b6b6b;">Total area</td><td style="padding:2px 0;"><strong>${(Number(m.total_area_m2) || 0).toFixed(2)} m&sup2;</strong></td></tr>
                          </table>
                          ${productUrlBlock}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="px-mobile" style="padding:0 32px 24px 32px;">
              <h3 style="margin:0 0 12px 0; font-family: Georgia, 'Times New Roman', serif; font-size:18px; line-height:22px; color:#1f3a5f; font-weight:normal; border-bottom:2px solid #e8e2d4; padding-bottom:8px;">Your specification</h3>
              <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="font-family: Arial, Helvetica, sans-serif; font-size:14px; line-height:22px; color:#2c2c2c;" width="100%">
                ${polishedEdgesRow}
                ${polishedCutoutsRow}
                ${unpolishedCutoutsRow}
                ${drainerRow}
                ${upstandsRow}
                ${splashbacksRow}
                ${waterfallRow}
                ${tapRow}
                ${cubeRow}
                <tr>
                  <td style="padding:8px 0; color:#6b6b6b;">Number of pieces</td>
                  <td style="padding:8px 0; text-align:right;"><strong>${pieces.length}</strong></td>
                </tr>
              </table>
              ${piecesBlock}
            </td>
          </tr>
          <tr>
            <td class="px-mobile" style="padding:0 32px 24px 32px;">
              <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#1f3a5f;" width="100%">
                <tr>
                  <td style="padding:24px;">
                    <h3 style="margin:0 0 16px 0; font-family: Georgia, 'Times New Roman', serif; font-size:18px; line-height:22px; color:#ffffff; font-weight:normal; border-bottom:1px solid #3a5478; padding-bottom:10px;">Total costs</h3>
                    <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="font-family: Arial, Helvetica, sans-serif; color:#ffffff;" width="100%">
                      ${discountBlock}
                      <tr>
                        <td style="padding:0; font-family: Georgia, 'Times New Roman', serif; font-size:18px; line-height:28px; color:#ffffff;">Total (inc VAT)</td>
                        <td class="totals-final" style="padding:0; font-family: Georgia, 'Times New Roman', serif; font-size:28px; line-height:32px; text-align:right; color:#ffffff; font-weight:bold;">&pound;${money(pr.total_inc_vat)}</td>
                      </tr>
                      <tr><td colspan="2" style="border-top:1px solid #3a5478; padding-top:10px; line-height:1px;">&nbsp;</td></tr>
                      <tr>
                        <td class="totals-label" style="padding:4px 0; font-size:13px; line-height:18px; color:#c9d4e4;">Excluding VAT</td>
                        <td class="totals-value" style="padding:4px 0; font-size:13px; line-height:18px; text-align:right; color:#c9d4e4;">&pound;${money(pr.subtotal_ex_vat)}</td>
                      </tr>
                      <tr>
                        <td class="totals-label" style="padding:4px 0; font-size:13px; line-height:18px; color:#c9d4e4;">VAT (20%)</td>
                        <td class="totals-value" style="padding:4px 0; font-size:13px; line-height:18px; text-align:right; color:#c9d4e4;">&pound;${money(pr.vat_amount)}</td>
                      </tr>
                      <tr>
                        <td colspan="2" style="padding-top:14px; font-family: Arial, Helvetica, sans-serif; font-size:13px; line-height:18px; color:#c9d4e4;">
                          10% deposit to confirm: <strong style="color:#ffffff;">&pound;${money(pr.deposit_amount)}</strong>
                          &nbsp;&middot;&nbsp; Balance: &pound;${money(pr.balance_amount)}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="px-mobile" style="padding:0 32px 16px 32px;">
              <p style="margin:0; font-family: Arial, Helvetica, sans-serif; font-size:12px; line-height:18px; color:#6b6b6b; font-style:italic;">
                Joint positions and quantities will be determined by Worktops.net based on achieving the most efficient use of material. Sheet estimates are calculated using the dimensions provided by the customer. Where submitted sizes do not allow sufficient material for cutting, fabrication, or wastage allowances, additional sheets may be required and charged accordingly.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" class="px-mobile" style="padding:8px 32px 32px 32px;">
              <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:24px; color:#2c2c2c; text-align:center;">
                To continue with your order call us on
                <a href="tel:+443300883391" style="color:#1f3a5f; font-weight:bold; text-decoration:none;">0330 088 3391</a>
                to discuss, or email us at
                <a href="mailto:sales@worktops.net" style="color:#1f3a5f; font-weight:bold; text-decoration:none;">sales@worktops.net</a>
              </p>
            </td>
          </tr>
          <tr>
            <td class="px-mobile" style="padding:0 32px 24px 32px;">
              <h3 style="margin:0 0 16px 0; font-family: Georgia, 'Times New Roman', serif; font-size:18px; line-height:22px; color:#1f3a5f; font-weight:normal; text-align:center; border-bottom:2px solid #e8e2d4; padding-bottom:8px;">Why choose Worktops.net</h3>
              <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="font-family: Arial, Helvetica, sans-serif;" width="100%">
                <tr>
                  <td class="stack-half trust-cell" style="padding:8px 8px 8px 0;" valign="top" width="50%">
                    <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%"><tr>
                      <td style="padding-right:10px; font-size:20px; color:#c9a961; line-height:20px;" valign="top" width="32">&#10003;</td>
                      <td style="font-size:14px; line-height:20px; color:#2c2c2c;"><strong style="color:#1f3a5f;">25 years</strong><br/>of industry experience</td>
                    </tr></table>
                  </td>
                  <td class="stack-half trust-cell" style="padding:8px 0 8px 8px;" valign="top" width="50%">
                    <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%"><tr>
                      <td style="padding-right:10px; font-size:20px; color:#c9a961; line-height:20px;" valign="top" width="32">&#10003;</td>
                      <td style="font-size:14px; line-height:20px; color:#2c2c2c;"><strong style="color:#1f3a5f;">10-year warranty</strong><br/>manufacturer-backed</td>
                    </tr></table>
                  </td>
                </tr>
                <tr>
                  <td class="stack-half trust-cell" style="padding:8px 8px 8px 0;" valign="top" width="50%">
                    <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%"><tr>
                      <td style="padding-right:10px; font-size:20px; color:#c9a961; line-height:20px;" valign="top" width="32">&#10003;</td>
                      <td style="font-size:14px; line-height:20px; color:#2c2c2c;"><strong style="color:#1f3a5f;">Nationwide</strong><br/>templating &amp; installation</td>
                    </tr></table>
                  </td>
                  <td class="stack-half trust-cell" style="padding:8px 0 8px 8px;" valign="top" width="50%">
                    <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%"><tr>
                      <td style="padding-right:10px; font-size:20px; color:#c9a961; line-height:20px;" valign="top" width="32">&#10003;</td>
                      <td style="font-size:14px; line-height:20px; color:#2c2c2c;"><strong style="color:#1f3a5f;">Price match</strong><br/>guarantee on like-for-like</td>
                    </tr></table>
                  </td>
                </tr>
              </table>
              <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:20px;" width="100%">
                <tr><td align="center" style="padding:16px 0 0 0;">
                  <img alt="Constructionline, Corian Quality Network Industrial Partner, Acclaim Accreditation, Silestone Gold Approved Fabricator" src="https://cdn.shopify.com/s/files/1/0867/9967/9754/files/Accreditations.png" style="display:block; width:100%; max-width:480px; height:auto; border:0;" width="480"/>
                </td></tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="px-mobile" style="padding:0 32px 32px 32px;">
              <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#faf8f4; border-top:3px solid #c9a961;" width="100%">
                <tr>
                  <td style="padding:24px; text-align:center; font-family: Arial, Helvetica, sans-serif;">
                    <h3 style="margin:0 0 8px 0; font-family: Georgia, 'Times New Roman', serif; font-size:20px; line-height:24px; color:#1f3a5f; font-weight:normal;">Got a question?</h3>
                    <p style="margin:0 0 16px 0; font-size:14px; line-height:20px; color:#2c2c2c;">Our team is happy to talk you through anything &mdash; measurements, materials, lead times or installation.</p>
                    <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation"><tr>
                      <td style="padding:0 8px;"><a href="tel:+443300883391" style="font-family:Arial,Helvetica,sans-serif; font-size:14px; color:#1f3a5f; text-decoration:none; font-weight:bold;">&#9742;&#65038; 0330 088 3391</a></td>
                      <td style="padding:0 8px; color:#c9c0a8;">&middot;</td>
                      <td style="padding:0 8px;"><a href="mailto:sales@worktops.net" style="font-family:Arial,Helvetica,sans-serif; font-size:14px; color:#1f3a5f; text-decoration:none; font-weight:bold;">&#9993;&#65038; sales@worktops.net</a></td>
                    </tr></table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="px-mobile" style="background-color:#1f3a5f; padding:28px 32px; font-family: Arial, Helvetica, sans-serif; color:#c9d4e4; font-size:12px; line-height:18px; text-align:center;">
              <p style="margin:0 0 8px 0;"><strong style="color:#ffffff;">Worktops.net</strong> &middot; Kentmill, Beezon Fields, Kendal, Cumbria, LA9 6BD</p>
              <p style="margin:0 0 16px 0;">
                <a href="https://www.worktops.net" style="color:#c9d4e4; text-decoration:underline;">worktops.net</a>
                &nbsp;&middot;&nbsp;
                <a href="https://www.worktops.net/pages/terms-conditions" style="color:#c9d4e4; text-decoration:underline;">Terms</a>
                &nbsp;&middot;&nbsp;
                <a href="https://www.worktops.net/pages/terms-conditions" style="color:#c9d4e4; text-decoration:underline;">Privacy</a>
              </p>
              <p style="margin:0; font-size:11px; line-height:16px; color:#9aaac0;">
                This is a one-time estimate email sent because you requested a quote at worktops<span style="color:#9aaac0;">.</span>net. If you have any questions, contact us at sales@worktops<span style="color:#9aaac0;">.</span>net.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ============================================================
// INTERNAL EMAIL — mirrors internal-email-with-shapes.html
// ============================================================

function buildInternalEmailHtml(data) {
  const c = data.customer;
  const p = data.product;
  const m = data.measurements;
  const pr = data.pricing;
  const meta = data.meta;

  const compareAtBlock = (pr.compare_at_ppm > 0)
    ? `&pound;${money(pr.compare_at_ppm)} inc VAT`
    : '&mdash; (not on offer)';

  // Multi-slab-size audit trail (meta.slab_comparison) — only worth showing
  // when the product actually had more than one candidate size to weigh;
  // single-size products produce a 1-entry list with nothing to compare.
  const slabComp = meta.slab_comparison || [];
  const slabComparisonBlock = (slabComp.length > 1) ? `
              <table border="0" cellpadding="0" cellspacing="0" class="mono" role="presentation" style="margin-top:8px;font-size:13px;line-height:20px;color:#444;" width="100%">
                <tr><td style="color:#777;padding:4px 0 2px 0;">Slab size comparison:</td></tr>
                ${slabComp.map(a => `
                <tr><td style="padding:1px 0;${a.chosen ? 'color:#1a7f37;font-weight:bold;' : 'color:#999;'}">
                  ${a.chosen ? '&#10003; ' : '&#160;&#160;'}${esc(a.size)}${a.valid ? ` &mdash; ${a.slabs} slab${a.slabs === 1 ? '' : 's'}, ${a.area_used_m2} m&sup2; used` : ' &mdash; invalid (piece too large)'}
                </td></tr>`).join('')}
              </table>` : '';

  const pieces = m.pieces || [];
  const piecesRows = pieces.map((piece, idx) => `
    <tr><td style="padding:1px 0;">
      ${idx + 1}. <strong>${esc(piece.label)}</strong>${pieceDimsStr(piece.dims)} mm
      &mdash; ${area3(piece.area_m2)} m&sup2;
    </td></tr>`).join('');

  // Every upstand / splashback / waterfall edge the customer set, so the team can see exactly what was asked for.
  const edgesInternal = m.edges || [];
  const edgesRows = edgesInternal.map((e) => `
    <tr><td style="padding:1px 0;">Shape ${esc(e.shape_id)} (${esc(e.shape_type)}) &middot; edge <strong>${esc(e.edge)}</strong> &mdash; ${esc(e.finish)} ${esc(e.length_mm)} &times; ${esc(e.height_mm)} mm</td></tr>`).join('');
  const edgesBlock = edgesInternal.length ? `
              <table border="0" cellpadding="0" cellspacing="0" class="mono" role="presentation" style="margin-top:8px;font-size:13px;line-height:20px;color:#444;" width="100%">
                <tr><td style="color:#777;padding:4px 0 2px 0;">Upstands / splashbacks / waterfalls (${edgesInternal.length}):</td></tr>
                ${edgesRows}
              </table>` : '';
  const tapInternal = m.quooker_tap
    ? `${esc(m.quooker_tap.product)}, ${esc(m.quooker_tap.colour)}, ${esc(m.quooker_tap.tank)}`
    : 'None';

  const decomposed = m.pieces_decomposed || [];
  const decomposedRows = decomposed.map((rect, idx) => `
    <tr><td style="padding:1px 0;color:#888;">${idx + 1}. ${esc(rect.length_mm)} &times; ${esc(rect.width_mm)} mm</td></tr>`).join('');

  // Greedy-vs-centre split audit trail (meta.split_comparison), when this
  // quote had an oversized piece to split at all — null otherwise, in which
  // case this block just renders empty. Shows both attempts and which one
  // won, so the decomposed-rectangles list above isn't a mystery on quotes
  // where it doesn't match a plain slab-length-then-remainder split.
  const splitComp = meta.split_comparison;
  const fmtSplitPieces = (arr) => (arr || []).map(p => `${esc(p.length_mm)}&times;${esc(p.width_mm)}`).join(', ');
  const splitComparisonBlock = splitComp ? `
              <table border="0" cellpadding="0" cellspacing="0" class="mono" role="presentation" style="margin-top:8px;font-size:13px;line-height:20px;color:#444;" width="100%">
                <tr><td style="color:#777;padding:4px 0 2px 0;">Split comparison (oversized piece &mdash; greedy vs centre):</td></tr>
                <tr><td style="padding:1px 0;${splitComp.used === 'greedy' ? 'color:#1a7f37;font-weight:bold;' : 'color:#999;'}">
                  ${splitComp.used === 'greedy' ? '&#10003; ' : '&#160;&#160;'}Greedy &mdash; ${splitComp.greedy.slabs} slab${splitComp.greedy.slabs === 1 ? '' : 's'}: ${fmtSplitPieces(splitComp.greedy.pieces)} mm
                </td></tr>
                <tr><td style="padding:1px 0;${splitComp.used === 'centre' ? 'color:#1a7f37;font-weight:bold;' : 'color:#999;'}">
                  ${splitComp.used === 'centre' ? '&#10003; ' : '&#160;&#160;'}Centre &mdash; ${splitComp.centre.slabs} slab${splitComp.centre.slabs === 1 ? '' : 's'}: ${fmtSplitPieces(splitComp.centre.pieces)} mm
                </td></tr>
              </table>` : '';

  const savingRow = (pr.discount_inc_vat > 0) ? `
    <tr>
      <td style="color:#555;padding:2px 0;">&mdash; customer saving (compare-at)</td>
      <td style="padding:2px 0;text-align:right;color:#1a7f37;">&minus;&pound;${money(pr.discount_inc_vat)}</td>
    </tr>` : '';

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8"/>
  <meta content="width=device-width, initial-scale=1.0" name="viewport"/>
  <meta content="light only" name="color-scheme"/>
  <title>Internal estimate notification</title>
  <style type="text/css">
    body,table,td,p,a,h1,h2{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
    table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;}
    body{margin:0 !important;padding:0 !important;width:100% !important;background-color:#eef0f3;}
    .mono{font-family:'Courier New',Courier,monospace;}
    @media only screen and (max-width:620px){
      .container{width:100% !important;}
      .px-mobile{padding-left:16px !important;padding-right:16px !important;}
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#eef0f3;font-family:Arial,Helvetica,sans-serif;">
  <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#eef0f3;" width="100%">
    <tr>
      <td align="center" style="padding:20px 12px;">
        <table border="0" cellpadding="0" cellspacing="0" class="container" role="presentation" style="width:620px;max-width:620px;background-color:#ffffff;border:1px solid #d4d8de;" width="620">
          <tr>
            <td class="px-mobile" style="background-color:#1f3a5f;padding:18px 24px;">
              <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%"><tr>
                <td style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;">
                  <span style="display:block;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#c9a961;font-weight:bold;">Internal notification</span>
                  <span style="display:block;font-size:20px;font-weight:bold;margin-top:2px;">New estimate &middot; ${esc(meta.quote_ref)}</span>
                </td>
              </tr></table>
            </td>
          </tr>
          <tr>
            <td class="px-mobile" style="padding:16px 24px 0 24px;">
              <p style="margin:0;font-size:13px;line-height:18px;color:#444;">
                Generated ${esc(meta.submitted_at)} &middot; Marketing consent: <strong>${meta.marketing_consent ? 'YES' : 'NO'}</strong>
              </p>
            </td>
          </tr>
          <tr>
            <td class="px-mobile" style="padding:18px 24px 0 24px;">
              <h2 style="margin:0 0 8px 0;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#1f3a5f;border-bottom:2px solid #e2e5ea;padding-bottom:6px;">Customer</h2>
              <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="font-size:14px;line-height:22px;color:#222;" width="100%">
                <tr><td style="color:#777;padding:2px 0;" width="140">Name</td><td style="padding:2px 0;"><strong>${esc(c.first_name)} ${esc(c.last_name)}</strong></td></tr>
                <tr><td style="color:#777;padding:2px 0;">Email</td><td style="padding:2px 0;"><a href="mailto:${esc(c.email)}" style="color:#1f3a5f;">${esc(c.email)}</a></td></tr>
                <tr><td style="color:#777;padding:2px 0;">Phone</td><td style="padding:2px 0;"><a href="tel:${esc(c.phone)}" style="color:#1f3a5f;">${esc(c.phone) || '&mdash;'}</a></td></tr>
                <tr><td style="color:#777;padding:2px 0;">Postcode</td><td style="padding:2px 0;"><strong>${esc(c.postcode) || '&mdash;'}</strong></td></tr>
                <tr><td style="color:#777;padding:2px 0;">Kitchen ready date</td><td style="padding:2px 0;"><strong>${formatDateUK(meta.kitchen_date)}</strong></td></tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="px-mobile" style="padding:18px 24px 0 24px;">
              <h2 style="margin:0 0 8px 0;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#1f3a5f;border-bottom:2px solid #e2e5ea;padding-bottom:6px;">Product &amp; slab</h2>
              <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="font-size:14px;line-height:22px;color:#222;" width="100%">
                <tr><td style="color:#777;padding:2px 0;" width="140">Product</td><td style="padding:2px 0;"><strong>${esc(p.title)}</strong> (${esc(p.type)})</td></tr>
                <tr><td style="color:#777;padding:2px 0;">Thickness</td><td style="padding:2px 0;">${esc(p.thickness)}</td></tr>
                <tr><td style="color:#777;padding:2px 0;">Live price/m&sup2;</td><td style="padding:2px 0;">&pound;${money(p.price_per_m2)} inc VAT</td></tr>
                <tr><td style="color:#777;padding:2px 0;">Compare-at/m&sup2;</td><td style="padding:2px 0;">${compareAtBlock}</td></tr>
                <tr><td style="color:#777;padding:2px 0;">Slab</td><td style="padding:2px 0;"><strong>${esc(meta.slab_code)}</strong> (${esc(meta.slab_dimensions)})</td></tr>
                <tr><td style="color:#777;padding:2px 0;">Price/slab</td><td style="padding:2px 0;">&pound;${money(pr.price_per_slab_inc)} inc VAT</td></tr>
              </table>
              ${slabComparisonBlock}
            </td>
          </tr>
          <tr>
            <td class="px-mobile" style="padding:18px 24px 0 24px;">
              <h2 style="margin:0 0 8px 0;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#1f3a5f;border-bottom:2px solid #e2e5ea;padding-bottom:6px;">Measurements</h2>
              <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="font-size:14px;line-height:22px;color:#222;" width="100%">
                <tr><td style="color:#777;padding:2px 0;" width="180">Total area</td><td style="padding:2px 0;"><strong>${area3(m.total_area_m2)} m&sup2;</strong></td></tr>
                <tr><td style="color:#777;padding:2px 0;">Slabs needed</td><td style="padding:2px 0;"><strong>${esc(m.slabs_needed)}</strong></td></tr>
                <tr><td style="color:#777;padding:2px 0;">Polished edges</td><td style="padding:2px 0;">${money(m.polished_edges_m)} m</td></tr>
                <tr><td style="color:#777;padding:2px 0;">Polished cut-outs</td><td style="padding:2px 0;">${m.polished_cutouts || 0}</td></tr>
                <tr><td style="color:#777;padding:2px 0;">Unpolished cut-outs</td><td style="padding:2px 0;">${m.unpolished_cutouts || 0}</td></tr>
                <tr><td style="color:#777;padding:2px 0;">Drainer groove sets</td><td style="padding:2px 0;">${m.drainer_grooves_sets || 0}</td></tr>
                <tr><td style="color:#777;padding:2px 0;">Upstands</td><td style="padding:2px 0;">${money(m.upstands_m)} m</td></tr>
                <tr><td style="color:#777;padding:2px 0;">Splashbacks</td><td style="padding:2px 0;">${money(m.splashbacks_m)} m</td></tr>
                <tr><td style="color:#777;padding:2px 0;">Waterfall edges (mitred)</td><td style="padding:2px 0;">${money(m.waterfall_m)} m</td></tr>
                <tr><td style="color:#777;padding:2px 0;">Boiling water tap</td><td style="padding:2px 0;">${tapInternal}</td></tr>
                <tr><td style="color:#777;padding:2px 0;">Quooker CUBE</td><td style="padding:2px 0;">${m.quooker_cube ? 'Yes' : 'No'}</td></tr>
              </table>
              ${edgesBlock}
              <table border="0" cellpadding="0" cellspacing="0" class="mono" role="presentation" style="margin-top:8px;font-size:13px;line-height:20px;color:#444;" width="100%">
                <tr><td style="color:#777;padding:4px 0 2px 0;">Pieces (${pieces.length}):</td></tr>
                ${piecesRows}
              </table>
              <table border="0" cellpadding="0" cellspacing="0" class="mono" role="presentation" style="margin-top:8px;font-size:13px;line-height:20px;color:#444;" width="100%">
                <tr><td style="color:#777;padding:4px 0 2px 0;">Decomposed rectangles (fabrication reference):</td></tr>
                ${decomposedRows}
              </table>
              ${splitComparisonBlock}
            </td>
          </tr>
          <tr>
            <td class="px-mobile" style="padding:18px 24px 0 24px;">
              <h2 style="margin:0 0 8px 0;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#1f3a5f;border-bottom:2px solid #e2e5ea;padding-bottom:6px;">Full breakdown (ex VAT)</h2>
              <table border="0" cellpadding="0" cellspacing="0" class="mono" role="presentation" style="font-size:14px;line-height:22px;color:#222;" width="100%">
                <tr><td style="color:#555;padding:2px 0;">Material</td><td style="padding:2px 0;text-align:right;">&pound;${money(pr.material_cost_ex)}</td></tr>
                ${savingRow}
                <tr><td style="color:#555;padding:2px 0;">Polished edges</td><td style="padding:2px 0;text-align:right;">&pound;${money(pr.edges_cost_ex)}</td></tr>
                <tr><td style="color:#555;padding:2px 0;">Cut-outs</td><td style="padding:2px 0;text-align:right;">&pound;${money(pr.cutouts_cost_ex)}</td></tr>
                <tr><td style="color:#555;padding:2px 0;">Drainer grooves</td><td style="padding:2px 0;text-align:right;">&pound;${money(pr.drainer_cost_ex)}</td></tr>
                <tr><td style="color:#555;padding:2px 0;">Upstands</td><td style="padding:2px 0;text-align:right;">&pound;${money(pr.upstand_cost_ex)}</td></tr>
                <tr><td style="color:#555;padding:2px 0;">Splashbacks</td><td style="padding:2px 0;text-align:right;">&pound;${money(pr.splashback_cost_ex)}</td></tr>
                <tr><td style="color:#555;padding:2px 0;">Waterfall mitres</td><td style="padding:2px 0;text-align:right;">&pound;${money(pr.waterfall_cost_ex)}</td></tr>
                <tr><td style="color:#555;padding:2px 0;">Boiling water tap</td><td style="padding:2px 0;text-align:right;">&pound;${money(pr.tap_cost_ex)}</td></tr>
                <tr><td style="color:#555;padding:2px 0;">Quooker CUBE</td><td style="padding:2px 0;text-align:right;">&pound;${money(pr.cube_cost_ex)}</td></tr>
                <tr><td colspan="2" style="border-top:1px dashed #ccc;padding-top:4px;line-height:1px;">&nbsp;</td></tr>
                <tr><td style="color:#a15c00;padding:2px 0;">&oplus; Fabrication (${area3(pr.fabrication_area_m2)} m&sup2;) [hidden]</td><td style="padding:2px 0;text-align:right;color:#a15c00;">&pound;${money(pr.fabrication_ex)}</td></tr>
                <tr><td style="color:#a15c00;padding:2px 0;">&oplus; Surcharge [hidden]</td><td style="padding:2px 0;text-align:right;color:#a15c00;">&pound;${money(pr.hidden_surcharge_ex)}</td></tr>
                <tr><td colspan="2" style="border-top:2px solid #1f3a5f;padding-top:6px;line-height:1px;">&nbsp;</td></tr>
                <tr><td style="color:#555;padding:2px 0;">Excluding VAT</td><td style="padding:2px 0;text-align:right;">&pound;${money(pr.subtotal_ex_vat)}</td></tr>
                <tr><td style="color:#555;padding:2px 0;">VAT (20%)</td><td style="padding:2px 0;text-align:right;">&pound;${money(pr.vat_amount)}</td></tr>
                <tr><td style="padding:4px 0;font-weight:bold;font-size:16px;color:#1f3a5f;">TOTAL ex VAT</td><td style="padding:4px 0;text-align:right;font-weight:bold;font-size:16px;color:#1f3a5f;">&pound;${money(pr.subtotal_ex_vat)}</td></tr>
                <tr><td style="color:#555;padding:2px 0;">VAT (20%)</td><td style="padding:2px 0;text-align:right;">&pound;${money(pr.vat_amount)}</td></tr>
                <tr><td style="color:#555;padding:2px 0;font-weight:bold;">TOTAL inc VAT</td><td style="padding:2px 0;text-align:right;font-weight:bold;">&pound;${money(pr.total_inc_vat)}</td></tr>
                <tr><td colspan="2" style="border-top:1px dashed #ccc;padding-top:4px;line-height:1px;">&nbsp;</td></tr>
                <tr><td style="color:#555;padding:2px 0;">Deposit (10%)</td><td style="padding:2px 0;text-align:right;">&pound;${money(pr.deposit_amount)}</td></tr>
                <tr><td style="color:#555;padding:2px 0;">Balance</td><td style="padding:2px 0;text-align:right;">&pound;${money(pr.balance_amount)}</td></tr>
              </table>
              <p style="margin:8px 0 0 0;font-size:11px;line-height:16px;color:#999;">&oplus; = folded into the total, NOT shown to the customer. The customer sees quantities only plus the total/VAT/deposit.</p>
            </td>
          </tr>
          <tr>
            <td class="px-mobile" style="background-color:#f3f4f6;padding:14px 24px;font-size:11px;line-height:16px;color:#999;text-align:center;">
              Internal notification &middot; Worktops.net estimate system &middot; do not forward to customer
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
