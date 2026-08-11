import express from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'
import { AccountStore } from './store.js'

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 8080)
const APP_UID = process.env.MS_APP_UID || ''          // "salma-widget.<vendor>"
const APP_ID = process.env.MS_APP_ID || ''            // uuid from the developer cabinet
const SECRET_KEY = process.env.MS_SECRET_KEY || ''    // secret from the developer cabinet
const VENDOR_API = process.env.MS_VENDOR_API || 'https://apps-api.moysklad.ru/api/vendor/1.0'
const MS_API = process.env.MS_API || 'https://api.moysklad.ru/api/remap/1.2'
const STORE_PATH = process.env.MS_STORE_PATH || '/data/accounts.json'
const SESSION_TTL = Number(process.env.MS_SESSION_TTL || 12 * 60 * 60)  // seconds

if (!APP_UID || !APP_ID || !SECRET_KEY) {
  console.warn('[config] MS_APP_UID / MS_APP_ID / MS_SECRET_KEY are not set — the app cannot be installed yet')
}

const store = await new AccountStore(STORE_PATH).load()
const app = express()
app.disable('x-powered-by')

// The widget is served from another origin, so allow it explicitly.
// MS_WIDGET_ORIGIN may hold a comma-separated list.
const ALLOWED_ORIGINS = (process.env.MS_WIDGET_ORIGIN || 'https://salma.oymoysklad.com')
  .split(',').map(s => s.trim()).filter(Boolean)

app.use((req, res, next) => {
  const origin = req.get('origin')
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin)
    res.set('Vary', 'Origin')
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept')
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.set('Access-Control-Max-Age', '86400')
  }
  if (req.method === 'OPTIONS') return res.status(204).end()
  return next()
})

// ─── JWT helpers ──────────────────────────────────────────────────────────────

/** Token for calling MoySklad's Vendor API (HS256 on our secret key, 5 min TTL). */
function vendorApiJwt() {
  const now = Math.floor(Date.now() / 1000)
  return jwt.sign(
    { sub: APP_UID, iat: now, exp: now + 300, jti: crypto.randomBytes(32).toString('hex') },
    SECRET_KEY,
    { algorithm: 'HS256' },
  )
}

/** MoySklad signs its calls to us with the same secret key — reject anything else. */
function requireMoyskladJwt(req, res, next) {
  const raw = (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!raw) return res.status(401).json({ error: 'missing bearer token' })
  try {
    jwt.verify(raw, SECRET_KEY, { algorithms: ['HS256'] })
    return next()
  } catch (e) {
    console.warn('[vendor] rejected call:', e.message, 'reqId=', req.get('X_Lognex_RequestId') || '-')
    return res.status(401).json({ error: 'invalid token' })
  }
}

/** Short-lived session handed to the browser instead of the account's real token. */
function issueSession(accountId, employeeName) {
  const now = Math.floor(Date.now() / 1000)
  return jwt.sign({ accountId, name: employeeName, iat: now, exp: now + SESSION_TTL }, SECRET_KEY, { algorithm: 'HS256' })
}

function readSession(req) {
  const raw = (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!raw) return null
  try {
    return jwt.verify(raw, SECRET_KEY, { algorithms: ['HS256'] })
  } catch {
    return null
  }
}

// ─── Vendor API: endpoints MoySklad calls on us ───────────────────────────────
// Descriptor endpointBase points here; MoySklad appends
// /api/moysklad/vendor/1.0/apps/{appId}/{accountId}
const VENDOR_ROUTE = '/api/moysklad/vendor/1.0/apps/:appId/:accountId'

// Установка решения на аккаунт — здесь МойСклад передаёт access_token аккаунта.
app.put(VENDOR_ROUTE, express.json({ limit: '256kb' }), requireMoyskladJwt, async (req, res) => {
  const { accountId } = req.params
  const body = req.body ?? {}
  const access = Array.isArray(body.access) ? body.access : []
  const token = access.find(a => a?.access_token)?.access_token
  if (!token) {
    console.error('[vendor] install without access_token, account=', accountId)
    return res.status(400).json({ error: 'no access_token in access[]' })
  }
  await store.put(accountId, {
    accessToken: token,
    appUid: body.appUid ?? APP_UID,
    accountName: body.accountName ?? null,
    status: 'Activated',
  })
  console.log('[vendor] installed for account', accountId, 'cause=', body.cause)
  // Настройки не требуются — решение готово к работе сразу.
  return res.json({ status: 'Activated' })
})

app.get(VENDOR_ROUTE, requireMoyskladJwt, (req, res) => {
  const acc = store.get(req.params.accountId)
  return res.json({ status: acc?.status ?? 'Activating' })
})

app.delete(VENDOR_ROUTE, express.json({ limit: '256kb' }), requireMoyskladJwt, async (req, res) => {
  await store.remove(req.params.accountId)
  console.log('[vendor] uninstalled for account', req.params.accountId)
  return res.status(200).end()
})

// ─── Widget session: contextKey → session token ───────────────────────────────
// The iframe is loaded with ?contextKey=…; we resolve it through the Vendor API to
// learn which account/employee opened the widget, then hand back OUR session token.
// The account's admin token never leaves this server.
app.get('/widget/session', async (req, res) => {
  const contextKey = String(req.query.contextKey || '')
  if (!contextKey) return res.status(400).json({ error: 'contextKey required' })
  try {
    const r = await fetch(`${VENDOR_API}/context/${encodeURIComponent(contextKey)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${vendorApiJwt()}`, Accept: 'application/json' },
    })
    if (!r.ok) {
      console.warn('[session] context lookup failed:', r.status, await r.text().catch(() => ''))
      return res.status(401).json({ error: 'contextKey rejected' })
    }
    const ctx = await r.json()
    // Same shape as /context/employee — accountId identifies the installation.
    const accountId = ctx?.accountId || ctx?.account?.id || ctx?.meta?.accountId
    if (!accountId) return res.status(502).json({ error: 'no accountId in context' })
    if (!store.get(accountId)) return res.status(403).json({ error: 'app is not installed for this account' })
    const name = ctx?.name || ctx?.fullName || ''
    return res.json({ session: issueSession(accountId, name), name })
  } catch (e) {
    console.error('[session] error:', e.message)
    return res.status(500).json({ error: 'context lookup failed' })
  }
})

// ─── MoySklad API proxy ───────────────────────────────────────────────────────
// The browser talks to /api/moysklad/* with OUR session token; we swap it for the
// account's real token here. Keeps an admin-scoped token out of the front end.
app.use('/api/moysklad', async (req, res) => {
  const session = readSession(req)
  if (!session) return res.status(401).json({ errors: [{ error: 'Session expired' }] })
  const acc = store.get(session.accountId)
  if (!acc?.accessToken) return res.status(403).json({ errors: [{ error: 'App is not installed' }] })

  const url = `${MS_API}${req.url}`
  const headers = {
    Authorization: `Bearer ${acc.accessToken}`,
    Accept: 'application/json;charset=utf-8',
  }
  const ct = req.get('content-type')
  if (ct) headers['Content-Type'] = ct

  // Stream the raw body through untouched (no body parser on this route).
  const hasBody = !['GET', 'HEAD'].includes(req.method)
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: hasBody ? req : undefined,
      duplex: hasBody ? 'half' : undefined,
    })
    res.status(upstream.status)
    const type = upstream.headers.get('content-type')
    if (type) res.set('content-type', type)
    const buf = Buffer.from(await upstream.arrayBuffer())
    return res.send(buf)
  } catch (e) {
    console.error('[proxy] error:', e.message)
    return res.status(502).json({ errors: [{ error: 'Upstream request failed' }] })
  }
})

app.get('/healthz', (_req, res) => res.json({ ok: true, configured: !!(APP_UID && APP_ID && SECRET_KEY) }))

app.listen(PORT, () => console.log(`[boot] listening on :${PORT}, appId=${APP_ID || '(unset)'}`))
