CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Utilizatori
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', -- 'user' | 'admin'
  consent_version TEXT,
  consent_accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Bonuri încărcate
CREATE TABLE IF NOT EXISTS receipts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_name TEXT,
  store_tax_id TEXT,
  total_amount NUMERIC(10,2),
  currency TEXT DEFAULT 'RON',
  purchase_datetime TIMESTAMPTZ,
  image_url TEXT,          -- pentru imagini; la PDF păstrăm link pentru download
  pdf_url TEXT,            -- pentru PDF
  source_type TEXT NOT NULL CHECK (source_type IN ('image','pdf')),
  dedup_hash TEXT UNIQUE,
  ocr_confidence NUMERIC(4,2),
  raw_text TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'approved' -- 'pending'|'approved'|'rejected'
);

-- Linii produse extrase
CREATE TABLE IF NOT EXISTS receipt_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  line_no INT,
  product_name TEXT,
  store_name TEXT,
  qty NUMERIC(10,3),
  unit_price NUMERIC(10,2),
  total_price NUMERIC(10,2),
  category TEXT
);

-- Sondaje (create de admin)
CREATE TABLE IF NOT EXISTS surveys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS survey_questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  survey_id UUID REFERENCES surveys(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('single','multi','text')),
  question TEXT NOT NULL,
  options TEXT[] DEFAULT '{}',
  position INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  survey_id UUID REFERENCES surveys(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  answers JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
