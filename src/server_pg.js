
import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import { pool, tx } from './db_pool.js'
import { customAlphabet } from 'nanoid'

const nanoid = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 10)
const PORT = process.env.PORT || 4000
const ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173'

const app = express()
app.use(cors({ origin: ORIGIN }))
app.use(express.json())
app.use(morgan('dev'))

// Helpers
const showRowToObj = (row) => ({
  id: row.id,
  title: row.title,
  posterUrl: row.poster_url,
  genres: row.genres_json,
  durationMin: row.duration_min,
  rating: row.rating,
  popularity: row.popularity,
  description: row.description,
  cast: row.cast_ids_json,
  venueId: row.venue_id,
  sessions: row.sessions || []
})

// Routes
app.get('/api/actors', async (req,res)=>{
  const { rows } = await pool.query('SELECT id, name, photo_url AS "photoUrl", bio FROM actors ORDER BY id')
  // для фронта: avatarUrl ожидается в карточках актёра
  res.json(rows.map(a => ({ ...a, avatarUrl: a.avatarUrl || a.photoUrl })))
})

app.get('/api/venues', async (req,res)=>{
  const { rows } = await pool.query('SELECT id, name, city, address, seating_json AS "seatingMap" FROM venues ORDER BY id')
  res.json(rows)
})

app.get('/api/shows', async (req,res)=>{
  const { rows } = await pool.query('SELECT * FROM shows ORDER BY popularity DESC, rating DESC')
  // подтянем сессии пачкой
  const { rows: sess } = await pool.query('SELECT id, show_id, date_iso, time_iso, base_price, dynamic_factor FROM sessions ORDER BY date_iso, time_iso')
  const grouped = sess.reduce((acc, s)=>{
    (acc[s.show_id] ||= []).push({
      id: s.id, dateISO: s.date_iso, timeISO: s.time_iso, basePrice: s.base_price, dynamicFactor: s.dynamic_factor
    }); return acc
  }, {})
  res.json(rows.map(r => showRowToObj({ ...r, sessions: grouped[r.id] || [] })))
})

app.get('/api/shows/:id', async (req,res)=>{
  const id = Number(req.params.id)
  const one = await pool.query('SELECT * FROM shows WHERE id=$1',[id])
  if(one.rowCount===0) return res.status(404).json({ ok:false, error:'Show not found' })
  const { rows: sess } = await pool.query('SELECT id, show_id, date_iso, time_iso, base_price, dynamic_factor FROM sessions WHERE show_id=$1 ORDER BY date_iso, time_iso',[id])
  const withSessions = showRowToObj({ ...one.rows[0], sessions: sess.map(s=>({ id:s.id, dateISO:s.date_iso, timeISO:s.time_iso, basePrice:s.base_price, dynamicFactor:s.dynamic_factor })) })
  res.json(withSessions)
})

app.get('/api/sessions/:id/occupied', async (req,res)=>{
  const id = Number(req.params.id)
  const { rows } = await pool.query(`
    SELECT t.row, t.col
    FROM tickets t
    JOIN orders o ON o.id = t.order_id
    WHERE t.session_id = $1 AND o.status IN ('paid','pending')
  `, [id])
  res.json({ sessionId: id, seats: rows })
})

app.post('/api/promo/apply', async (req,res)=>{
  const { code } = req.body || {}
  if(!code) return res.status(400).json({ ok:false, error:'Missing code' })
  const nowISO = new Date().toISOString()
  const q = await pool.query(`SELECT code, discount_percent, valid_until_iso FROM promos WHERE lower(code)=lower($1)`, [code])
  if(q.rowCount===0) return res.json({ ok:true, promo: null })
  const p = q.rows[0]
  if(p.valid_until_iso && p.valid_until_iso < nowISO) return res.json({ ok:true, promo:null })
  res.json({ ok:true, promo: { code: p.code, discountPercent: p.discount_percent, validUntilISO: p.valid_until_iso } })
})

app.post('/api/orders', async (req,res)=>{
  const { customer, items, payment, promoCode } = req.body || {}
  if(!Array.isArray(items) || items.length===0) return res.status(400).json({ ok:false, error:'No items' })
  if(!customer || !customer.name || !customer.email || !customer.phone) return res.status(400).json({ ok:false, error:'Invalid customer' })

  try{
    const result = await tx(async (client)=>{
      // validate seats
      for(const it of items){
        const check = await client.query(
          `SELECT 1 FROM tickets t 
           JOIN orders o ON o.id = t.order_id 
           WHERE t.session_id=$1 AND t.row=$2 AND t.col=$3 AND o.status IN ('paid','pending') LIMIT 1`,
           [it.sessionId, it.seat?.row, it.seat?.col]
        )
        if(check.rowCount>0) throw new Error(`Seat already taken: session ${it.sessionId} r${it.seat?.row}c${it.seat?.col}`)
      }
      const subtotal = items.reduce((acc,it)=> acc + Number(it.price||0), 0)
      let discount = 0
      if(promoCode){
        const pr = await client.query(`SELECT discount_percent, valid_until_iso FROM promos WHERE lower(code)=lower($1)`,[promoCode])
        const nowISO = new Date().toISOString()
        if(pr.rowCount>0){
          const p = pr.rows[0]
          if(!p.valid_until_iso || p.valid_until_iso >= nowISO){
            discount = Math.round(subtotal * (p.discount_percent/100))
          }
        }
      }
      const total = Math.max(0, subtotal - discount)
      const orderId = nanoid()

      await client.query(
        `INSERT INTO orders (id,name,email,phone,payment,subtotal,discount,total,status,created_at_iso)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
         [orderId, customer.name, customer.email, customer.phone, payment||'card', subtotal, discount, total, 'paid', new Date().toISOString()]
      )
      for(const it of items){
        await client.query(
          `INSERT INTO tickets (order_id, session_id, row, col, price) VALUES ($1,$2,$3,$4,$5)`,
          [orderId, it.sessionId, it.seat?.row, it.seat?.col, it.price||0]
        )
      }
      return { orderId, total }
    })
    res.json({ ok:true, orderId: result.orderId, total: result.total })
  }catch(e){
    res.status(409).json({ ok:false, error: String(e.message||e) })
  }
})

app.get('/api/orders/:id', async (req,res)=>{
  const id = req.params.id
  const o = await pool.query(`SELECT id, name, email, phone, payment, subtotal, discount, total, status, created_at_iso FROM orders WHERE id=$1`, [id])
  if(o.rowCount===0) return res.status(404).json({ ok:false, error:'Order not found' })
  const t = await pool.query(`SELECT session_id AS "sessionId", row, col, price FROM tickets WHERE order_id=$1`, [id])
  res.json({ ...o.rows[0], tickets: t.rows })
})

// ===== Read-only Admin UI (PG) =====
const ADMIN_USER = process.env.ADMIN_USER || null
const ADMIN_PASS = process.env.ADMIN_PASS || null

function basicAuth(req, res, next){
  if(!ADMIN_USER || !ADMIN_PASS) return res.status(403).send('Admin disabled')
  const h = req.headers.authorization || ''
  if(!h.startsWith('Basic ')) return res.status(401).set('WWW-Authenticate','Basic').send('Auth required')
  const [user, pass] = Buffer.from(h.split(' ')[1], 'base64').toString().split(':')
  if(user===ADMIN_USER && pass===ADMIN_PASS) return next()
  return res.status(401).set('WWW-Authenticate','Basic').send('Auth required')
}

function escapeHtml(s=''){
  return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
}

function pageCss(){ return `
  body{font:14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:#0b0b0f; color:#ddd; padding:24px}
  table{border-collapse: collapse; width: 100%}
  th,td{border-bottom:1px solid #333; padding:8px 10px; text-align:left; vertical-align: top}
  a.link{color:#8ab4ff; text-decoration:none}
  .muted{color:#9aa0a6}
  input,button{background:#11131a;border:1px solid #2a2f3a;color:#ddd;padding:8px;border-radius:6px}
  .bar{display:flex; gap:8px; align-items:center; margin: 16px 0}
  .code{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; white-space: pre-wrap; word-break: break-word}
`}

app.get('/admin', basicAuth, async (req,res)=>{
  const q = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema='public'
    ORDER BY table_name
  `)
  const rows = await Promise.all(q.rows.map(async t=>{
    const c = await pool.query(`SELECT COUNT(*)::int as n FROM "${t.table_name}"`)
    return `<tr><td><a class="link" href="/admin/${t.table_name}">${t.table_name}</a></td><td>${c.rows[0].n}</td></tr>`
  }))
  res.type('html').send(`
    <html><head><meta charset="utf-8"><title>Admin</title><style>${pageCss()}</style></head>
    <body>
      <h1>Админка (read‑only, PG)</h1>
      <div class="bar">
        <form method="GET" action="/admin/sql" style="display:flex;gap:8px;flex:1">
          <input name="q" placeholder="SELECT * FROM shows LIMIT 20" style="flex:1"/>
          <button type="submit">Run</button>
        </form>
        <span class="muted">SELECT only</span>
      </div>
      <table><thead><tr><th>Таблица</th><th>Строк</th></tr></thead><tbody>${rows.join('')}</tbody></table>
    </body></html>
  `)
})

app.get('/admin/sql', basicAuth, async (req,res)=>{
  const q = String(req.query.q||'').trim()
  if(!/^select\b/i.test(q)) return res.status(400).send('SELECT only')
  try{
    const r = await pool.query(q)
    res.type('html').send(renderRowsHtml('SQL', r.rows))
  }catch(e){
    res.status(400).send('Error: '+escapeHtml(e.message||String(e)))
  }
})

function renderRowsHtml(title, rows){
  const headers = Object.keys(rows[0]||{})
  const head = headers.map(h=>`<th>${escapeHtml(h)}</th>`).join('')
  const body = rows.map(r=> `<tr>${headers.map(h=>`<td class="code">${escapeHtml(r[h])}</td>`).join('')}</tr>`).join('')
  return `
  <html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${pageCss()}</style></head>
  <body>
    <a class="link" href="/admin">← ко всем таблицам</a>
    <h2>${escapeHtml(title)}</h2>
    <table>
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </body></html>`
}

app.get('/admin/:table', basicAuth, async (req,res)=>{
  const table = req.params.table.replace(/[^a-zA-Z0-9_]/g,'')
  const r = await pool.query(`SELECT * FROM "${table}" LIMIT 200`)
  res.type('html').send(renderRowsHtml(table, r.rows))
})

// ===== End Admin UI =====

app.get('/api/health', (req,res)=> res.json({ ok:true }))

app.listen(PORT, ()=>{
  console.log(`Theatre backend (PG) running on http://localhost:${PORT}`)
})
