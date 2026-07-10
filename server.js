const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const xlsx = require('xlsx');
const db = require('./db');
const mail = require('./mail');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Dynamic directory check for uploads
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Serve public directory
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

// Multer storage for payment proof and settings images
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Temporary store for OTPs (In-memory, mapping appointmentId -> { otp, expires })
const otpStore = new Map();

// Helper Functions for base64 session tokens
function generateToken(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function verifyToken(token) {
  try {
    return JSON.parse(Buffer.from(token, 'base64').toString('ascii'));
  } catch (e) {
    return null;
  }
}

// Authentication Middlewares
function authenticateRole(role) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: Missing or invalid token format.' });
    }
    const token = authHeader.split(' ')[1];
    const user = verifyToken(token);
    if (!user || user.role !== role) {
      return res.status(403).json({ error: 'Forbidden: Insufficient privileges.' });
    }
    req.user = user;
    next();
  };
}

// --- UTILITIES ---
function generateMeetLink() {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  const part = (len) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `https://meet.google.com/${part(3)}-${part(4)}-${part(3)}`;
}

function generateAppointmentId() {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randStr = Math.floor(100000 + Math.random() * 900000);
  return `APT-${dateStr}-${randStr}`;
}

// --- AUTHENTICATION ROUTES ---
app.post('/api/auth/login', async (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password || !role) {
    return res.status(400).json({ error: 'Email, password, and role are required.' });
  }

  try {
    if (role === 'owner') {
      const ownerEmailRes = await db.query(`SELECT value FROM system_settings WHERE key = $1`, ['owner_email']);
      const ownerHashRes = await db.query(`SELECT value FROM system_settings WHERE key = $1`, ['owner_password_hash']);
      const ownerEmail = ownerEmailRes.rows[0]?.value;
      const ownerHash = ownerHashRes.rows[0]?.value;

      if (email === ownerEmail && bcrypt.compareSync(password, ownerHash)) {
        const token = generateToken({ email, role: 'owner' });
        return res.json({ token, user: { email, role: 'owner' } });
      }
    } else if (role === 'doctor') {
      const doctorRes = await db.query(`SELECT * FROM doctors WHERE email = $1`, [email]);
      if (doctorRes.rows.length > 0) {
        const doctor = doctorRes.rows[0];
        if (!doctor.is_active) {
          return res.status(403).json({ error: 'This doctor account is currently disabled.' });
        }
        if (bcrypt.compareSync(password, doctor.password_hash)) {
          const token = generateToken({ id: doctor.id, email: doctor.email, name: doctor.name, role: 'doctor' });
          return res.json({ token, user: { id: doctor.id, name: doctor.name, email: doctor.email, role: 'doctor' } });
        }
      }
    }
    return res.status(401).json({ error: 'Invalid credentials. Please verify and try again.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database authentication error.' });
  }
});

// --- DOCTORS CRUD (Owner Dashboard) ---
app.get('/api/owner/doctors', authenticateRole('owner'), async (req, res) => {
  try {
    const result = await db.query(`SELECT id, name, email, phone, specialization, fee, is_active, created_at FROM doctors ORDER BY name ASC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/owner/doctors', authenticateRole('owner'), async (req, res) => {
  const { name, email, phone, specialization, fee, password } = req.body;
  if (!name || !email || !specialization || !fee || !password) {
    return res.status(400).json({ error: 'Please provide all required fields, including password.' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = await db.query(
      `INSERT INTO doctors (name, email, phone, specialization, fee, password_hash) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email`,
      [name, email, phone, specialization, parseFloat(fee), hash]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.message.includes('unique constraint') || err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'A doctor account with this email already exists.' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/owner/doctors/:id', authenticateRole('owner'), async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, specialization, fee, is_active, password } = req.body;
  try {
    let result;
    const activeVal = is_active === undefined ? true : (is_active === 'true' || is_active === true || is_active === 1 || is_active === '1');
    const activeDb = db.getDbType() === 'postgres' ? activeVal : (activeVal ? 1 : 0);

    if (password && password.trim() !== '') {
      const hash = bcrypt.hashSync(password, 10);
      result = await db.query(
        `UPDATE doctors SET name = $1, email = $2, phone = $3, specialization = $4, fee = $5, is_active = $6, password_hash = $7 
         WHERE id = $8 RETURNING id`,
        [name, email, phone, specialization, parseFloat(fee), activeDb, hash, parseInt(id)]
      );
    } else {
      result = await db.query(
        `UPDATE doctors SET name = $1, email = $2, phone = $3, specialization = $4, fee = $5, is_active = $6 
         WHERE id = $7 RETURNING id`,
        [name, email, phone, specialization, parseFloat(fee), activeDb, parseInt(id)]
      );
    }
    if (result.rowCount === 0) return res.status(404).json({ error: 'Doctor not found.' });
    res.json({ message: 'Doctor updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SYSTEM SETTINGS ---
app.get('/api/system/settings', async (req, res) => {
  try {
    const qrUrl = await db.query(`SELECT value FROM system_settings WHERE key = $1`, ['payment_qr_code_url']);
    res.json({ payment_qr_code_url: qrUrl.rows[0]?.value || '/uploads/default_qr.png' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/owner/settings/qr', authenticateRole('owner'), upload.single('qr_code'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No QR Code image was selected.' });
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  try {
    await db.query(`INSERT INTO system_settings (key, value) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, ['payment_qr_code_url', fileUrl]);
    // For SQLite, standard INSERT OR REPLACE handles key UNIQUE conflict. Our query parser handles standard $ placeholders
    if (db.getDbType() === 'sqlite') {
      await db.query(`INSERT OR REPLACE INTO system_settings (key, value) VALUES ($1, $2)`, ['payment_qr_code_url', fileUrl]);
    }
    res.json({ message: 'QR Code updated successfully.', url: fileUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- PATIENT BOOKING APIS ---
app.get('/api/public/doctors', async (req, res) => {
  try {
    // Return list of active doctors only
    const activeDb = db.getDbType() === 'postgres' ? true : 1;
    const result = await db.query(`SELECT id, name, specialization, fee FROM doctors WHERE is_active = $1 ORDER BY specialization, name`, [activeDb]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/public/appointments/book', upload.single('payment_proof'), async (req, res) => {
  const { doctor_id, patient_name, patient_phone, patient_email, health_issue, payment_ref } = req.body;
  if (!doctor_id || !patient_name || !patient_phone || !patient_email || !health_issue || !payment_ref || !req.file) {
    return res.status(400).json({ error: 'All fields and payment proof image are required.' });
  }

  try {
    // Verify doctor exists and active, retrieve fee
    const docRes = await db.query(`SELECT name, fee, email, phone FROM doctors WHERE id = $1`, [parseInt(doctor_id)]);
    if (docRes.rows.length === 0) {
      return res.status(404).json({ error: 'Doctor not found or inactive.' });
    }
    const doctor = docRes.rows[0];
    const fee = doctor.fee;
    const apptId = generateAppointmentId();
    const proofPath = `/uploads/${req.file.filename}`;

    await db.query(
      `INSERT INTO appointments (id, doctor_id, patient_name, patient_phone, patient_email, health_issue, consultation_fee, payment_ref, payment_proof_path, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [apptId, parseInt(doctor_id), patient_name, patient_phone, patient_email, health_issue, fee, payment_ref, proofPath, 'pending_approval']
    );

    // Notify Patient via WhatsApp
    await mail.sendWhatsApp({
      to: patient_phone,
      message: `Dear ${patient_name}, your consultation request for Dr. ${doctor.name} has been received. ID: ${apptId}. Consultation fee: $${fee}. Ref: ${payment_ref}. You can track status directly at the patient portal.`,
      appointmentId: apptId
    });

    // Notify Doctor via WhatsApp
    if (doctor.phone) {
      await mail.sendWhatsApp({
        to: doctor.phone,
        message: `Hello Dr. ${doctor.name}, you have a new appointment request (ID: ${apptId}) from patient ${patient_name} awaiting review on your portal dashboard.`,
        appointmentId: apptId
      });
    }

    res.status(201).json({ success: true, appointmentId: apptId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- PUBLIC STATUS CHECK (DIRECT LOOKUP BY ID) ---
app.get('/api/public/appointments/:id/status', async (req, res) => {
  const { id } = req.params;

  try {
    const queryStr = `
      SELECT a.*, d.name as doctor_name, d.specialization as doctor_specialization, d.phone as doctor_phone
      FROM appointments a
      LEFT JOIN doctors d ON a.doctor_id = d.id
      WHERE a.id = $1
    `;
    const result = await db.query(queryStr, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Appointment not found.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- DOCTOR INTERFACE APIS ---
app.get('/api/doctor/appointments', authenticateRole('doctor'), async (req, res) => {
  const docId = req.user.id;
  try {
    const result = await db.query(
      `SELECT * FROM appointments WHERE doctor_id = $1 ORDER BY created_at DESC`,
      [docId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/doctor/availability', authenticateRole('doctor'), async (req, res) => {
  const docId = req.user.id;
  try {
    const result = await db.query(`SELECT * FROM availabilities WHERE doctor_id = $1 ORDER BY date ASC`, [docId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/doctor/availability', authenticateRole('doctor'), async (req, res) => {
  const docId = req.user.id;
  const { date, working_hours, is_available } = req.body;
  if (!date || !working_hours) {
    return res.status(400).json({ error: 'Date and working hours are required.' });
  }

  const availVal = is_available === undefined ? true : (is_available === 'true' || is_available === true || is_available === 1 || is_available === '1');
  const availDb = db.getDbType() === 'postgres' ? availVal : (availVal ? 1 : 0);

  try {
    if (db.getDbType() === 'postgres') {
      await db.query(
        `INSERT INTO availabilities (doctor_id, date, working_hours, is_available) 
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (doctor_id, date) 
         DO UPDATE SET working_hours = EXCLUDED.working_hours, is_available = EXCLUDED.is_available`,
        [docId, date, working_hours, availDb]
      );
    } else {
      // SQLite INSERT OR REPLACE
      await db.query(
        `INSERT OR REPLACE INTO availabilities (doctor_id, date, working_hours, is_available) 
         VALUES ($1, $2, $3, $4)`,
        [docId, date, working_hours, availDb]
      );
    }
    res.json({ message: 'Availability updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/doctor/appointments/:id/accept', authenticateRole('doctor'), async (req, res) => {
  const { id } = req.params;
  const { scheduled_date, scheduled_time } = req.body;
  if (!scheduled_date || !scheduled_time) {
    return res.status(400).json({ error: 'Appointment date and time are required.' });
  }

  try {
    const meetLink = generateMeetLink();
    const result = await db.query(
      `UPDATE appointments SET status = 'scheduled', scheduled_date = $1, scheduled_time = $2, meeting_link = $3 
       WHERE id = $4 AND doctor_id = $5 RETURNING *`,
      [scheduled_date, scheduled_time, meetLink, id, req.user.id]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'Appointment not found or not assigned to you.' });

    const appt = result.rows[0];

    // Notification emails & WhatsApp
    const clientMail = appt.patient_email;
    const clientSubject = `Appointment Confirmed - ${appt.id}`;
    const clientBody = `
      <h3>Dear ${appt.patient_name},</h3>
      <p>Your appointment with Dr. ${req.user.name} has been confirmed.</p>
      <p><strong>Scheduled Date:</strong> ${scheduled_date}</p>
      <p><strong>Scheduled Time:</strong> ${scheduled_time}</p>
      <p><strong>Google Meet Link:</strong> <a href="${meetLink}">${meetLink}</a></p>
      <p>Please log in to the status page of our application to review your appointment details at any time.</p>
      <br>
      <p>Regards,<br>Online Consultation Support</p>
    `;

    const docSubject = `Appointment Scheduled - ${appt.id}`;
    const docBody = `
      <h3>Hello Dr. ${req.user.name},</h3>
      <p>You have scheduled the consultation for appointment: <strong>${appt.id}</strong>.</p>
      <p><strong>Patient Name:</strong> ${appt.patient_name}</p>
      <p><strong>Date & Time:</strong> ${scheduled_date} at ${scheduled_time}</p>
      <p><strong>Google Meet Link:</strong> <a href="${meetLink}">${meetLink}</a></p>
    `;

    await mail.sendWhatsApp({
      to: appt.patient_phone,
      message: `Your appointment is confirmed with Dr. ${req.user.name} on ${scheduled_date} at ${scheduled_time}. Meet: ${meetLink}`,
      appointmentId: appt.id
    });

    res.json({ message: 'Appointment approved and meeting details configured.', appointment: appt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/doctor/appointments/:id/reject', authenticateRole('doctor'), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  if (!reason || reason.trim() === '') {
    return res.status(400).json({ error: 'A rejection reason is required.' });
  }

  try {
    const result = await db.query(
      `UPDATE appointments SET status = 'rejected', rejection_reason = $1, refund_status = 'pending' 
       WHERE id = $2 AND doctor_id = $3 RETURNING *`,
      [reason, id, req.user.id]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'Appointment not found or not assigned to you.' });

    const appt = result.rows[0];

    // Notification emails
    const clientMail = appt.patient_email;
    const clientSubject = `Appointment Update - ${appt.id}`;
    const clientBody = `
      <h3>Dear ${appt.patient_name},</h3>
      <p>We regret to inform you that your appointment request with Dr. ${req.user.name} has been rejected.</p>
      <p><strong>Reason:</strong> ${reason}</p>
      <p><strong>Refund Status:</strong> Pending (A full refund of $${appt.consultation_fee} is being processed manually).</p>
      <br>
      <p>We will update you as soon as the refund transaction reference is logged.</p>
    `;

    await mail.sendWhatsApp({
      to: appt.patient_phone,
      message: `Your appointment ${appt.id} was rejected: ${reason}. Refund is pending.`,
      appointmentId: appt.id
    });

    res.json({ message: 'Appointment rejected. Refund is now flagged as pending.', appointment: appt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/doctor/appointments/:id/complete', authenticateRole('doctor'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `UPDATE appointments SET status = 'completed' WHERE id = $1 AND doctor_id = $2 RETURNING *`,
      [id, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Appointment not found.' });
    res.json({ message: 'Consultation marked as completed.', appointment: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/doctor/appointments/:id/refund', authenticateRole('doctor'), async (req, res) => {
  const { id } = req.params;
  const { refund_amount, refund_date, refund_ref } = req.body;
  if (!refund_amount || !refund_date || !refund_ref) {
    return res.status(400).json({ error: 'Refund amount, refund date, and transaction reference are required.' });
  }

  try {
    const result = await db.query(
      `UPDATE appointments SET refund_status = 'refunded', refund_amount = $1, refund_date = $2, refund_ref = $3 
       WHERE id = $4 RETURNING *`,
      [parseFloat(refund_amount), refund_date, refund_ref, id]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'Appointment not found.' });

    const appt = result.rows[0];

    // Notification emails
    const clientMail = appt.patient_email;
    const clientSubject = `Refund Confirmed - ${appt.id}`;
    const clientBody = `
      <h3>Dear ${appt.patient_name},</h3>
      <p>This is to confirm that a refund of $${refund_amount} has been processed for your consultation request.</p>
      <p><strong>Refund Date:</strong> ${refund_date}</p>
      <p><strong>Refund Transaction Ref:</strong> ${refund_ref}</p>
      <br>
      <p>We appreciate your patience. Please reach out to us if you have any questions.</p>
    `;

    await mail.sendWhatsApp({
      to: appt.patient_phone,
      message: `Refund of $${refund_amount} processed for appointment ${appt.id}. Ref: ${refund_ref}`,
      appointmentId: appt.id
    });

    res.json({ message: 'Refund logged successfully.', appointment: appt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/doctor/appointments/:id/followup', authenticateRole('doctor'), async (req, res) => {
  const { id } = req.params;
  const { scheduled_date, scheduled_time } = req.body;

  if (!scheduled_date || !scheduled_time) {
    return res.status(400).json({ error: 'Date and time are required for scheduling follow-up.' });
  }

  try {
    // Verify original appointment
    const origRes = await db.query(`SELECT * FROM appointments WHERE id = $1 AND doctor_id = $2`, [id, req.user.id]);
    if (origRes.rows.length === 0) {
      return res.status(404).json({ error: 'Original appointment not found or not assigned to you.' });
    }
    const orig = origRes.rows[0];

    const newApptId = generateAppointmentId();
    const newMeetLink = generateMeetLink();

    // Create follow-up appointment in database (already pre-approved/scheduled)
    await db.query(
      `INSERT INTO appointments (id, doctor_id, patient_name, patient_phone, patient_email, health_issue, consultation_fee, status, scheduled_date, scheduled_time, meeting_link, parent_appointment_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        newApptId,
        orig.doctor_id,
        orig.patient_name,
        orig.patient_phone,
        orig.patient_email,
        `Follow-up consultation for: ${orig.health_issue}`,
        0, // follow-ups are free, or doctor fee. We'll set it to 0 as standard follow-up
        'scheduled',
        scheduled_date,
        scheduled_time,
        newMeetLink,
        orig.id
      ]
    );

    // Send notifications
    const clientSubject = `Follow-up Appointment Scheduled - ${newApptId}`;
    const clientBody = `
      <h3>Dear ${orig.patient_name},</h3>
      <p>A follow-up consultation has been scheduled with Dr. ${req.user.name}.</p>
      <p><strong>New Appointment ID:</strong> ${newApptId}</p>
      <p><strong>Scheduled Date:</strong> ${scheduled_date}</p>
      <p><strong>Scheduled Time:</strong> ${scheduled_time}</p>
      <p><strong>Google Meet Link:</strong> <a href="${newMeetLink}">${newMeetLink}</a></p>
      <p>This is linked to your previous consultation history (ID: ${orig.id}).</p>
    `;

    await mail.sendWhatsApp({
      to: orig.patient_phone,
      message: `Follow-up consultation is scheduled with Dr. ${req.user.name} on ${scheduled_date} at ${scheduled_time}. Meet: ${newMeetLink}`,
      appointmentId: newApptId
    });

    res.status(201).json({ message: 'Follow-up appointment scheduled successfully.', appointmentId: newApptId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- OWNER ADMINISTRATIVE APIS ---
app.get('/api/owner/dashboard', authenticateRole('owner'), async (req, res) => {
  try {
    const doctorsCount = await db.query(`SELECT COUNT(*) as count FROM doctors`);
    const totalAppointments = await db.query(`SELECT COUNT(*) as count FROM appointments`);
    const activeAppointments = await db.query(`SELECT COUNT(*) as count FROM appointments WHERE status = 'scheduled'`);
    const pendingAppointments = await db.query(`SELECT COUNT(*) as count FROM appointments WHERE status = 'pending_approval'`);
    const rejectedAppointments = await db.query(`SELECT COUNT(*) as count FROM appointments WHERE status = 'rejected'`);
    const completedAppointments = await db.query(`SELECT COUNT(*) as count FROM appointments WHERE status = 'completed'`);
    
    // Revenue calculations (consultation fees from accepted/scheduled/completed appointments)
    const revenueRes = await db.query(
      `SELECT SUM(consultation_fee) as sum FROM appointments WHERE status IN ('scheduled', 'completed')`
    );
    // Refund calculations
    const refundsRes = await db.query(
      `SELECT SUM(refund_amount) as sum FROM appointments WHERE refund_status = 'refunded'`
    );

    // List recent appointments
    const recentRes = await db.query(`
      SELECT a.*, d.name as doctor_name 
      FROM appointments a
      LEFT JOIN doctors d ON a.doctor_id = d.id
      ORDER BY a.created_at DESC LIMIT 10
    `);

    // Notifications logs
    const notificationLogs = await db.query(`SELECT * FROM notifications_log ORDER BY sent_at DESC LIMIT 10`);

    res.json({
      doctors: parseInt(doctorsCount.rows[0]?.count || 0),
      appointments: parseInt(totalAppointments.rows[0]?.count || 0),
      scheduled: parseInt(activeAppointments.rows[0]?.count || 0),
      pending: parseInt(pendingAppointments.rows[0]?.count || 0),
      rejected: parseInt(rejectedAppointments.rows[0]?.count || 0),
      completed: parseInt(completedAppointments.rows[0]?.count || 0),
      revenue: parseFloat(revenueRes.rows[0]?.sum || 0),
      refunds: parseFloat(refundsRes.rows[0]?.sum || 0),
      recentAppointments: recentRes.rows,
      notificationLogs: notificationLogs.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Excel Report Generation
app.get('/api/reports/download', authenticateRole('owner'), async (req, res) => {
  try {
    const appointmentsRes = await db.query(`
      SELECT a.id as "Appointment ID", d.name as "Doctor", a.patient_name as "Patient Name", 
             a.patient_email as "Patient Email", a.patient_phone as "Patient Phone", 
             a.health_issue as "Health Issue", a.consultation_fee as "Fee", a.status as "Status", 
             a.scheduled_date as "Scheduled Date", a.scheduled_time as "Scheduled Time", 
             a.payment_ref as "Payment Ref", a.refund_status as "Refund Status", 
             a.refund_amount as "Refund Amount", a.refund_ref as "Refund Ref", 
             a.created_at as "Created At"
      FROM appointments a
      LEFT JOIN doctors d ON a.doctor_id = d.id
      ORDER BY a.created_at DESC
    `);

    const doctorsRes = await db.query(`
      SELECT name as "Doctor Name", email as "Email", phone as "Phone", 
             specialization as "Specialization", fee as "Consultation Fee", 
             is_active,
             created_at as "Created At"
      FROM doctors
      ORDER BY name ASC
    `);

    // Create a new workbook and add sheets
    const wb = xlsx.utils.book_new();

    const wsAppointments = xlsx.utils.json_to_sheet(appointmentsRes.rows);
    xlsx.utils.book_append_sheet(wb, wsAppointments, 'Appointments');

    // Format doctor active status in JavaScript to be database agnostic
    const formattedDoctors = doctorsRes.rows.map(doc => {
      const { is_active, ...rest } = doc;
      return {
        ...rest,
        "Status": (is_active === true || is_active === 1 || is_active === '1' || is_active === 'true') ? 'Active' : 'Disabled'
      };
    });

    const wsDoctors = xlsx.utils.json_to_sheet(formattedDoctors);
    xlsx.utils.book_append_sheet(wb, wsDoctors, 'Doctors');

    // Write to a buffer and serve
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="appointment_report.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Excel Report generation error: ' + err.message });
  }
});

// --- DAILY AVAILABILITY REMINDER SCRIPT & TRIGGERS ---
async function sendDailyAvailabilityReminders() {
  console.log('[Scheduler] Executing daily availability reminders...');
  try {
    const activeDb = db.getDbType() === 'postgres' ? true : 1;
    const result = await db.query(`SELECT id, name, email, phone FROM doctors WHERE is_active = $1`, [activeDb]);
    const activeDoctors = result.rows;

    for (const doc of activeDoctors) {
      if (doc.phone) {
        await mail.sendWhatsApp({
          to: doc.phone,
          message: `Good Morning Dr. ${doc.name}, this is your daily 6:00 AM reminder to update your availability and working hours for today on the doctor portal.`
        });
      }
    }
    console.log(`[Scheduler] Availability reminders dispatched successfully to ${activeDoctors.length} doctors.`);
    return activeDoctors.length;
  } catch (err) {
    console.error('[Scheduler Error] Failed to send availability reminders:', err.message);
    throw err;
  }
}

app.post('/api/owner/trigger-reminders', authenticateRole('owner'), async (req, res) => {
  try {
    const count = await sendDailyAvailabilityReminders();
    res.json({ success: true, message: `Manually triggered daily availability reminders. Email dispatched to ${count} doctors.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- RUN SPLAY/INTERVAL CHECK FOR 6:00 AM DISPATCH ---
let lastReminderDate = '';
setInterval(() => {
  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0]; // HH:MM:SS
  const currentDate = now.toISOString().slice(0, 10); // YYYY-MM-DD

  // Check if current hour is 6:00 AM
  if (now.getHours() === 6 && now.getMinutes() === 0 && lastReminderDate !== currentDate) {
    lastReminderDate = currentDate;
    sendDailyAvailabilityReminders().catch(err => console.error(err));
  }
}, 60000); // Checks every minute

// Start server
db.initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`===========================================================`);
    console.log(`Doctor Appointment Web App running on http://localhost:${PORT}`);
    console.log(`Database Type: ${db.getDbType().toUpperCase()}`);
    console.log(`===========================================================`);
  });
}).catch(err => {
  console.error('Fatal database start-up error:', err.message);
  process.exit(1);
});
