import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Pool } from 'pg';
import nodemailer from 'nodemailer';
import pdfParse from 'pdf-parse';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  port: Number(process.env.PORT || 3000),
  jwtSecret: process.env.JWT_SECRET || 'dev',
  dbUrl: process.env.DATABASE_URL,
  uploadDir: path.join(__dirname, 'public', 'uploads'),
  ocrLang: process.env.OCR_LANG || 'eng',
  adminReportEmail: process.env.ADMIN_REPORT_EMAIL,
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
};

if (!fs.existsSync(config.uploadDir)) fs.mkdirSync(config.uploadDir, { recursive: true });

const app = express();
const pool = new Pool({ connectionString: config.dbUrl });

app.use(cors());
app.use(helmet());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* Utils */
const q = (text, params) => pool.query(text, params);
const sign = (payload) => jwt.sign(payload, config.jwtSecret, { expiresIn: '7d' });
const auth = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Fără token' });
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    return next();
  } catch {
    return res.status(401).json({ error: 'Token invalid' });
  }
};
const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Doar admin' });
  next();
};

const storage = multer.diskStorage({
  destination: (_req, file, cb) => cb(null, config.uploadDir),
  filename: (_req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + path.extname(file.originalname || ''))
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

/* Email */
const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: false,
  auth: { user: config.smtp.user, pass: config.smtp.pass }
});

/* OCR: imagini */
async function ocrImageAbs(fileAbsPath) {
  const buf = await sharp(fileAbsPath)
    .rotate()        // auto-orient
    .grayscale()
    .normalize()
    .sharpen()
    .toBuffer();

  const worker = await createWorker(config.ocrLang);
  const { data } = await worker.recognize(buf);
  await worker.terminate();
  return { text: data.text || '', confidence: data.confidence || 0 };
}

/* PDF → text */
async function pdfToTextAbs(fileAbsPath) {
  const dataBuffer = fs.readFileSync(fileAbsPath);
  const { text } = await pdfParse(dataBuffer);
  return text || '';
}

/* Parsare text bon: heuristici pentru nume produs + preț + qty */
function parseReceiptText(rawText) {
  const lines = rawText
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s);

  // magazin, total, data (heuristic)
  const storeName =
    (lines.find(l => /(s\.?c\.?|kaufland|lidl|profi|carrefour|mega|penny|dm|hornbach|dedeman|starbucks|5 to go|tazz|glovo|cora)/i) || '').slice(0, 60) || null;

  const totalMatch = rawText.match(/TOTAL\s*([0-9]+[.,][0-9]{2})/i) || rawText.match(/SUMA\s*([0-9]+[.,][0-9]{2})/i);
  const total = totalMatch ? Number(totalMatch[1].replace(',', '.')) : null;

  const dateMatch = rawText.match(/(20\d{2}[-./]\d{2}[-./]\d{2}\s*\d{2}:\d{2})/) || rawText.match(/(20\d{2}[-./]\d{2}[-./]\d{2})/);
  const dateISO = dateMatch ? new Date(dateMatch[1]).toISOString() : null;

  // linii produse: încercăm să extragem "denumire ... qty ... preț ... total"
  const items = [];
  let lineNo = 1;
  for (const l of lines) {
    // exemple: "ESPRESSO 2 x 7,50 15,00" sau "APA PLATA 1.5L 1 x 5,00"
    const m = l.match(/(.+?)\s+(\d+(?:[.,]\d+)?)\s*[xX×]\s*([0-9]+[.,][0-9]{2})\s+([0-9]+[.,][0-9]{2})$/);
    const m2 = l.match(/(.+?)\s+([0-9]+[.,][0-9]{2})$/); // fallback: denumire + total
    if (m) {
      const name = m[1].trim();
      const qty = Number(m[2].replace(',', '.'));
      const unit = Number(m[3].replace(',', '.'));
      const tot = Number(m[4].replace(',', '.'));
      if (name && tot > 0) items.push({ line_no: lineNo++, product_name: name, qty, unit_price: unit, total_price: tot });
    } else if (m2) {
      const name = m2[1].trim();
      const tot = Number(m2[2].replace(',', '.'));
      if (name && tot > 0) items.push({ line_no: lineNo++, product_name: name, qty: 1, unit_price: tot, total_price: tot });
    }
  }

  // categorizare simplă
  for (const it of items) {
    const n = it.product_name.toLowerCase();
    if (/(espresso|cafea|latte|capp|americano)/.test(n)) it.category = 'cafea';
    else if (/(apa|water|plata|carbog)/.test(n)) it.category = 'apa';
    else if (/(suc|cola|fanta|juice)/.test(n)) it.category = 'bauturi';
    else if (/(sandwich|croissant|patis|snack)/.test(n)) it.category = 'snack';
    else it.category = 'altele';
  }

  return { storeName, total, dateISO, items };
}

/* Deduplicare */
function makeDedupHash({ storeTaxId, dateISO, total }) {
  const key = `${storeTaxId || ''}|${dateISO || ''}|${total || ''}`;
  return crypto.createHash('sha256').update(key).digest('hex');
}

/* Email raport (doar adminReportEmail din .env) */
async function sendReportEmail({ subject, html }) {
  if (!config.adminReportEmail) return;
  await transporter.sendMail({
    from: '"Raport bonuri" <no-reply@yourapp>',
    to: config.adminReportEmail,
    subject,
    html
  });
}

/* Auth */
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, acceptConsent } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email și parolă necesare' });
    const hash = await bcrypt.hash(password, 10);
    const r = await q('INSERT INTO users (email,password_hash,role,consent_version,consent_accepted_at) VALUES ($1,$2,$3,$4,$5) RETURNING id,role',
      [email, hash, 'user', acceptConsent ? 'v1' : null, acceptConsent ? new Date() : null]);
    const token = sign({ sub: r.rows[0].id, role: r.rows[0].role });
    res.json({ token });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email existent' });
    res.status(500).json({ error: 'Eroare server' });
  }
});

app.post('/api/auth/signin', async (req, res) => {
  const { email, password } = req.body;
  const r = await q('SELECT id,password_hash,role,consent_accepted_at FROM users WHERE email=$1', [email]);
  if (!r.rowCount) return res.status(400).json({ error: 'Credențiale invalide' });
  const ok = await bcrypt.compare(password, r.rows[0].password_hash);
  if (!ok) return res.status(400).json({ error: 'Credențiale invalide' });
  const token = sign({ sub: r.rows[0].id, role: r.rows[0].role, consent: !!r.rows[0].consent_accepted_at });
  res.json({ token });
});

app.post('/api/consent/accept', auth, async (req, res) => {
  await q('UPDATE users SET consent_version=$1, consent_accepted_at=$2 WHERE id=$3', ['v1', new Date(), req.user.sub]);
  res.json({ ok: true });
});

/* Upload: imagine sau PDF */
app.post('/api/receipts/upload', auth, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Lipsește fișierul' });
    const ext = (path.extname(file.originalname || '').toLowerCase());
    const isPDF = ext === '.pdf' || file.mimetype === 'application/pdf';
    const fileUrl = '/uploads/' + path.basename(file.path);

    let rawText = '';
    let ocrConfidence = null;
    if (isPDF) {
      rawText = await pdfToTextAbs(file.path);
    } else {
      const ocr = await ocrImageAbs(file.path);
      rawText = ocr.text;
      ocrConfidence = Number((ocr.confidence || 0).toFixed(2));
    }

    const parsed = parseReceiptText(rawText);
    const dedup = makeDedupHash({ storeTaxId: null, dateISO: parsed.dateISO, total: parsed.total });

    const exists = await q('SELECT 1 FROM receipts WHERE dedup_hash=$1', [dedup]);
    if (exists.rowCount) return res.status(409).json({ error: 'Bon duplicat' });

    const r = await q(
      `INSERT INTO receipts (user_id,store_name,total_amount,purchase_datetime,image_url,pdf_url,source_type,dedup_hash,ocr_confidence,raw_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        req.user.sub,
        parsed.storeName,
        parsed.total,
        parsed.dateISO,
        !isPDF ? fileUrl : null,
        isPDF ? fileUrl : null,
        isPDF ? 'pdf' : 'image',
        dedup,
        ocrConfidence,
        rawText
      ]
    );
    const receiptId = r.rows[0].id;

    // inserează iteme
    for (const it of parsed.items.slice(0, 200)) {
      await q(`INSERT INTO receipt_items (receipt_id,line_no,product_name,store_name,qty,unit_price,total_price,category)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [receiptId, it.line_no, it.product_name, parsed.storeName, it.qty, it.unit_price, it.total_price, it.category]);
    }

    res.json({
      id: receiptId,
      store_name: parsed.storeName,
      total_amount: parsed.total,
      purchase_datetime: parsed.dateISO,
      items: parsed.items
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Upload/parsare a eșuat' });
  }
});

/* Lista bonuri ale utilizatorului */
app.get('/api/receipts/my', auth, async (req, res) => {
  const r = await q(`SELECT id,store_name,total_amount,purchase_datetime,image_url,pdf_url,source_type,uploaded_at
                     FROM receipts WHERE user_id=$1 ORDER BY uploaded_at DESC LIMIT 200`, [req.user.sub]);
  res.json(r.rows);
});

/* Items extrase pentru un bon */
app.get('/api/receipts/:id/items', auth, async (req, res) => {
  const r = await q('SELECT product_name,qty,unit_price,total_price,category FROM receipt_items WHERE receipt_id=$1 ORDER BY line_no', [req.params.id]);
  res.json(r.rows);
});

/* Agregări personale (unde se cumpără cel mai mult / ce se cumpără) */
app.get('/api/analytics/overview', auth, async (req, res) => {
  const byProduct = await q(
    `SELECT LOWER(product_name) AS name, SUM(qty)::float AS qty, SUM(total_price)::float AS sum
     FROM receipt_items ri JOIN receipts r ON r.id=ri.receipt_id
     WHERE r.user_id=$1 GROUP BY name ORDER BY qty DESC LIMIT 20`, [req.user.sub]);
  const byStore = await q(
    `SELECT COALESCE(r.store_name,'(necunoscut)') AS store, COUNT(*)::int AS receipts, SUM(r.total_amount)::float AS total
     FROM receipts r WHERE r.user_id=$1 GROUP BY store ORDER BY total DESC LIMIT 20`, [req.user.sub]);

  res.json({ byProduct: byProduct.rows, byStore: byStore.rows });
});

/* Trimite raport pe email (doar backend cunoaște adresa) */
app.post('/api/analytics/send-report', auth, async (req, res) => {
  try {
    const [byProduct, byStore] = await Promise.all([
      q(
        `SELECT LOWER(product_name) AS name, SUM(qty)::float AS qty, SUM(total_price)::float AS sum
         FROM receipt_items ri JOIN receipts r ON r.id=ri.receipt_id
         WHERE r.user_id=$1 GROUP BY name ORDER BY qty DESC LIMIT 20`, [req.user.sub]),
      q(
        `SELECT COALESCE(r.store_name,'(necunoscut)') AS store, COUNT(*)::int AS receipts, SUM(r.total_amount)::float AS total
         FROM receipts r WHERE r.user_id=$1 GROUP BY store ORDER BY total DESC LIMIT 20`, [req.user.sub])
    ]);

    const html = `
      <h2>Raport cumpărături</h2>
      <h3>Top produse (după cantitate)</h3>
      <table border="1" cellpadding="6" cellspacing="0">
        <tr><th>Produs</th><th>Cantitate</th><th>Suma (RON)</th></tr>
        ${byProduct.rows.map(p => `<tr><td>${p.name}</td><td>${p.qty.toFixed(2)}</td><td>${(p.sum||0).toFixed(2)}</td></tr>`).join('')}
      </table>
      <h3>Top locații</h3>
      <table border="1" cellpadding="6" cellspacing="0">
        <tr><th>Locație</th><th>Bonuri</th><th>Total (RON)</th></tr>
        ${byStore.rows.map(s => `<tr><td>${s.store}</td><td>${s.receipts}</td><td>${(s.total||0).toFixed(2)}</td></tr>`).join('')}
      </table>
    `;
    await sendReportEmail({ subject: 'Raport cumpărături (utilizator)', html });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Email nereușit' });
  }
});

/* Sondaje – admin creează, user răspunde */
app.post('/api/admin/surveys', auth, requireAdmin, async (req, res) => {
  const { title, description, questions } = req.body;
  const s = await q('INSERT INTO surveys (title,description) VALUES ($1,$2) RETURNING id', [title, description || null]);
  const sid = s.rows[0].id;
  let pos = 0;
  for (const qn of questions || []) {
    await q('INSERT INTO survey_questions (survey_id,kind,question,options,position) VALUES ($1,$2,$3,$4,$5)',
      [sid, qn.kind, qn.question, qn.options || [], pos++]);
  }
  res.json({ id: sid });
});

app.get('/api/surveys/active', auth, async (_req, res) => {
  const s = await q('SELECT id,title,description FROM surveys WHERE is_active=true ORDER BY created_at DESC LIMIT 5');
  const data = [];
  for (const row of s.rows) {
    const qs = await q('SELECT id,kind,question,options,position FROM survey_questions WHERE survey_id=$1 ORDER BY position', [row.id]);
    data.push({ ...row, questions: qs.rows });
  }
  res.json(data);
});

app.post('/api/surveys/:id/answer', auth, async (req, res) => {
  const { answers } = req.body; // {questionId: value}
  await q('INSERT INTO survey_responses (survey_id,user_id,answers) VALUES ($1,$2,$3)', [req.params.id, req.user.sub, answers]);
  // Aici poți marca o "recompensă" virtuală în viitor
  res.json({ ok: true });
});

/* Admin – agregări globale (tu ești admin) */
app.get('/api/admin/overview', auth, requireAdmin, async (_req, res) => {
  const totals = await q(`SELECT COUNT(*)::int AS receipts,
                                 COALESCE(AVG(total_amount),0)::float AS avg_basket
                          FROM receipts WHERE status='approved'`);
  const topCafe = await q(
    `SELECT LOWER(product_name) AS name, SUM(qty)::float qty
     FROM receipt_items WHERE category='cafea' GROUP BY name ORDER BY qty DESC LIMIT 10`);
  const byStore = await q(
    `SELECT COALESCE(store_name,'(necunoscut)') store, COUNT(*)::int c, COALESCE(SUM(total_amount),0)::float total
     FROM receipts GROUP BY store ORDER BY total DESC LIMIT 10`);
  res.json({ totals: totals.rows[0], topCafe: topCafe.rows, byStore: byStore.rows });
});

/* Health */
app.get('/api/health', (_req, res) => res.json({ ok: true }));

/* PORNEȘTE SERVERUL */
app.listen(config.port, () => {
  console.log('Server pornit pe http://localhost:' + config.port);
});
