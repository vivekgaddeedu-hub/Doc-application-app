const nodemailer = require('nodemailer');
const db = require('./db');

require('dotenv').config();

// Create SMTP Transporter if credentials exist
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

/**
 * Sends an email notification.
 * Falls back to mock logging if SMTP settings are not provided.
 */
async function sendEmail({ to, subject, html, appointmentId = null }) {
  // Email notification system has been disabled. Only WhatsApp is active.
}

/**
 * Sends a WhatsApp notification (mock implementation).
 */
async function sendWhatsApp({ to, message, appointmentId = null }) {
  console.log(`\n--- [MOCK WHATSAPP SENT] ---`);
  console.log(`To: ${to}`);
  console.log(`Message: ${message}`);
  console.log(`----------------------------\n`);

  try {
    await db.query(
      `INSERT INTO notifications_log (appointment_id, type, recipient, subject, body, status) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [appointmentId, 'whatsapp', to, 'WhatsApp Notification', message, 'sent']
    );
  } catch (err) {
    console.error('[DB Error] Failed to log WhatsApp notification:', err.message);
  }
}

module.exports = {
  sendEmail,
  sendWhatsApp
};
