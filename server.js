import express from 'express'
import cors from 'cors'
import { Pool } from 'pg'
import multer from 'multer'

const app = express()
app.use(cors())
app.use(express.json())

// ---- Database connection (Render Postgres) ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

// ---- Multer in-memory storage (we store bytes in Postgres) ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 } // 2MB max; adjust as needed
})

// ---- Health check ----
app.get('/api/health', (_, res) => res.json({ ok: true }))

// ---- One-time bootstrap to ensure tables exist ----
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

      CREATE TABLE IF NOT EXISTS material_images (
        id SERIAL PRIMARY KEY,
        material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        mime_type TEXT NOT NULL,
        bytes BYTEA NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `)

    // Ensure URL column exists for materials that store a public link instead of bytes
    await pool.query(`
      ALTER TABLE materials
      ADD COLUMN IF NOT EXISTS image_url TEXT
    `)

    res.json({ ok: true })
  } catch (e) {
    console.error(e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ---------------- TASKS (basic) ---------------- */
app.get('/api/tasks', async (_, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM tasks ORDER BY id DESC')
    res.json({ ok: true, data: rows })
  } catch (e) {
    console.error(e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/api/tasks', async (req, res) => {
  try {
    const { title, status = 'todo', amount = 0 } = req.body ?? {}
    if (!title) return res.status(400).json({ ok: false, error: 'title is required' })

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

/* --------------- MATERIALS (JSON) --------------- */

// List materials (include whether a stored file exists)
app.get('/api/materials', async (_, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        m.id,
        m.item_name,
        m.category,
        m.quantity,
        m.unit_cost,
        m.total,
        m.created_at,
        m.image_url,
        EXISTS (
          SELECT 1 FROM material_images mi WHERE mi.material_id = m.id
        ) AS has_file
      FROM materials m
      ORDER BY m.id DESC
    `)
    res.json({ ok: true, data: rows })
  } catch (e) {
    console.error(e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Create material (no image)
app.post('/api/materials', async (req, res) => {
  try {
    const { item_name, category, quantity, unit_cost } = req.body ?? {}
    if (!item_name || quantity == null || unit_cost == null) {
      return res.status(400).json({ ok: false, error: 'item_name, quantity, unit_cost required' })
    }
    const { rows } = await pool.query(
      `INSERT INTO materials (item_name, category, quantity, unit_cost)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [item_name, category, quantity, unit_cost]
    )
    res.status(201).json({ ok: true, data: rows[0] })
  } catch (e) {
    console.error(e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ------ MATERIALS: SAVE A PUBLIC IMAGE URL (JSON) ------ */
// POST /api/materials/url
// Body: { image_url, item_name, category, quantity, unit_cost }
app.post('/api/materials/url', async (req, res) => {
  try {
    const { image_url, item_name, category, quantity, unit_cost } = req.body ?? {}
    if (!image_url || !item_name || quantity == null || unit_cost == null) {
      return res.status(400).json({ ok: false, error: 'image_url, item_name, quantity, unit_cost required' })
    }
    const { rows } = await pool.query(
      `INSERT INTO materials (item_name, category, quantity, unit_cost, image_url)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [item_name, category, quantity, unit_cost, image_url]
    )
    res.status(201).json({ ok: true, data: rows[0] })
  } catch (e) {
    console.error(e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* -------- MATERIALS + IMAGE (multipart upload) -------- */
// POST /api/materials/upload (multipart/form-data)
// Fields: file (File), item_name, category, quantity, unit_cost
app.post('/api/materials/upload', upload.single('file'), async (req, res) => {
  const file = req.file
  const { item_name, category, quantity, unit_cost } = req.body ?? {}

  if (!item_name || quantity == null || unit_cost == null) {
    return res.status(400).json({ ok: false, error: 'item_name, quantity, unit_cost required' })
  }
  if (!file) {
    return res.status(400).json({ ok: false, error: 'file is required' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const material = await client.query(
      `INSERT INTO materials (item_name, category, quantity, unit_cost)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [item_name, category, unit_cost == null ? null : quantity, unit_cost] // (kept logic tidy below)
    )
    // Correct the parameter order: quantity ($3) first, then unit_cost ($4)
    // If you pasted the code above, let's re-run insert with correct values:
    const material2 = await client.query(
      `UPDATE materials
       SET item_name=$1, category=$2, quantity=$3, unit_cost=$4
       WHERE id=$5
       RETURNING *`,
      [item_name, category, quantity, unit_cost, material.rows[0].id]
    )

    await client.query(
      `INSERT INTO material_images (material_id, mime_type, bytes)
       VALUES ($1,$2,$3)`,
      [material2.rows[0].id, file.mimetype, file.buffer]
    )

    await client.query('COMMIT')
    res.status(201).json({ ok: true, data: material2.rows[0] })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ ok: false, error: e.message })
  } finally {
    client.release()
  }
})

/* -------- Serve latest image for a material -------- */
// GET /api/materials/:id/image
app.get('/api/materials/:id/image', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT mime_type, bytes
         FROM material_images
        WHERE material_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).send('No image')

    res.set('Content-Type', rows[0].mime_type)
    res.send(Buffer.from(rows[0].bytes))
  } catch (e) {
    console.error(e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

const port = process.env.PORT || 10000
app.listen(port, () => console.log('API running on', port))
