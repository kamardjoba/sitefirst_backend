// src/check_and_seed_pg.js (ESM)
import { pool } from './db_pool.js'

const REQUIRED_TABLES = ['actors','venues','shows','sessions','orders','tickets','promos']

async function tablesExist(client){
  const { rows } = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema='public'
  `)
  const have = new Set(rows.map(r=>r.table_name))
  return REQUIRED_TABLES.every(t => have.has(t))
}

async function main(){
  console.log('[SEED] Checking schema...')
  const client = await pool.connect()
  try{
    const ok = await tablesExist(client)
    if(ok){
      console.log('[SEED] Tables already exist — skipping seed.')
      return
    }
    console.log('[SEED] Tables missing — running seed_pg.js...')
    // динамически запускаем сидер
    const { default: child_process } = await import('node:child_process')
    await new Promise((resolve, reject)=>{
      const p = child_process.spawn('node', ['src/seed_pg.js'], { stdio: 'inherit' })
      p.on('close', code => code===0 ? resolve() : reject(new Error('seed exit '+code)))
    })
    console.log('[SEED] Done.')
  } finally {
    client.release()
  }
}

main().catch(e=>{
  console.error('[SEED] Failed:', e?.message || e)
  process.exit(1)
})