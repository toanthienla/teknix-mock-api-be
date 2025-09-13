// scripts/run-migrations.js
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const db = require('../src/config/db');

async function run() {
  try {
    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      console.log('Running migration:', file);
      await db.query(sql);
    }

    console.log('✅ All migrations completed successfully');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

run();
