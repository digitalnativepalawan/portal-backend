import express from 'express'
import cors from 'cors'
import { Pool } from 'pg'

const app = express()
app.use(cors())
app.use(express.json())

// Connect to Render Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

// Health check
app.get('/api/health', (_, res) => res.json({ ok: true }))

// Example: list all materials
app.get('/api/materials', async (_, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM materials ORDER BY id DESC')
    res.json({ ok: true, data: rows })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Example: insert new material
app.post('/api/materials', async (req, res) => {
  try {
    const { item_name, category, quantity, unit_cost } = req.body ?? {}
    if (!item_name || !quantity || !unit_cost) {
      return res.status(400).json({ ok: false, error: 'item_name, quantity, and unit_cost are required' })
    }

    const { rows } = await pool.query(
      `INSERT INTO materials (item_name, category, quantity, unit_cost) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [item_name, category, quantity, unit_cost]
    )
    res.status(201).json({ ok: true, data: rows[0] })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

const port = process.env.PORT || 10000
app.listen(port, () => console.log(`API running on ${port}`))
