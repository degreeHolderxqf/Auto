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
      { name: "employee_count_status", type: "TEXT DEFAULT 'UNKNOWN'" },
      // App Store / source tracking
      { name: "source", type: "TEXT DEFAULT 'SHOPIFY_PARTNER_DIRECTORY'" },
      { name: "app_store_url", type: "TEXT" },
      { name: "app_store_slug", type: "TEXT" },
      { name: "developer_name", type: "TEXT" },
      { name: "developer_location", type: "TEXT" },
      { name: "developer_website", type: "TEXT" },
      { name: "support_email", type: "TEXT" },
      { name: "india_confidence", type: "TEXT DEFAULT 'UNKNOWN'" },
      { name: "india_evidence", type: "TEXT" }
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
      CREATE INDEX IF NOT EXISTS idx_companies_source ON companies(source);
      CREATE INDEX IF NOT EXISTS idx_companies_app_store_slug ON companies(app_store_slug);
      CREATE INDEX IF NOT EXISTS idx_companies_developer_name ON companies(developer_name);
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

  // 9. Email Batches Table (resumable batch tracking)
  // Each user-initiated send creates a row here. Progress is checkpointed
  // after every email so a Vercel timeout can be resumed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_batches (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'LIVE',
      status TEXT NOT NULL DEFAULT 'PENDING',
      total INTEGER NOT NULL DEFAULT 0,
      sent INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      pending INTEGER NOT NULL DEFAULT 0,
      processing INTEGER NOT NULL DEFAULT 0,
      current_index INTEGER NOT NULL DEFAULT 0,
      last_processed_id INTEGER,
      lead_ids_json TEXT NOT NULL,
      chunk_size INTEGER NOT NULL DEFAULT 10,
      started_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_email_batches_status ON email_batches(status);
    CREATE INDEX IF NOT EXISTS idx_email_batches_updated ON email_batches(updated_at);
  `);

  // 10. Email Batch Items Table (per-lead state)
  // One row per (batch, company). The unique index gives idempotency:
  // a resumed batch will not re-enqueue leads that already have a row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_batch_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      company_id INTEGER NOT NULL,
      contact_id INTEGER,
      email TEXT NOT NULL,
      subject TEXT,
      mail_options_json TEXT,
      position INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0,
      message_id TEXT,
      error TEXT,
      processed_at TEXT,
      UNIQUE(batch_id, company_id),
      FOREIGN KEY (batch_id) REFERENCES email_batches(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_ebi_batch_status ON email_batch_items(batch_id, status);
    CREATE INDEX IF NOT EXISTS idx_ebi_batch_position ON email_batch_items(batch_id, position);
  `);

  // 11. Remote Jobs Table (canonical remote job listings)
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      company_name TEXT NOT NULL,
      company_domain TEXT,
      description TEXT,
      requirements TEXT,
      skills TEXT,
      employment_type TEXT,
      experience_level TEXT,
      location TEXT,
      location_restrictions TEXT,
      salary_min INTEGER,
      salary_max INTEGER,
      salary_currency TEXT DEFAULT 'USD',
      relevance_score INTEGER DEFAULT 0,
      match_reason TEXT,
      status TEXT DEFAULT 'new',
      application_url TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_canonical ON jobs(canonical_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_relevance ON jobs(relevance_score DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_employment_type ON jobs(employment_type);
    CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company_name);
    CREATE INDEX IF NOT EXISTS idx_jobs_location ON jobs(location);
  `);

  // 12. Job Sources Table (source URL mapping)
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      source_url TEXT NOT NULL,
      source_type TEXT NOT NULL,
      title TEXT,
      evidence TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(job_id, source_url),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_job_sources_job_id ON job_sources(job_id);
    CREATE INDEX IF NOT EXISTS idx_job_sources_type ON job_sources(source_type);
    CREATE INDEX IF NOT EXISTS idx_job_sources_url ON job_sources(source_url);
  `);

  // 13. Applications Table (application tracker)
  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      status TEXT DEFAULT 'ready',
      applied_at TEXT,
      resume_version TEXT,
      cover_letter TEXT,
      screening_answers TEXT,
      recruiter_email TEXT,
      recruiter_phone TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_applications_job_id ON applications(job_id);
    CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
    CREATE INDEX IF NOT EXISTS idx_applications_applied_at ON applications(applied_at);
  `);

  // 14. Job Profiles Table (candidate profile for generated assets)
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_identifier TEXT NOT NULL DEFAULT 'default',
      candidate_name TEXT,
      candidate_role TEXT,
      candidate_experience TEXT,
      candidate_email TEXT,
      candidate_phone TEXT,
      candidate_skills TEXT,
      resume_filename TEXT,
      resume_path TEXT,
      generated_cover_letter TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Single row for the user's profile
    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_profiles_user ON job_profiles(user_identifier);
  `);

  // 15. Job Runs Table (serverless job execution state)
  // id is TEXT to support string-based run IDs like "run_<timestamp>_<hex>"
  // (safer for serverless resumability than integer auto-increment)
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_runs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      last_cursor TEXT,
      processed_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      error_message TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      checkpoint_data TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_job_runs_type ON job_runs(type);
    CREATE INDEX IF NOT EXISTS idx_job_runs_status ON job_runs(status);
    CREATE INDEX IF NOT EXISTS idx_job_runs_started ON job_runs(started_at);
  `);

  // Schema fix: if an old job_runs table was created with INTEGER id, rebuild it as TEXT
  // (preserves existing rows; safe because job_runs is the only consumer)
  try {
    const idCol = db.prepare("PRAGMA table_info(job_runs)").all().find((c) => c.name === "id");
    if (idCol && idCol.type && idCol.type.toUpperCase().startsWith("INTEGER")) {
      db.exec(`
        BEGIN TRANSACTION;
        CREATE TABLE job_runs__new (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          last_cursor TEXT,
          processed_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          error_message TEXT,
          started_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT,
          checkpoint_data TEXT
        );
        INSERT INTO job_runs__new (id, type, status, last_cursor, processed_count, success_count, error_message, started_at, completed_at, checkpoint_data)
        SELECT CAST(id AS TEXT), type, status, CAST(last_cursor AS TEXT), processed_count, success_count, error_message, started_at, completed_at, checkpoint_data
        FROM job_runs;
        DROP TABLE job_runs;
        ALTER TABLE job_runs__new RENAME TO job_runs;
        CREATE INDEX IF NOT EXISTS idx_job_runs_type ON job_runs(type);
        CREATE INDEX IF NOT EXISTS idx_job_runs_status ON job_runs(status);
        CREATE INDEX IF NOT EXISTS idx_job_runs_started ON job_runs(started_at);
        COMMIT;
      `);
    }
  } catch (rebuildErr) {
    try { db.exec("ROLLBACK;"); } catch {}
    // ignore — new table already correct
  }

  // Merchant lead metadata is kept separate from general company services.
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchant_lead_details (
      company_id INTEGER PRIMARY KEY,
      website_url TEXT,
      installed_apps_json TEXT NOT NULL DEFAULT '[]',
      tech_stack_json TEXT NOT NULL DEFAULT '[]',
      estimated_revenue TEXT,
      store_description TEXT,
      product_count INTEGER,
      public_contact_links_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS merchant_revenue_estimates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL UNIQUE,
      domain TEXT NOT NULL,
      estimated_monthly_revenue REAL,
      estimated_monthly_revenue_min REAL,
      estimated_monthly_revenue_max REAL,
      estimated_annual_revenue REAL,
      estimated_annual_revenue_min REAL,
      estimated_annual_revenue_max REAL,
      currency TEXT,
      store_currency TEXT,
      aov REAL,
      aov_method TEXT,
      conversion_rate REAL,
      estimated_traffic INTEGER,
      traffic_provider TEXT,
      traffic_metric TEXT,
      traffic_period TEXT,
      confidence TEXT,
      method TEXT,
      status TEXT NOT NULL DEFAULT 'INSUFFICIENT_DATA',
      reason TEXT,
      data_sources_json TEXT NOT NULL DEFAULT '[]',
      assumptions_json TEXT NOT NULL DEFAULT '[]',
      estimate_updated_at TEXT,
      product_count INTEGER,
      product_price_proxy REAL,
      product_price_min REAL,
      product_price_max REAL,
      product_price_p25 REAL,
      product_price_p75 REAL,
      product_samples INTEGER,
      product_records_json TEXT NOT NULL DEFAULT '[]',
      domain_rank INTEGER,
      domain_rank_status TEXT,
      domain_rank_source TEXT,
      domain_rank_publication_date TEXT,
      domain_rank_dataset_key TEXT,
      shopify_status TEXT,
      shopify_confidence TEXT,
      shopify_signals_json TEXT NOT NULL DEFAULT '[]',
      review_widget_detected INTEGER NOT NULL DEFAULT 0,
      review_providers_json TEXT NOT NULL DEFAULT '[]',
      review_count INTEGER,
      review_count_status TEXT,
      review_count_source TEXT,
      review_count_observed_at TEXT,
      review_count_previous INTEGER,
      review_count_change INTEGER,
      latest_data_sources_json TEXT NOT NULL DEFAULT '[]',
      latest_assumptions_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS domain_rank_datasets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      dataset_key TEXT NOT NULL,
      publication_date TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      row_count INTEGER NOT NULL DEFAULT 0,
      file_sha256 TEXT,
      source_url TEXT,
      UNIQUE(source, dataset_key)
    );

    CREATE TABLE IF NOT EXISTS domain_ranks (
      dataset_id INTEGER NOT NULL,
      domain TEXT NOT NULL,
      rank INTEGER NOT NULL,
      PRIMARY KEY(dataset_id, domain),
      FOREIGN KEY (dataset_id) REFERENCES domain_rank_datasets(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_domain_ranks_domain ON domain_ranks(domain);

    CREATE TABLE IF NOT EXISTS merchant_review_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      domain TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'structured_data',
      review_count INTEGER NOT NULL,
      source_url TEXT,
      snapshot_date TEXT NOT NULL,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_id, provider, snapshot_date),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_merchant_review_snapshots_company
      ON merchant_review_snapshots(company_id, provider, observed_at);

    CREATE INDEX IF NOT EXISTS idx_merchant_revenue_domain
      ON merchant_revenue_estimates(domain);
    CREATE INDEX IF NOT EXISTS idx_merchant_revenue_status
      ON merchant_revenue_estimates(status);

    CREATE TABLE IF NOT EXISTS merchant_outreach_batches (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'QUEUED',
      dry_run INTEGER NOT NULL DEFAULT 1,
      total INTEGER NOT NULL DEFAULT 0,
      sent INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      pending INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_merchant_batches_status
      ON merchant_outreach_batches(status);

    CREATE TABLE IF NOT EXISTS merchant_outreach_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      company_id INTEGER NOT NULL,
      contact_id INTEGER,
      recipient TEXT,
      position INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      message_id TEXT,
      error TEXT,
      processed_at TEXT,
      UNIQUE(batch_id, company_id),
      FOREIGN KEY (batch_id) REFERENCES merchant_outreach_batches(id) ON DELETE CASCADE,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_merchant_items_batch_status
      ON merchant_outreach_items(batch_id, status);
    CREATE INDEX IF NOT EXISTS idx_merchant_items_batch_position
      ON merchant_outreach_items(batch_id, position);

    CREATE TABLE IF NOT EXISTS merchant_outreach_rate_limit (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      next_send_at INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO merchant_outreach_rate_limit (id, next_send_at) VALUES (1, 0);
  `);

  // Additive enrichment fields for databases created before public signal collection.
  // Existing estimates are left intact and columns are added only when absent.
  try {
    const existingColumns = new Set(db.prepare("PRAGMA table_info(merchant_revenue_estimates)").all().map((column) => column.name));
    const additions = [
      ["store_currency", "TEXT"], ["estimate_updated_at", "TEXT"], ["product_count", "INTEGER"],
      ["product_price_proxy", "REAL"], ["product_price_min", "REAL"], ["product_price_max", "REAL"],
      ["product_price_p25", "REAL"], ["product_price_p75", "REAL"],
      ["product_samples", "INTEGER"], ["product_records_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["domain_rank", "INTEGER"], ["domain_rank_status", "TEXT"], ["domain_rank_source", "TEXT"],
      ["domain_rank_publication_date", "TEXT"], ["domain_rank_dataset_key", "TEXT"],
      ["shopify_status", "TEXT"], ["shopify_confidence", "TEXT"],
      ["shopify_signals_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["review_widget_detected", "INTEGER NOT NULL DEFAULT 0"],
      ["review_providers_json", "TEXT NOT NULL DEFAULT '[]'"], ["review_count", "INTEGER"],
      ["review_count_status", "TEXT"], ["review_count_source", "TEXT"], ["review_count_observed_at", "TEXT"],
      ["review_count_previous", "INTEGER"], ["review_count_change", "INTEGER"],
      ["latest_data_sources_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["latest_assumptions_json", "TEXT NOT NULL DEFAULT '[]'"]
    ];
    for (const [name, type] of additions) {
      if (!existingColumns.has(name)) db.exec(`ALTER TABLE merchant_revenue_estimates ADD COLUMN ${name} ${type};`);
    }
  } catch (error) {
    // Let startup continue on legacy schemas; the normal CREATE TABLE path covers new databases.
    console.warn("[MIGRATION] Revenue signal columns could not be added:", error.message);
  }

  const merchantColumns = new Set(
    db.prepare("PRAGMA table_info(merchant_lead_details)").all().map((column) => column.name)
  );
  if (!merchantColumns.has("store_description")) {
    db.exec("ALTER TABLE merchant_lead_details ADD COLUMN store_description TEXT");
  }
  if (!merchantColumns.has("product_count")) {
    db.exec("ALTER TABLE merchant_lead_details ADD COLUMN product_count INTEGER");
  }
  if (!merchantColumns.has("public_contact_links_json")) {
    db.exec("ALTER TABLE merchant_lead_details ADD COLUMN public_contact_links_json TEXT NOT NULL DEFAULT '{}'");
  }

  // =============================================================================
  // FREELANCE OPPORTUNITIES MODULE - Completely Separate Tables
  // =============================================================================

  // 16. Freelance Companies Table (isolated from job-application companies)
  db.exec(`
    CREATE TABLE IF NOT EXISTS freelance_companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      domain TEXT,
      official_website TEXT,
      shopify_store_url TEXT UNIQUE,
      city TEXT,
      state TEXT,
      country TEXT,
      store_name TEXT,
      store_description TEXT,
      installed_apps_json TEXT NOT NULL DEFAULT '[]',
      tech_stack_json TEXT NOT NULL DEFAULT '[]',
      product_count INTEGER,
      estimated_revenue TEXT,
      employee_count INTEGER,
      employee_count_min INTEGER,
      employee_count_max INTEGER,
      employee_size_range TEXT,
      employee_count_source TEXT,
      employee_count_source_url TEXT,
      employee_count_verified INTEGER DEFAULT 0,
      employee_count_verified_at TEXT,
      employee_count_status TEXT DEFAULT 'UNKNOWN',
      service_clarity_score INTEGER DEFAULT 0,
      portfolio_score INTEGER DEFAULT 0,
      tech_depth_score INTEGER DEFAULT 0,
      geographic_reach_score INTEGER DEFAULT 0,
      contact_accessibility_score INTEGER DEFAULT 0,
      responsiveness_score INTEGER DEFAULT 0,
      freelance_lead_score INTEGER DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'BRAVE_SEARCH',
      discovery_keywords TEXT,
      status TEXT DEFAULT 'DISCOVERED',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Create indexes for freelance_companies
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_freelance_companies_domain ON freelance_companies(domain);
      CREATE INDEX IF NOT EXISTS idx_freelance_companies_status ON freelance_companies(status);
      CREATE INDEX IF NOT EXISTS idx_freelance_companies_lead_score ON freelance_companies(freelance_lead_score);
      CREATE INDEX IF NOT EXISTS idx_freelance_companies_source ON freelance_companies(source);
      CREATE INDEX IF NOT EXISTS idx_freelance_companies_shopify_url ON freelance_companies(shopify_store_url);
      CREATE INDEX IF NOT EXISTS idx_freelance_companies_employee_status ON freelance_companies(employee_count_status);
    `);
  } catch (e) {
    // ignore
  }

  // 17. Freelance Contacts Table (separate from job-application contacts)
  db.exec(`
    CREATE TABLE IF NOT EXISTS freelance_contacts (
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
      phone TEXT,
      normalized_phone TEXT,
      phone_type TEXT,
      phone_source TEXT,
      phone_source_url TEXT,
      whatsapp_available TEXT DEFAULT 'unknown',
      whatsapp_status TEXT DEFAULT 'READY',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES freelance_companies(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_freelance_contacts_company_id ON freelance_contacts(company_id);
    CREATE INDEX IF NOT EXISTS idx_freelance_contacts_email ON freelance_contacts(email);
    CREATE INDEX IF NOT EXISTS idx_freelance_contacts_confidence ON freelance_contacts(confidence);
  `);

  // 18. Freelance Sources Table (evidence tracking)
  db.exec(`
    CREATE TABLE IF NOT EXISTS freelance_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      evidence TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES freelance_companies(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_freelance_sources_company ON freelance_sources(company_id);
  `);

  // 19. Freelance Exclusions Table (separate from job-application exclusions)
  db.exec(`
    CREATE TABLE IF NOT EXISTS freelance_exclusions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      domain TEXT,
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_freelance_exclusions_norm_name ON freelance_exclusions(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_freelance_exclusions_domain ON freelance_exclusions(domain);
  `);

  // 20. Freelance Email Logs Table (separate from job-application email_logs)
  db.exec(`
    CREATE TABLE IF NOT EXISTS freelance_email_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      contact_id INTEGER,
      email TEXT NOT NULL,
      subject TEXT,
      status TEXT NOT NULL,
      message_id TEXT,
      error TEXT,
      attempts INTEGER DEFAULT 1,
      sent_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES freelance_companies(id),
      FOREIGN KEY (contact_id) REFERENCES freelance_contacts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_freelance_email_logs_email ON freelance_email_logs(email);
    CREATE INDEX IF NOT EXISTS idx_freelance_email_logs_company ON freelance_email_logs(company_id);
    CREATE INDEX IF NOT EXISTS idx_freelance_email_logs_status ON freelance_email_logs(status);
  `);

  // 21. Freelance WhatsApp Logs Table (separate from job-application whatsapp_logs)
  db.exec(`
    CREATE TABLE IF NOT EXISTS freelance_whatsapp_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      contact_id INTEGER,
      phone TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      message_id TEXT,
      error TEXT,
      sent_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES freelance_companies(id),
      FOREIGN KEY (contact_id) REFERENCES freelance_contacts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_freelance_whatsapp_logs_phone ON freelance_whatsapp_logs(phone);
    CREATE INDEX IF NOT EXISTS idx_freelance_whatsapp_logs_company ON freelance_whatsapp_logs(company_id);
    CREATE INDEX IF NOT EXISTS idx_freelance_whatsapp_logs_status ON freelance_whatsapp_logs(status);
  `);

  // 22. Freelance Outreach Batches (resumable batch tracking, independent from job/merchant)
  db.exec(`
    CREATE TABLE IF NOT EXISTS freelance_outreach_batches (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'QUEUED',
      dry_run INTEGER NOT NULL DEFAULT 1,
      total INTEGER NOT NULL DEFAULT 0,
      sent INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      pending INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_freelance_batches_status ON freelance_outreach_batches(status);
  `);

  // 23. Freelance Outreach Items (per-lead state)
  db.exec(`
    CREATE TABLE IF NOT EXISTS freelance_outreach_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      company_id INTEGER NOT NULL,
      contact_id INTEGER,
      recipient TEXT,
      position INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      message_id TEXT,
      error TEXT,
      processed_at TEXT,
      UNIQUE(batch_id, company_id),
      FOREIGN KEY (batch_id) REFERENCES freelance_outreach_batches(id) ON DELETE CASCADE,
      FOREIGN KEY (company_id) REFERENCES freelance_companies(id) ON DELETE CASCADE,
      FOREIGN KEY (contact_id) REFERENCES freelance_contacts(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_freelance_items_batch_status ON freelance_outreach_items(batch_id, status);
    CREATE INDEX IF NOT EXISTS idx_freelance_items_batch_position ON freelance_outreach_items(batch_id, position);
  `);

  // 24. Freelance Outreach Rate Limit (independent from job/merchant)
  db.exec(`
    CREATE TABLE IF NOT EXISTS freelance_outreach_rate_limit (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      next_send_at INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO freelance_outreach_rate_limit (id, next_send_at) VALUES (1, 0);
  `);

  // 25. Freelance Lead Details (deep qualification evidence)
  db.exec(`
    CREATE TABLE IF NOT EXISTS freelance_lead_details (
      company_id INTEGER PRIMARY KEY,
      service_offerings_json TEXT NOT NULL DEFAULT '[]',
      portfolio_items_json TEXT NOT NULL DEFAULT '[]',
      client_testimonials_json TEXT NOT NULL DEFAULT '[]',
      service_gaps_json TEXT NOT NULL DEFAULT '[]',
      tech_stack_evidence_json TEXT NOT NULL DEFAULT '[]',
      geographic_evidence_json TEXT NOT NULL DEFAULT '[]',
      qualification_evidence_json TEXT NOT NULL DEFAULT '{}',
      outreach_personalization_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (company_id) REFERENCES freelance_companies(id) ON DELETE CASCADE
    );
  `);

}

module.exports = { runMigrations };
