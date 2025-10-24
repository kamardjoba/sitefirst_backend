
import { Pool } from 'pg'

const connectionString = process.env.DATABASE_URL
if(!connectionString){
  console.warn('[db] DATABASE_URL is not set')
}
export const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
})

export async function tx(fn){
  const client = await pool.connect()
  try{
    await client.query('BEGIN')
    const res = await fn(client)
    await client.query('COMMIT')
    return res
  }catch(e){
    await client.query('ROLLBACK')
    throw e
  }finally{
    client.release()
  }
}
