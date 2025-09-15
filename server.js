import express from 'express'
import cors from 'cors'
import { Pool } from 'pg'

const app = express()
app.use(cors())
app.use(express.json())

// --- Database connection (Render Postgres) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

// --- Health check (used by Render) ---
app.get('/api/health', (_, res) => res.json({ ok: true }))

// --- One-time bootstrap: create tables ---
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

// --- READ tasks ---
app.get('/api/tasks', async (_, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM tasks ORDER BY id DESC')
    res.json({ ok: true, data: rows })
  } catch (e) {
    console.error(e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

// --- CREATE task ---
app.post('/api/tasks', async (req, res) => {
  try {
    const { title, status = 'todo', amount = 0 } = req.body ?? {}
    if (!title) {
      return res.status(400).json({ ok: false, error: 'title is required' })
    }

    const { rows } = await pool.query(
      'INSERT INTO tasks (title, status, amount) VALUES ($1, $2, $3) RETURNING *',
      [title, status, amount]
    )
    res.status(201).json({ ok: true, data: rows[0] })
  } catch (e) {
    console.error(e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

const port = process.env.PORT || 10000
app.listen(port, () => console.log('API running on', port))
