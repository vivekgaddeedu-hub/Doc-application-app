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
  let status = 'sent';
  let bodyLog = html.replace(/<[^>]*>/g, '').trim().substring(0, 500); // Strip HTML tags for clean log preview

  if (transporter) {
    try {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || '"Doctor Consultation Support" <support@doctorapp.com>',
        to,
        subject,
        html
      });
      console.log(`[Email Sent] To: ${to} | Subject: ${subject}`);
    } catch (error) {
      console.error(`[Email Error] Failed to send to ${to}:`, error.message);
      status = 'failed';
    }
  } else {
    console.log(`\n--- [MOCK EMAIL SENT] ---`);
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body (Text): \n${html.replace(/<[^>]*>/g, '\n').split('\n').filter(l => l.trim()).join('\n')}`);
    console.log(`-------------------------\n`);
  }

  // Log notification to database
  try {
    await db.query(
      `INSERT INTO notifications_log (appointment_id, type, recipient, subject, body, status) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [appointmentId, 'email', to, subject, html, status]
    );
  } catch (err) {
    console.error('[DB Error] Failed to log notification:', err.message);
  }
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
