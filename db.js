const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

require('dotenv').config();

let dbType = 'sqlite';
let pgPool = null;
let sqliteDb = null;

const dbUrl = process.env.DATABASE_URL;

function initDb() {
  return new Promise((resolve, reject) => {
    if (dbUrl) {
      console.log('PostgreSQL DATABASE_URL found. Attempting connection...');
      pgPool = new Pool({
        connectionString: dbUrl,
        ssl: process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1') ? false : { rejectUnauthorized: false }
      });
      pgPool.query('SELECT NOW()', (err, res) => {
        if (err) {
          console.error('PostgreSQL connection failed! Error:', err.message);
          console.log('Falling back to local SQLite...');
          setupSQLite().then(resolve).catch(reject);
        } else {
          dbType = 'postgres';
          console.log('Successfully connected to PostgreSQL database.');
          setupSchema().then(resolve).catch(reject);
        }
      });
    } else {
      console.log('No DATABASE_URL configured. Using local SQLite database...');
      setupSQLite().then(resolve).catch(reject);
    }
  });
}

function setupSQLite() {
  return new Promise((resolve, reject) => {
    dbType = 'sqlite';
    const dbPath = path.join(__dirname, 'database.sqlite');
    sqliteDb = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('SQLite initialization failed:', err.message);
        return reject(err);
      }
      console.log(`SQLite database opened at: ${dbPath}`);
      setupSchema().then(resolve).catch(reject);
    });
  });
}

async function setupSchema() {
  if (dbType === 'postgres') {
    // Postgres Schema
    await query(`
      CREATE TABLE IF NOT EXISTS doctors (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        phone TEXT,
        specialization TEXT NOT NULL,
        fee NUMERIC NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS availabilities (
        id SERIAL PRIMARY KEY,
        doctor_id INTEGER REFERENCES doctors(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        working_hours TEXT NOT NULL,
        is_available BOOLEAN DEFAULT TRUE,
        UNIQUE(doctor_id, date)
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id TEXT PRIMARY KEY,
        doctor_id INTEGER REFERENCES doctors(id) ON DELETE SET NULL,
        patient_name TEXT NOT NULL,
        patient_phone TEXT NOT NULL,
        patient_email TEXT NOT NULL,
        health_issue TEXT NOT NULL,
        consultation_fee NUMERIC NOT NULL,
        payment_ref TEXT,
        payment_proof_path TEXT,
        status TEXT NOT NULL DEFAULT 'pending_payment',
        scheduled_date DATE,
        scheduled_time TEXT,
        meeting_link TEXT,
        rejection_reason TEXT,
        refund_status TEXT DEFAULT 'none',
        refund_amount NUMERIC,
        refund_date DATE,
        refund_ref TEXT,
        parent_appointment_id TEXT REFERENCES appointments(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS notifications_log (
        id SERIAL PRIMARY KEY,
        appointment_id TEXT,
        type TEXT NOT NULL,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'sent',
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } else {
    // SQLite Schema
    await query(`
      CREATE TABLE IF NOT EXISTS doctors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        phone TEXT,
        specialization TEXT NOT NULL,
        fee REAL NOT NULL,
        is_active INTEGER DEFAULT 1,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS availabilities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doctor_id INTEGER,
        date TEXT NOT NULL,
        working_hours TEXT NOT NULL,
        is_available INTEGER DEFAULT 1,
        UNIQUE(doctor_id, date),
        FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id TEXT PRIMARY KEY,
        doctor_id INTEGER,
        patient_name TEXT NOT NULL,
        patient_phone TEXT NOT NULL,
        patient_email TEXT NOT NULL,
        health_issue TEXT NOT NULL,
        consultation_fee REAL NOT NULL,
        payment_ref TEXT,
        payment_proof_path TEXT,
        status TEXT NOT NULL DEFAULT 'pending_payment',
        scheduled_date TEXT,
        scheduled_time TEXT,
        meeting_link TEXT,
        rejection_reason TEXT,
        refund_status TEXT DEFAULT 'none',
        refund_amount REAL,
        refund_date TEXT,
        refund_ref TEXT,
        parent_appointment_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE SET NULL,
        FOREIGN KEY (parent_appointment_id) REFERENCES appointments(id) ON DELETE SET NULL
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS notifications_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        appointment_id TEXT,
        type TEXT NOT NULL,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'sent',
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  // Seed default settings if they do not exist
  const qrSetting = await query(`SELECT value FROM system_settings WHERE key = $1`, ['payment_qr_code_url']);
  if (qrSetting.rows.length === 0) {
    await query(`INSERT INTO system_settings (key, value) VALUES ($1, $2)`, ['payment_qr_code_url', '/uploads/default_qr.png']);
  }

  const ownerSetting = await query(`SELECT value FROM system_settings WHERE key = $1`, ['owner_password_hash']);
  if (ownerSetting.rows.length === 0) {
    // Default owner password is "admin123" (using plain hash or bcrypt, we'll hash it inside server.js or here. Let's use bcrypt here)
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('admin123', 10);
    await query(`INSERT INTO system_settings (key, value) VALUES ($1, $2)`, ['owner_password_hash', hash]);
    await query(`INSERT INTO system_settings (key, value) VALUES ($1, $2)`, ['owner_email', 'admin@doctorapp.com']);
  }
}

function query(text, params = []) {
  return new Promise((resolve, reject) => {
    if (dbType === 'postgres') {
      pgPool.query(text, params, (err, res) => {
        if (err) return reject(err);
        resolve({
          rows: res.rows,
          rowCount: res.rowCount
        });
      });
    } else {
      // SQLite queries
      // Convert standard parameterized queries: SELECT * FROM t WHERE a = $1 AND b = $2
      // into SELECT * FROM t WHERE a = ? AND b = ?
      const sqliteText = text.replace(/\$[0-9]+/g, '?');
      
      const isSelect = sqliteText.trim().toUpperCase().startsWith('SELECT') || sqliteText.toUpperCase().includes('RETURNING');

      if (isSelect) {
        sqliteDb.all(sqliteText, params, (err, rows) => {
          if (err) return reject(err);
          resolve({
            rows: rows || [],
            rowCount: rows ? rows.length : 0
          });
        });
      } else {
        sqliteDb.run(sqliteText, params, function (err) {
          if (err) return reject(err);
          resolve({
            rows: [],
            rowCount: this.changes,
            lastID: this.lastID
          });
        });
      }
    }
  });
}

module.exports = {
  initDb,
  query,
  getDbType: () => dbType
};
