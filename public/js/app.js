/**
 * Doctor Appointment Web Application - App Client Logic
 * Handles interactive tabs, AJAX calls, form submissions, and authentication.
 */

const API_BASE = ''; // Same domain

// --- COMMON STORAGE HELPERS ---
const Storage = {
  getToken: () => localStorage.getItem('token'),
  setToken: (token) => localStorage.setItem('token', token),
  clearToken: () => localStorage.removeItem('token'),
  getUser: () => {
    const user = localStorage.getItem('user');
    return user ? JSON.parse(user) : null;
  },
  setUser: (user) => localStorage.setItem('user', JSON.stringify(user)),
  clearUser: () => localStorage.removeItem('user')
};

// --- BASE API FETCH ENGINE ---
async function apiCall(endpoint, method = 'GET', data = null, isMultipart = false) {
  const token = Storage.getToken();
  const headers = {};
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let body = data;
  if (data && !isMultipart) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(data);
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers,
    body
  });

  if (!response.ok) {
    const errText = await response.text();
    let errMsg = 'Something went wrong';
    try {
      const errJson = JSON.parse(errText);
      errMsg = errJson.error || errMsg;
    } catch(e) {
      errMsg = errText || errMsg;
    }
    throw new Error(errMsg);
  }

  if (response.headers.get('Content-Type')?.includes('application/json')) {
    return await response.json();
  }
  return response;
}

// --- HELPER FORMATTERS ---
function formatDate(dateStr) {
  if (!dateStr) return 'N/A';
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(dtStr) {
  if (!dtStr) return 'N/A';
  const d = new Date(dtStr);
  return d.toLocaleString();
}

function getStatusBadge(status) {
  switch (status) {
    case 'pending_approval':
      return `<span class="badge badge-pending">Pending Review</span>`;
    case 'scheduled':
      return `<span class="badge badge-scheduled">Scheduled</span>`;
    case 'completed':
      return `<span class="badge badge-completed">Completed</span>`;
    case 'rejected':
      return `<span class="badge badge-rejected">Rejected</span>`;
    default:
      return `<span class="badge badge-pending">${status}</span>`;
  }
}

function showToast(message, type = 'success') {
  // Simple toast creator
  const id = 'toast-' + Math.random().toString(36).substring(2, 9);
  const toast = document.createElement('div');
  toast.className = `alert alert-${type === 'error' ? 'error' : 'success'} toast-item`;
  toast.id = id;
  toast.style.position = 'fixed';
  toast.style.bottom = '20px';
  toast.style.right = '20px';
  toast.style.zIndex = '9999';
  toast.style.boxShadow = '0 10px 30px rgba(0,0,0,0.5)';
  toast.style.minWidth = '250px';
  toast.style.margin = '0';
  toast.style.animation = 'modalEnter 0.2s cubic-bezier(0.4, 0, 0.2, 1)';
  toast.innerHTML = `
    <span>${message}</span>
  `;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 4000);
}

// --- MODAL UTILITIES ---
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.add('active');
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.remove('active');
}

// --- PORTAL INITIALIZATION ROUTER ---
document.addEventListener('DOMContentLoaded', () => {
  const path = window.location.pathname;

  // Global modals closer
  document.querySelectorAll('.modal-close, .btn-close-modal').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal');
      if (modal) modal.classList.remove('active');
    });
  });

  if (path.includes('doctor.html')) {
    initDoctorPortal();
  } else if (path.includes('owner.html')) {
    initOwnerPortal();
  } else {
    initPatientPortal();
  }
});

// ==========================================
// 1. PATIENT PORTAL FUNCTIONS
// ==========================================
async function initPatientPortal() {
  const doctorSelect = document.getElementById('doctor_id');
  const feeDisplay = document.getElementById('fee-display');
  const qrImage = document.getElementById('payment-qr-image');
  const bookingForm = document.getElementById('booking-form');
  const viewStatusBtn = document.getElementById('view-status-btn');
  const checkStatusForm = document.getElementById('check-status-form');
  const otpSection = document.getElementById('otp-section');
  const otpForm = document.getElementById('otp-form');
  const statusDetailsSection = document.getElementById('status-details-section');

  // Load Active QR Code URL
  try {
    const settings = await apiCall('/api/system/settings');
    if (qrImage && settings.payment_qr_code_url) {
      qrImage.src = settings.payment_qr_code_url;
    }
  } catch (err) {
    console.error('Failed to load QR code settings:', err);
  }

  // Load Doctors
  if (doctorSelect) {
    try {
      const doctors = await apiCall('/api/public/doctors');
      doctorSelect.innerHTML = '<option value="" disabled selected>Choose Specialization & Doctor</option>';
      
      // Group by specialization
      const grouped = {};
      doctors.forEach(d => {
        if (!grouped[d.specialization]) grouped[d.specialization] = [];
        grouped[d.specialization].push(d);
      });

      for (const spec in grouped) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = spec;
        grouped[spec].forEach(doc => {
          const opt = document.createElement('option');
          opt.value = doc.id;
          opt.dataset.fee = doc.fee;
          opt.textContent = `Dr. ${doc.name} (Fee: $${doc.fee})`;
          optgroup.appendChild(opt);
        });
        doctorSelect.appendChild(optgroup);
      }
    } catch (err) {
      showToast('Error loading active doctors: ' + err.message, 'error');
    }

    doctorSelect.addEventListener('change', () => {
      const selected = doctorSelect.options[doctorSelect.selectedIndex];
      const fee = selected.dataset.fee;
      if (feeDisplay) {
        feeDisplay.textContent = `Consultation Fee: $${fee}`;
        feeDisplay.style.display = 'block';
      }
    });
  }

  // Helper to compress images on mobile client before uploading
  function compressImage(file, maxWidth = 1024, quality = 0.8) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = (event) => {
        const img = new Image();
        img.src = event.target.result;
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;

          if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          }

          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          canvas.toBlob(
            (blob) => {
              if (blob) {
                resolve(blob);
              } else {
                reject(new Error('Canvas toBlob failed'));
              }
            },
            file.type || 'image/jpeg',
            quality
          );
        };
        img.onerror = (err) => reject(err);
      };
      reader.onerror = (err) => reject(err);
    });
  }

  // Submit Booking Form
  if (bookingForm) {
    bookingForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = bookingForm.querySelector('button[type="submit"]');
      const originalText = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<div class="loading-spinner"></div> Booking...';

      const formData = new FormData(bookingForm);

      // Compress image payment proof if uploaded from mobile to avoid EPIPE/fetch limits
      const paymentProofFile = formData.get('payment_proof');
      if (paymentProofFile && paymentProofFile.type.startsWith('image/')) {
        try {
          submitBtn.innerHTML = '<div class="loading-spinner"></div> Optimizing image...';
          const compressedBlob = await compressImage(paymentProofFile, 1024, 0.8);
          // Replace file in Form Data
          formData.set('payment_proof', compressedBlob, paymentProofFile.name || 'proof.jpg');
        } catch (compressErr) {
          console.warn('Image compression failed, using original file:', compressErr);
        }
      }

      try {
        submitBtn.innerHTML = '<div class="loading-spinner"></div> Uploading details...';
        const response = await fetch('/api/public/appointments/book', {
          method: 'POST',
          body: formData
        });

        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Failed to submit appointment');

        // Success dialog
        openModal('booking-success-modal');
        document.getElementById('success-appt-id').textContent = result.appointmentId;
        bookingForm.reset();
        if (feeDisplay) feeDisplay.style.display = 'none';
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
      }
    });
  }

  // Check Status Direct Search Form
  if (checkStatusForm) {
    checkStatusForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const apptId = document.getElementById('status-appt-id').value.trim();
      const submitBtn = checkStatusForm.querySelector('button[type="submit"]');
      if (!apptId) return;

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<div class="loading-spinner"></div> Searching...';

      try {
        await loadAppointmentStatusDetails(apptId);
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Verify Appointment ID';
      }
    });
  }
}

async function loadAppointmentStatusDetails(apptId) {
  const statusDetailsSection = document.getElementById('status-details-section');
  const checkStatusFormContainer = document.getElementById('check-status-form-container');

  try {
    const res = await fetch(`/api/public/appointments/${apptId}/status`);
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error('Appointment ID not found. Please verify the ID and try again.');
      }
      throw new Error('Failed to retrieve appointment status');
    }
    
    const appt = await res.json();
    if (checkStatusFormContainer) checkStatusFormContainer.style.display = 'none';
    statusDetailsSection.style.display = 'block';

    let scheduleSectionHtml = '';
    if (appt.status === 'scheduled' || appt.status === 'completed') {
      scheduleSectionHtml = `
        <div class="alert alert-success mt-2">
          <div>
            <strong>Confirmed Appointment Details:</strong><br>
            Date: ${formatDate(appt.scheduled_date)} <br>
            Time Slot: ${appt.scheduled_time} <br>
            Google Meet Link: <a href="${appt.meeting_link}" target="_blank" style="text-decoration: underline; color: white;"><strong>Join Meeting Link</strong></a>
          </div>
        </div>
      `;
    } else if (appt.status === 'rejected') {
      scheduleSectionHtml = `
        <div class="alert alert-error mt-2">
          <div>
            <strong>Consultation Rejected:</strong><br>
            Reason: "${appt.rejection_reason || 'No reason provided'}" <br>
            <strong>Refund Information:</strong><br>
            Refund Status: <span class="badge ${appt.refund_status === 'refunded' ? 'badge-completed' : 'badge-pending'}">${appt.refund_status.toUpperCase()}</span><br>
            ${appt.refund_status === 'refunded' ? `
              Amount: $${appt.refund_amount} <br>
              Date: ${formatDate(appt.refund_date)} <br>
              Reference: ${appt.refund_ref}
            ` : 'A refund of the consultation fee is currently being processed manually by our team.'}
          </div>
        </div>
      `;
    } else {
      scheduleSectionHtml = `
        <div class="alert alert-warning mt-2">
          Your payment proof is currently being reviewed. Once approved, the doctor will confirm your consultation date & time.
        </div>
      `;
    }

    statusDetailsSection.innerHTML = `
      <h3 class="mb-2">Appointment Details</h3>
      <div style="display: flex; flex-direction: column; gap: 0.75rem;">
        <p><strong>Appointment ID:</strong> ${appt.id}</p>
        <p><strong>Consultation Status:</strong> ${getStatusBadge(appt.status)}</p>
        <p><strong>Patient Name:</strong> ${appt.patient_name}</p>
        <p><strong>Contact Email:</strong> ${appt.patient_email}</p>
        <p><strong>Registered Doctor:</strong> Dr. ${appt.doctor_name || 'N/A'} (${appt.doctor_specialization || 'N/A'})</p>
        <p><strong>Paid Consultation Fee:</strong> $${appt.consultation_fee}</p>
        <p><strong>Payment reference ID:</strong> ${appt.payment_ref}</p>
        <p><strong>Health issue reported:</strong> "${appt.health_issue}"</p>
        ${scheduleSectionHtml}
      </div>
      <button class="btn btn-secondary mt-3 w-full" onclick="window.location.reload()">Check Another Status</button>
    `;

  } catch (err) {
    showToast(err.message, 'error');
    throw err;
  }
}

// ==========================================
// 2. DOCTOR PORTAL FUNCTIONS
// ==========================================
async function initDoctorPortal() {
  const loginForm = document.getElementById('doctor-login-form');
  const portalSection = document.getElementById('doctor-portal-section');
  const loginSection = document.getElementById('doctor-login-section');
  const logoutBtn = document.getElementById('doctor-logout-btn');

  // Verify stored session
  const token = Storage.getToken();
  const user = Storage.getUser();

  if (token && user && user.role === 'doctor') {
    loginSection.style.display = 'none';
    portalSection.style.display = 'block';
    document.getElementById('doctor-name-display').textContent = user.name;
    loadDoctorDashboard();
  } else {
    loginSection.style.display = 'block';
    portalSection.style.display = 'none';
  }

  // Handle login
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('doc-email').value.trim();
      const password = document.getElementById('doc-password').value;
      const submitBtn = loginForm.querySelector('button[type="submit"]');

      submitBtn.disabled = true;
      submitBtn.innerHTML = 'Signing in...';

      try {
        const res = await apiCall('/api/auth/login', 'POST', { email, password, role: 'doctor' });
        Storage.setToken(res.token);
        Storage.setUser(res.user);
        
        loginSection.style.display = 'none';
        portalSection.style.display = 'block';
        document.getElementById('doctor-name-display').textContent = res.user.name;
        
        showToast('Login Successful!');
        loadDoctorDashboard();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Sign In';
      }
    });
  }

  // Handle Logout
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      Storage.clearToken();
      Storage.clearUser();
      window.location.reload();
    });
  }

  // Handle Availability Settings Form
  const availForm = document.getElementById('avail-form');
  if (availForm) {
    availForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const date = document.getElementById('avail-date').value;
      const working_hours = document.getElementById('avail-hours').value.trim();
      const is_available = document.getElementById('avail-status').value === '1';
      const submitBtn = availForm.querySelector('button[type="submit"]');

      submitBtn.disabled = true;

      try {
        await apiCall('/api/doctor/availability', 'POST', { date, working_hours, is_available });
        showToast('Availability settings updated.');
        loadDoctorAvailability();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  // Forms in Modals
  const acceptForm = document.getElementById('accept-appt-form');
  if (acceptForm) {
    acceptForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('accept-appt-id').value;
      const date = document.getElementById('accept-date').value;
      const time = document.getElementById('accept-time').value;

      try {
        await apiCall(`/api/doctor/appointments/${id}/accept`, 'POST', { scheduled_date: date, scheduled_time: time });
        showToast('Appointment scheduled successfully.');
        closeModal('accept-modal');
        loadDoctorDashboard();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  const rejectForm = document.getElementById('reject-appt-form');
  if (rejectForm) {
    rejectForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('reject-appt-id').value;
      const reason = document.getElementById('reject-reason').value.trim();

      try {
        await apiCall(`/api/doctor/appointments/${id}/reject`, 'POST', { reason });
        showToast('Appointment rejected.');
        closeModal('reject-modal');
        loadDoctorDashboard();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  const refundForm = document.getElementById('refund-appt-form');
  if (refundForm) {
    refundForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('refund-appt-id').value;
      const amount = document.getElementById('refund-amount').value;
      const date = document.getElementById('refund-date').value;
      const ref = document.getElementById('refund-ref').value.trim();

      try {
        await apiCall(`/api/doctor/appointments/${id}/refund`, 'POST', { refund_amount: amount, refund_date: date, refund_ref: ref });
        showToast('Refund processed successfully.');
        closeModal('refund-modal');
        loadDoctorDashboard();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  const followupForm = document.getElementById('followup-appt-form');
  if (followupForm) {
    followupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('followup-appt-id').value;
      const date = document.getElementById('followup-date').value;
      const time = document.getElementById('followup-time').value;

      try {
        await apiCall(`/api/doctor/appointments/${id}/followup`, 'POST', { scheduled_date: date, scheduled_time: time });
        showToast('Follow-up scheduled successfully.');
        closeModal('followup-modal');
        loadDoctorDashboard();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }
}

async function loadDoctorDashboard() {
  await loadDoctorAvailability();
  await loadDoctorAppointments();
}

async function loadDoctorAvailability() {
  const list = document.getElementById('availability-list');
  if (!list) return;

  try {
    const avails = await apiCall('/api/doctor/availability');
    if (avails.length === 0) {
      list.innerHTML = '<tr><td colspan="4" class="text-center text-muted-color">No availability configured yet.</td></tr>';
      return;
    }
    list.innerHTML = avails.map(a => `
      <tr>
        <td>${formatDate(a.date)}</td>
        <td>${a.working_hours}</td>
        <td><span class="badge ${a.is_available ? 'badge-completed' : 'badge-rejected'}">${a.is_available ? 'AVAILABLE' : 'OFF'}</span></td>
        <td>
          <button class="btn btn-secondary btn-sm" onclick="editAvailability('${a.date}', '${a.working_hours.replace(/'/g, "\\'")}', ${a.is_available})">Edit</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast('Failed to load availability: ' + err.message, 'error');
  }
}

function editAvailability(date, hours, status) {
  document.getElementById('avail-date').value = date.slice(0,10);
  document.getElementById('avail-hours').value = hours;
  document.getElementById('avail-status').value = status ? '1' : '0';
}

async function loadDoctorAppointments() {
  const tableBody = document.getElementById('doctor-appointments-list');
  if (!tableBody) return;

  try {
    const appts = await apiCall('/api/doctor/appointments');
    if (appts.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="7" class="text-center text-muted-color">No appointment records found.</td></tr>';
      return;
    }

    tableBody.innerHTML = appts.map(a => {
      let actionButtons = '';
      if (a.status === 'pending_approval') {
        actionButtons = `
          <button class="btn btn-success btn-sm" onclick="triggerAccept('${a.id}', ${a.consultation_fee})">Accept</button>
          <button class="btn btn-danger btn-sm" onclick="triggerReject('${a.id}')">Reject</button>
        `;
      } else if (a.status === 'scheduled') {
        actionButtons = `
          <button class="btn btn-secondary btn-sm" onclick="triggerFollowup('${a.id}')">Schedule Follow-up</button>
          <button class="btn btn-success btn-sm" onclick="triggerComplete('${a.id}')">Complete</button>
        `;
      } else if (a.status === 'rejected' && a.refund_status === 'pending') {
        actionButtons = `
          <button class="btn btn-secondary btn-sm" onclick="triggerRefund('${a.id}', ${a.consultation_fee})">Process Refund</button>
        `;
      }

      return `
        <tr>
          <td>
            <strong>${a.id}</strong>
            ${a.parent_appointment_id ? `<br><small class="text-primary-color">Follow-up to: ${a.parent_appointment_id}</small>` : ''}
          </td>
          <td>
            <strong>${a.patient_name}</strong><br>
            <small class="text-muted-color">${a.patient_email} | ${a.patient_phone}</small>
          </td>
          <td><span style="font-size: 0.85rem;" class="text-muted-color">${a.health_issue}</span></td>
          <td>
            Fee: $${a.consultation_fee} <br>
            Ref: <small>${a.payment_ref}</small> <br>
            <a href="${a.payment_proof_path}" target="_blank" class="text-primary-color" style="font-size: 0.85rem; text-decoration: underline;">View Proof</a>
          </td>
          <td>${getStatusBadge(a.status)}</td>
          <td>
            ${a.scheduled_date ? `${formatDate(a.scheduled_date)} <br> ${a.scheduled_time}` : 'N/A'}
            ${a.meeting_link ? `<br><a href="${a.meeting_link}" target="_blank" class="text-primary-color" style="font-size: 0.85rem;">[Join Meet]</a>` : ''}
          </td>
          <td>
            <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
              ${actionButtons || '<span class="text-muted-color">No actions</span>'}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    showToast('Failed to load appointments: ' + err.message, 'error');
  }
}

function triggerAccept(id, fee) {
  document.getElementById('accept-appt-id').value = id;
  document.getElementById('accept-date').value = new Date().toISOString().slice(0, 10);
  openModal('accept-modal');
}

function triggerReject(id) {
  document.getElementById('reject-appt-id').value = id;
  document.getElementById('reject-reason').value = '';
  openModal('reject-modal');
}

function triggerRefund(id, fee) {
  document.getElementById('refund-appt-id').value = id;
  document.getElementById('refund-amount').value = fee;
  document.getElementById('refund-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('refund-ref').value = '';
  openModal('refund-modal');
}

function triggerFollowup(id) {
  document.getElementById('followup-appt-id').value = id;
  document.getElementById('followup-date').value = new Date(Date.now() + 7*24*60*60*1000).toISOString().slice(0, 10); // +1 week
  openModal('followup-modal');
}

async function triggerComplete(id) {
  if (!confirm('Mark this consultation as completed?')) return;
  try {
    await apiCall(`/api/doctor/appointments/${id}/complete`, 'POST');
    showToast('Consultation completed successfully.');
    loadDoctorDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==========================================
// 3. OWNER PORTAL FUNCTIONS
// ==========================================
async function initOwnerPortal() {
  const loginForm = document.getElementById('owner-login-form');
  const portalSection = document.getElementById('owner-portal-section');
  const loginSection = document.getElementById('owner-login-section');
  const logoutBtn = document.getElementById('owner-logout-btn');

  // Tab switching
  const tabButtons = document.querySelectorAll('#owner-portal-section .tab-btn');
  const tabPanels = document.querySelectorAll('#owner-portal-section .tab-panel');

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.style.display = 'none');

      btn.classList.add('active');
      const panelId = btn.dataset.tab;
      document.getElementById(panelId).style.display = 'block';

      if (panelId === 'panel-doctors') loadOwnerDoctors();
      else if (panelId === 'panel-dashboard') loadOwnerDashboard();
    });
  });

  // Verify stored session
  const token = Storage.getToken();
  const user = Storage.getUser();

  if (token && user && user.role === 'owner') {
    loginSection.style.display = 'none';
    portalSection.style.display = 'block';
    loadOwnerDashboard();
  } else {
    loginSection.style.display = 'block';
    portalSection.style.display = 'none';
  }

  // Owner Login
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('owner-email-input').value.trim();
      const password = document.getElementById('owner-password-input').value;
      const submitBtn = loginForm.querySelector('button[type="submit"]');

      submitBtn.disabled = true;
      submitBtn.innerHTML = 'Signing in...';

      try {
        const res = await apiCall('/api/auth/login', 'POST', { email, password, role: 'owner' });
        Storage.setToken(res.token);
        Storage.setUser(res.user);
        
        loginSection.style.display = 'none';
        portalSection.style.display = 'block';
        showToast('Owner Portal Logged In!');
        loadOwnerDashboard();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Sign In';
      }
    });
  }

  // Owner Logout
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      Storage.clearToken();
      Storage.clearUser();
      window.location.reload();
    });
  }

  // Owner Doctor form submission
  const docForm = document.getElementById('owner-doc-form');
  if (docForm) {
    docForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('doc-id-field').value;
      const name = document.getElementById('doc-name-field').value.trim();
      const email = document.getElementById('doc-email-field').value.trim();
      const phone = document.getElementById('doc-phone-field').value.trim();
      const spec = document.getElementById('doc-spec-field').value.trim();
      const fee = document.getElementById('doc-fee-field').value;
      const password = document.getElementById('doc-pass-field').value;
      const active = document.getElementById('doc-active-field').value === '1';

      const payload = { name, email, phone, specialization: spec, fee, is_active: active, password };

      try {
        if (id) {
          // Update
          await apiCall(`/api/owner/doctors/${id}`, 'PUT', payload);
          showToast('Doctor account updated.');
        } else {
          // Create
          await apiCall('/api/owner/doctors', 'POST', payload);
          showToast('Doctor account created.');
        }
        closeModal('doctor-modal');
        loadOwnerDoctors();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // QR Code upload
  const qrUploadForm = document.getElementById('qr-upload-form');
  if (qrUploadForm) {
    qrUploadForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fileInput = document.getElementById('qr-file-input');
      if (!fileInput.files[0]) return;

      const fd = new FormData();
      fd.append('qr_code', fileInput.files[0]);

      const submitBtn = qrUploadForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      try {
        const token = Storage.getToken();
        const res = await fetch('/api/owner/settings/qr', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: fd
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);

        showToast('Payment QR Code updated successfully.');
        document.getElementById('owner-qr-preview').src = result.url;
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  // Manual cron trigger
  const triggerRemindersBtn = document.getElementById('trigger-reminders-btn');
  if (triggerRemindersBtn) {
    triggerRemindersBtn.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to dispatch availability reminder emails to all active doctors?')) return;
      triggerRemindersBtn.disabled = true;
      triggerRemindersBtn.textContent = 'Sending...';

      try {
        const res = await apiCall('/api/owner/trigger-reminders', 'POST');
        showToast(res.message);
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        triggerRemindersBtn.disabled = false;
        triggerRemindersBtn.textContent = 'Trigger Reminders Manually';
      }
    });
  }
}

async function loadOwnerDashboard() {
  try {
    const stats = await apiCall('/api/owner/dashboard');
    
    // Fill statistics
    document.getElementById('stat-total-doctors').textContent = stats.doctors;
    document.getElementById('stat-total-appts').textContent = stats.appointments;
    document.getElementById('stat-pending-appts').textContent = stats.pending;
    document.getElementById('stat-scheduled-appts').textContent = stats.scheduled;
    document.getElementById('stat-completed-appts').textContent = stats.completed;
    document.getElementById('stat-rejected-appts').textContent = stats.rejected;
    document.getElementById('stat-revenue').textContent = `$${stats.revenue.toFixed(2)}`;
    document.getElementById('stat-refunds').textContent = `$${stats.refunds.toFixed(2)}`;

    // Populate QR Preview
    const settings = await apiCall('/api/system/settings');
    if (document.getElementById('owner-qr-preview') && settings.payment_qr_code_url) {
      document.getElementById('owner-qr-preview').src = settings.payment_qr_code_url;
    }

    // Populate Recent Appointments
    const recentList = document.getElementById('owner-recent-appointments');
    if (recentList) {
      if (stats.recentAppointments.length === 0) {
        recentList.innerHTML = '<tr><td colspan="7" class="text-center text-muted-color">No recent appointments.</td></tr>';
      } else {
        recentList.innerHTML = stats.recentAppointments.map(a => `
          <tr>
            <td><strong>${a.id}</strong></td>
            <td><strong>${a.patient_name}</strong><br><small>${a.patient_email}</small></td>
            <td>Dr. ${a.doctor_name || 'N/A'}</td>
            <td>$${a.consultation_fee}</td>
            <td>${getStatusBadge(a.status)}</td>
            <td>${a.scheduled_date ? `${formatDate(a.scheduled_date)} ${a.scheduled_time}` : 'N/A'}</td>
            <td><small class="text-muted-color">${formatDateTime(a.created_at)}</small></td>
          </tr>
        `).join('');
      }
    }

    // Populate Notifications logs
    const logList = document.getElementById('owner-notifications-log');
    if (logList) {
      if (stats.notificationLogs.length === 0) {
        logList.innerHTML = '<tr><td colspan="5" class="text-center text-muted-color">No notification logs recorded.</td></tr>';
      } else {
        logList.innerHTML = stats.notificationLogs.map(l => `
          <tr>
            <td><span class="badge ${l.type === 'email' ? 'badge-scheduled' : 'badge-completed'}">${l.type}</span></td>
            <td>${l.recipient}</td>
            <td>${l.subject}</td>
            <td><span class="badge ${l.status === 'sent' ? 'badge-completed' : 'badge-rejected'}">${l.status}</span></td>
            <td><small class="text-muted-color">${formatDateTime(l.sent_at)}</small></td>
          </tr>
        `).join('');
      }
    }

  } catch (err) {
    showToast('Failed to load dashboard statistics: ' + err.message, 'error');
  }
}

async function loadOwnerDoctors() {
  const tableBody = document.getElementById('owner-doctors-list');
  if (!tableBody) return;

  try {
    const doctors = await apiCall('/api/owner/doctors');
    if (doctors.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="6" class="text-center text-muted-color">No doctors registered yet.</td></tr>';
      return;
    }

    tableBody.innerHTML = doctors.map(d => `
      <tr>
        <td><strong>Dr. ${d.name}</strong></td>
        <td>${d.email}</td>
        <td>${d.phone || 'N/A'}</td>
        <td>${d.specialization}</td>
        <td>$${d.fee}</td>
        <td><span class="badge ${d.is_active ? 'badge-completed' : 'badge-rejected'}">${d.is_active ? 'Active' : 'Disabled'}</span></td>
        <td>
          <button class="btn btn-secondary btn-sm" onclick="openEditDoctorModal(${JSON.stringify(d).replace(/"/g, '&quot;')})">Edit</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast('Failed to load doctors: ' + err.message, 'error');
  }
}

function openAddDoctorModal() {
  document.getElementById('modal-title-doc').textContent = 'Add New Doctor Account';
  document.getElementById('doc-id-field').value = '';
  document.getElementById('doc-name-field').value = '';
  document.getElementById('doc-email-field').value = '';
  document.getElementById('doc-phone-field').value = '';
  document.getElementById('doc-spec-field').value = '';
  document.getElementById('doc-fee-field').value = '';
  document.getElementById('doc-pass-field').value = '';
  document.getElementById('doc-pass-help').style.display = 'none';
  document.getElementById('doc-active-field').value = '1';
  openModal('doctor-modal');
}

function openEditDoctorModal(doc) {
  document.getElementById('modal-title-doc').textContent = 'Edit Doctor Account';
  document.getElementById('doc-id-field').value = doc.id;
  document.getElementById('doc-name-field').value = doc.name;
  document.getElementById('doc-email-field').value = doc.email;
  document.getElementById('doc-phone-field').value = doc.phone || '';
  document.getElementById('doc-spec-field').value = doc.specialization;
  document.getElementById('doc-fee-field').value = doc.fee;
  document.getElementById('doc-pass-field').value = '';
  document.getElementById('doc-pass-help').style.display = 'block';
  document.getElementById('doc-active-field').value = doc.is_active ? '1' : '0';
  openModal('doctor-modal');
}

function triggerReportDownload() {
  const token = Storage.getToken();
  if (!token) return;
  
  // Download file by creating a dynamic anchor element
  fetch('/api/reports/download', {
    headers: { 'Authorization': `Bearer ${token}` }
  })
  .then(response => {
    if (!response.ok) throw new Error('Report download failed');
    return response.blob();
  })
  .then(blob => {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'consultation_report_' + new Date().toISOString().slice(0,10) + '.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
  })
  .catch(err => showToast(err.message, 'error'));
}

// --- PWA SERVICE WORKER REGISTRATION ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then((registration) => {
        console.log('[Service Worker] Registered successfully with scope:', registration.scope);
      })
      .catch((error) => {
        console.error('[Service Worker] Registration failed:', error);
      });
  });
}
