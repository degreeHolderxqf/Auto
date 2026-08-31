function runMigrations(db) {
  // 1. Companies Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      domain TEXT,
      shopify_partner_url TEXT UNIQUE,
      official_website TEXT,
      city TEXT,
      state TEXT,
      country TEXT DEFAULT 'India',
      partner_tier TEXT,
      rating REAL,
      reviews INTEGER DEFAULT 0,
      employee_count INTEGER,
      employee_count_min INTEGER,
      employee_count_max INTEGER,
      employee_size_range TEXT,
      employee_count_source TEXT,
      employee_count_source_url TEXT,
      employee_count_verified INTEGER DEFAULT 0,
      employee_count_verified_at TEXT,
      employee_count_status TEXT DEFAULT 'UNKNOWN',
      app_relevance_score INTEGER DEFAULT 0,
      lead_score INTEGER DEFAULT 0,
      shopify_services TEXT,
      public_apps TEXT,
      careers_url TEXT,
      linkedin_url TEXT,
      status TEXT DEFAULT 'DISCOVERED',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migration: Add missing columns if existing table was created in older schema
  try {
    const tableInfo = db.prepare("PRAGMA table_info(companies)").all();
    const columnNames = tableInfo.map((c) => c.name);

    const columnsToAdd = [
      { name: "employee_count", type: "INTEGER" },
      { name: "employee_count_min", type: "INTEGER" },
      { name: "employee_count_max", type: "INTEGER" },
      { name: "employee_size_range", type: "TEXT" },
      { name: "employee_count_source", type: "TEXT" },
      { name: "employee_count_source_url", type: "TEXT" },
      { name: "employee_count_verified", type: "INTEGER DEFAULT 0" },
      { name: "employee_count_verified_at", type: "TEXT" },
      { name: "employee_count_status", type: "TEXT DEFAULT 'UNKNOWN'" }
    ];

    for (const col of columnsToAdd) {
      if (!columnNames.includes(col.name)) {
        try {
          db.exec(`ALTER TABLE companies ADD COLUMN ${col.name} ${col.type};`);
        } catch (alterErr) {
          // ignore column exists
        }
      }
    }
  } catch (e) {
    // ignore
  }

  // Create Indexes on Companies table after columns are guaranteed to exist
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain);
      CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);
      CREATE INDEX IF NOT EXISTS idx_companies_lead_score ON companies(lead_score);
      CREATE INDEX IF NOT EXISTS idx_companies_employee_count ON companies(employee_count);
      CREATE INDEX IF NOT EXISTS idx_companies_employee_status ON companies(employee_count_status);
    `);
  } catch (e) {
    // ignore
  }

  // 2. Contacts Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      name TEXT,
      role TEXT,
      email TEXT NOT NULL UNIQUE,
      email_type TEXT,
      confidence TEXT DEFAULT 'LOW',
      source_url TEXT,
      verified INTEGER DEFAULT 0,
      mx_valid INTEGER DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_company_id ON contacts(company_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
    CREATE INDEX IF NOT EXISTS idx_contacts_confidence ON contacts(confidence);
  `);

  // 3. Sources Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      evidence TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sources_company ON sources(company_id);
  `);

  // 4. Exclusions Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS exclusions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      domain TEXT,
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_exclusions_norm_name ON exclusions(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_exclusions_domain ON exclusions(domain);
  `);

  // 5. Campaigns Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'DRAFT',
      total_leads INTEGER DEFAULT 0,
      sent_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // 6. Email Logs Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      contact_id INTEGER,
      campaign_id INTEGER,
      email TEXT NOT NULL,
      subject TEXT,
      status TEXT NOT NULL,
      message_id TEXT,
      error TEXT,
      attempts INTEGER DEFAULT 1,
      sent_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id),
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_email_logs_email ON email_logs(email);
    CREATE INDEX IF NOT EXISTS idx_email_logs_company ON email_logs(company_id);
    CREATE INDEX IF NOT EXISTS idx_email_logs_status ON email_logs(status);
  `);

  // Migration: Add missing phone/whatsapp columns to companies
  try {
    const compInfo = db.prepare("PRAGMA table_info(companies)").all();
    const compCols = compInfo.map((c) => c.name);
    const phoneColsComp = [
      { name: "phone", type: "TEXT" },
      { name: "normalized_phone", type: "TEXT" },
      { name: "phone_type", type: "TEXT" },
      { name: "phone_source", type: "TEXT" },
      { name: "phone_source_url", type: "TEXT" },
      { name: "whatsapp_available", type: "TEXT DEFAULT 'unknown'" },
      { name: "whatsapp_status", type: "TEXT DEFAULT 'READY'" }
    ];

    for (const col of phoneColsComp) {
      if (!compCols.includes(col.name)) {
        try {
          db.exec(`ALTER TABLE companies ADD COLUMN ${col.name} ${col.type};`);
        } catch {
          // ignore
        }
      }
    }
  } catch {}

  // Migration: Add missing phone/whatsapp columns to contacts
  try {
    const contInfo = db.prepare("PRAGMA table_info(contacts)").all();
    const contCols = contInfo.map((c) => c.name);
    const phoneColsCont = [
      { name: "phone", type: "TEXT" },
      { name: "normalized_phone", type: "TEXT" },
      { name: "phone_type", type: "TEXT" },
      { name: "phone_source", type: "TEXT" },
      { name: "phone_source_url", type: "TEXT" },
      { name: "whatsapp_available", type: "TEXT DEFAULT 'unknown'" },
      { name: "whatsapp_status", type: "TEXT DEFAULT 'READY'" }
    ];

    for (const col of phoneColsCont) {
      if (!contCols.includes(col.name)) {
        try {
          db.exec(`ALTER TABLE contacts ADD COLUMN ${col.name} ${col.type};`);
        } catch {
          // ignore
        }
      }
    }
  } catch {}

  // 7. Settings Table (Key-Value Dynamic Configuration)
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // 8. WhatsApp Logs Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      contact_id INTEGER,
      phone TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      message_id TEXT,
      error TEXT,
      sent_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id),
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_phone ON whatsapp_logs(phone);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_company ON whatsapp_logs(company_id);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_status ON whatsapp_logs(status);
  `);
}

module.exports = { runMigrations };
