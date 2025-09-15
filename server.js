import express from 'express'
import cors from 'cors'
import { Pool } from 'pg'

const app = express()
app.use(cors())
app.use(express.json())

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

// health check
app.get('/api/health', (_, res) => res.json({ ok: true }))

// one-time bootstrap: creates tables
app.post('/api/bootstrap', async (_, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT DEFAULT 'todo',
        amount NUMERIC(12,2) DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS labor (
        id SERIAL PRIMARY KEY,
        worker_name TEXT NOT NULL,
        role TEXT,
        hours NUMERIC(6,2) NOT NULL,
        rate NUMERIC(12,2) NOT NULL,
        total NUMERIC(12,2) GENERATED ALWAYS AS (hours * rate) STORED,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS materials (
        id SERIAL PRIMARY KEY,
        item_name TEXT NOT NULL,
        category TEXT,
        quantity NUMERIC(10,2) NOT NULL,
        unit_cost NUMERIC(12,2) NOT NULL,
        total NUMERIC(12,2) GENERATED ALWAYS AS (quantity * unit_cost) STORED,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `)
    res.json({ ok: true })
  } catch (e) {
    console.error(e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

// simple read (optional check)
app.get('/api/tasks', async (_, res) => {
  const { rows } = await pool.query('select * from tasks order by id desc')
  res.json(rows)
})

const port = process.env.PORT || 10000
app.listen(port, () => console.log('API running on', port))
