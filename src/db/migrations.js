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

    CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain);
    CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);
    CREATE INDEX IF NOT EXISTS idx_companies_lead_score ON companies(lead_score);
  `);

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
}

module.exports = { runMigrations };
