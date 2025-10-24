
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { pool } from './db_pool.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dataDir = path.resolve(__dirname, '../data')

function readJson(name){
  return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf-8'))
}

const schemaSql = `
DROP TABLE IF EXISTS tickets;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS shows;
DROP TABLE IF EXISTS venues;
DROP TABLE IF EXISTS actors;
DROP TABLE IF EXISTS promos;

CREATE TABLE actors(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  photo_url TEXT,
  bio TEXT
);

CREATE TABLE venues(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT,
  address TEXT,
  seating_json JSONB NOT NULL
);

CREATE TABLE shows(
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  poster_url TEXT,
  description TEXT,
  duration_min INTEGER,
  rating REAL,
  popularity INTEGER,
  venue_id INTEGER NOT NULL REFERENCES venues(id),
  genres_json JSONB NOT NULL,
  cast_ids_json JSONB NOT NULL
);

CREATE TABLE sessions(
  id INTEGER PRIMARY KEY,
  show_id INTEGER NOT NULL REFERENCES shows(id),
  date_iso TEXT NOT NULL,
  time_iso TEXT NOT NULL,
  base_price INTEGER NOT NULL,
  dynamic_factor REAL NOT NULL
);

CREATE TABLE orders(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  payment TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL,
  total INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at_iso TEXT NOT NULL
);

CREATE TABLE tickets(
  id SERIAL PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  row INTEGER NOT NULL,
  col INTEGER NOT NULL,
  price INTEGER NOT NULL
);

CREATE TABLE promos(
  code TEXT PRIMARY KEY,
  discount_percent INTEGER NOT NULL,
  valid_until_iso TEXT
);
`

async function main(){
  const client = await pool.connect()
  try{
    console.log('[seed] creating schema')
    await client.query(schemaSql)

    const actors = readJson('actors.json')
    const venues = readJson('venues.json')
    const shows = readJson('shows.json')
    const occupied = readJson('occupiedSeats.json')
    const promos = readJson('promo.json')

    console.log('[seed] actors')
    for(const a of actors){
      await client.query(
        'INSERT INTO actors (id,name,photo_url,bio) VALUES ($1,$2,$3,$4)',
        [a.id, a.name||`Актёр #${a.id}`, a.photoUrl||a.avatarUrl||null, a.bio||null]
      )
    }

    console.log('[seed] venues')
    for(const v of venues){
      await client.query(
        'INSERT INTO venues (id,name,city,address,seating_json) VALUES ($1,$2,$3,$4,$5)',
        [v.id, v.name, v.city||null, v.address||null, JSON.stringify(v.seatingMap||{})]
      )
    }

    console.log('[seed] shows & sessions')
    for(const s of shows){
      await client.query(
        `INSERT INTO shows (id,title,poster_url,description,duration_min,rating,popularity,venue_id,genres_json,cast_ids_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [s.id, s.title, s.posterUrl||null, s.description||null, s.durationMin||null, s.rating||0, s.popularity||0, s.venueId, JSON.stringify(s.genres||[]), JSON.stringify(s.cast||[])]
      )
      for(const session of (s.sessions||[])){
        await client.query(
          `INSERT INTO sessions (id, show_id, date_iso, time_iso, base_price, dynamic_factor)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [session.id, s.id, session.dateISO, session.timeISO, session.basePrice||0, session.dynamicFactor||1]
        )
      }
    }

    console.log('[seed] occupied seats -> paid orders')
    for(const oc of occupied){
      if(!Array.isArray(oc.seats) || oc.seats.length===0) continue
      const orderId = 'SEED'+String(oc.sessionId)
      const price = 1000
      const subtotal = price * oc.seats.length
      await client.query(
        `INSERT INTO orders (id,name,email,phone,payment,subtotal,discount,total,status,created_at_iso)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [orderId, 'Seed', 'seed@example.com', '+0000000', 'seed', subtotal, 0, subtotal, 'paid', new Date().toISOString()]
      )
      for(const s of oc.seats){
        await client.query(
          `INSERT INTO tickets (order_id, session_id, row, col, price) VALUES ($1,$2,$3,$4,$5)`,
          [orderId, oc.sessionId, s.row, s.col, price]
        )
      }
    }

    console.log('[seed] promos')
    for(const p of promos){
      await client.query(
        `INSERT INTO promos (code, discount_percent, valid_until_iso) VALUES ($1,$2,$3)`,
        [p.code, p.discountPercent, p.validUntilISO||null]
      )
    }

    console.log('[seed] done')
  }finally{
    client.release()
    await pool.end()
  }
}

main().catch(e=>{
  console.error(e)
  process.exit(1)
})
