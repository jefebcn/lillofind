// PayPal Checkout (Orders v2), solo REST: niente SDK.
// Secret del Worker: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (app REST del
// conto PayPal Business). PAYPAL_ENV = 'sandbox' per le prove, altrimenti live.
// Senza le due chiavi il pagamento automatico è spento e il sito usa ancora
// il vecchio link PayPal.me con conferma manuale dall'admin.

export const paypalEnabled = (env) => !!(env && env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
const base = (env) => (env.PAYPAL_ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com');

async function accessToken(env) {
  const r = await fetch(base(env) + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(env.PAYPAL_CLIENT_ID + ':' + env.PAYPAL_CLIENT_SECRET), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('PayPal auth ' + r.status + ' ' + (j.error_description || j.error || ''));
  return j.access_token;
}

async function call(env, method, path, body, extraHeaders = {}) {
  const tok = await accessToken(env);
  const r = await fetch(base(env) + path, {
    method,
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: j };
}

// Crea l'ordine PayPal per `total` euro; restituisce { id, approveUrl }.
export async function ppCreateOrder(env, { total, uid, ref, returnUrl, cancelUrl }) {
  const res = await call(env, 'POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: String(ref || 'lillofind').slice(0, 256),
      custom_id: String(uid).slice(0, 127),
      description: 'Ordine LilloFind',
      amount: { currency_code: 'EUR', value: Number(total).toFixed(2) },
    }],
    payment_source: { paypal: { experience_context: {
      brand_name: 'LilloFind', locale: 'it-IT', landing_page: 'LOGIN',
      shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW',
      return_url: returnUrl, cancel_url: cancelUrl,
    } } },
  });
  if (!res.ok || !res.data.id) throw new Error('PayPal create ' + res.status + ' ' + JSON.stringify(res.data).slice(0, 300));
  const link = (res.data.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  return { id: res.data.id, approveUrl: link ? link.href : '' };
}

export async function ppGetOrder(env, id) {
  const res = await call(env, 'GET', '/v2/checkout/orders/' + encodeURIComponent(id));
  if (!res.ok) throw new Error('PayPal get ' + res.status);
  return res.data;
}

// Incassa un ordine approvato. PayPal-Request-Id = id ordine: ripetere la
// chiamata non incassa due volte.
export async function ppCapture(env, id) {
  const res = await call(env, 'POST', '/v2/checkout/orders/' + encodeURIComponent(id) + '/capture', {}, { 'PayPal-Request-Id': 'cap-' + id });
  if (!res.ok && res.data && Array.isArray(res.data.details) && res.data.details.some((d) => d.issue === 'ORDER_ALREADY_CAPTURED')) {
    return ppGetOrder(env, id);
  }
  if (!res.ok) throw new Error('PayPal capture ' + res.status + ' ' + JSON.stringify(res.data).slice(0, 300));
  return res.data;
}

// Dati utili di un ordine PayPal (prima o dopo l'incasso).
export function ppSummary(o) {
  const pu = (o && o.purchase_units && o.purchase_units[0]) || {};
  const cap = (pu.payments && pu.payments.captures && pu.payments.captures[0]) || null;
  const amt = cap ? cap.amount : pu.amount;
  return {
    status: o && o.status, uid: pu.custom_id || '',
    value: amt ? Number(amt.value) : NaN, currency: amt ? amt.currency_code : '',
    captureId: cap ? cap.id : '', captureStatus: cap ? cap.status : '',
    fee: cap && cap.seller_receivable_breakdown && cap.seller_receivable_breakdown.paypal_fee ? Number(cap.seller_receivable_breakdown.paypal_fee.value) : null,
    payer: (o && o.payer && o.payer.email_address) || '',
  };
}
