const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// ── Firebase ──────────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Credentials ───────────────────────────────────────────────────────────────
const CORP     = process.env.ETIMEOFFICE_CORPORATEID || 'DIMENSIONS';
const USER     = process.env.ETIMEOFFICE_USERNAME    || 'DIMENSIONS';
const PASS     = process.env.ETIMEOFFICE_PASSWORD    || 'Dimensions@1';
const INTERVAL = parseInt(process.env.FETCH_INTERVAL_MIN || '5');
const BASE_URL = 'https://api.etimeoffice.com/api';

// ── Build Authorization header ────────────────────────────────────────────────
// FROM API DOC: "value is converted to base64 encoding of (corporateid:username:password:true)"
function getAuthHeader() {
  const raw     = `${CORP}:${USER}:${PASS}:true`;
  const encoded = Buffer.from(raw).toString('base64');
  return `Basic ${encoded}`;
}

// ── State ─────────────────────────────────────────────────────────────────────
let syncStatus   = 'idle';
let lastSyncTime = null;
let lastError    = null;
let totalSynced  = 0;
let lastRecord   = null; // for incremental sync
let syncLog      = [];

function log(msg, type = 'info') {
  const entry = { time: new Date().toLocaleTimeString('en-IN', {timeZone:'Asia/Kolkata'}), msg, type };
  syncLog.unshift(entry);
  if (syncLog.length > 200) syncLog.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ════════════════════════════════════════════════════════════════════════════
// API 1 — DownloadInOutPunchData  (IN/OUT processed)
// GET https://api.etimeoffice.com/api/DownloadInOutPunchData?Empcode=ALL&FromDate=10/01/2019&ToDate=10/01/2019
// Returns: { InOutPunchData: [{ Empcode, INTime, OUTTime, WorkTime, Status, DateString, Name, ... }] }
// ════════════════════════════════════════════════════════════════════════════
async function fetchInOutData(fromDate, toDate) {
  // API date format: dd/MM/yyyy
  const url = `${BASE_URL}/DownloadInOutPunchData?Empcode=ALL&FromDate=${fromDate}&ToDate=${toDate}`;
  log(`GET ${url}`, 'info');

  const res  = await fetch(url, {
    headers: {
      'Authorization': getAuthHeader(),
      'Accept':        'application/json',
      'Content-Type':  'application/json',
    }
  });

  const text = await res.text();
  log(`← ${res.status}: ${text.substring(0, 300)}`, 'info');

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.substring(0, 200)}`);

  const data = JSON.parse(text);

  // Response format from doc: { "InOutPunchData": [...], "Error": false, "Msg": "Success" }
  if (data.Error === true) throw new Error(data.Msg || 'API returned error');

  const records = data.InOutPunchData || data.inOutPunchData || data.Data || data.data || [];
  log(`✅ Got ${records.length} IN/OUT records`, 'success');
  return records;
}

// ════════════════════════════════════════════════════════════════════════════
// API 2 — DownloadLastPunchData  (incremental, raw punches)
// GET .../DownloadLastPunchData?Empcode=ALL&LastRecord=092020$454
// Returns: { PunchData:[...], MaxRecord:"092020$456" }
// ════════════════════════════════════════════════════════════════════════════
async function fetchLastPunchData() {
  const param = lastRecord ? `LastRecord=${lastRecord}` : `LastRecord=`;
  const url   = `${BASE_URL}/DownloadLastPunchData?Empcode=ALL&${param}`;
  log(`GET ${url}`, 'info');

  const res  = await fetch(url, {
    headers: {
      'Authorization': getAuthHeader(),
      'Accept':        'application/json',
    }
  });

  const text = await res.text();
  log(`← ${res.status}: ${text.substring(0, 300)}`, 'info');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = JSON.parse(text);
  if (data.Error === true) throw new Error(data.Msg || 'API error');

  // Save MaxRecord for next call
  if (data.MaxRecord) {
    lastRecord = data.MaxRecord;
    log(`MaxRecord updated → ${lastRecord}`, 'info');
    // Persist to Firebase so it survives restarts
    await db.collection('biometric_meta').doc('lastRecord').set({ value: lastRecord, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }

  return data.PunchData || data.punchData || [];
}

// ════════════════════════════════════════════════════════════════════════════
// Save IN/OUT records to Firebase attendance
// ════════════════════════════════════════════════════════════════════════════
async function saveInOutToFirebase(records) {
  let saved = 0;
  for (const r of records) {
    // Field names from API doc: Empcode, INTime, OUTTime, WorkTime, Status, DateString, Name
    const empCode  = String(r.Empcode  || r.empcode  || r.EmpCode  || '').trim();
    const empName  = String(r.Name     || r.name     || r.EmpName  || '').trim();
    const dateStr  = String(r.DateString || r.Date   || '').trim(); // dd/MM/yyyy
    const inTime   = String(r.INTime   || r.InTime   || '').trim();
    const outTime  = String(r.OUTTime  || r.OutTime  || '').trim();
    const status   = String(r.Status   || '').trim();
    const workTime = String(r.WorkTime || '').trim();
    const remark   = String(r.Remark   || '').trim();

    if (!empCode || !dateStr) continue;

    // Convert dd/MM/yyyy → yyyy-MM-dd for Firebase
    let date = dateStr;
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
      const [d, m, y] = dateStr.split('/');
      date = `${y}-${m}-${d}`;
    }

    try {
      const snap = await db.collection('attendance')
        .where('empCode', '==', empCode)
        .where('date',    '==', date)
        .get();

      const docData = {
        empCode, empName, date,
        punchIn:   inTime  !== '--:--' ? inTime  : '',
        punchOut:  outTime !== '--:--' ? outTime : '',
        status:    status || 'Present',
        workTime,  remark,
        source:    'eTimeOffice-API',
        liveSync:  true,
        syncedAt:  admin.firestore.FieldValue.serverTimestamp(),
      };

      if (snap.empty) {
        await db.collection('attendance').add(docData);
      } else {
        await snap.docs[0].ref.update(docData);
      }
      saved++;
    } catch (e) {
      log(`Firebase error ${empCode}/${date}: ${e.message}`, 'error');
    }
  }
  return saved;
}

// ════════════════════════════════════════════════════════════════════════════
// Save raw punch data to Firebase
// ════════════════════════════════════════════════════════════════════════════
async function saveRawPunchesToFirebase(punches) {
  let saved = 0;
  for (const p of punches) {
    const empCode  = String(p.Empcode  || p.EmpCode  || '').trim();
    const empName  = String(p.Name     || p.EmpName  || '').trim();
    const punchDT  = String(p.PunchDate || '').trim(); // "30/09/2020 09:46:00"
    const id       = p.ID || p.id;

    if (!empCode || !punchDT) continue;

    // Parse "dd/MM/yyyy HH:mm:ss"
    let date = '', time = '';
    const parts = punchDT.split(' ');
    if (parts.length >= 2) {
      const [d, m, y] = parts[0].split('/');
      date = `${y}-${m}-${d}`;
      time = parts[1].substring(0, 5); // HH:mm
    }

    try {
      // Upsert attendance record
      const snap = await db.collection('attendance')
        .where('empCode', '==', empCode)
        .where('date',    '==', date)
        .get();

      if (snap.empty) {
        await db.collection('attendance').add({
          empCode, empName, date,
          punchIn:  time,
          punchOut: '',
          status:   'Present',
          source:   'eTimeOffice-API',
          liveSync: true,
          syncedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        const cur = snap.docs[0].data();
        const upd = { liveSync: true, syncedAt: admin.firestore.FieldValue.serverTimestamp() };
        if (!cur.punchIn)  upd.punchIn  = time;
        if (time > (cur.punchIn || '00:00')) upd.punchOut = time;
        await snap.docs[0].ref.update(upd);
      }

      // Save raw punch log
      await db.collection('biometric_logs').add({
        empCode, empName, date, time, punchDateTime: punchDT,
        etoId: id, source: 'eTimeOffice-API',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      saved++;
    } catch (e) {
      log(`Firebase error ${empCode}: ${e.message}`, 'error');
    }
  }
  return saved;
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN SYNC — uses InOut API (primary) + LastPunch API (incremental)
// ════════════════════════════════════════════════════════════════════════════
async function runSync(fromDate, toDate) {
  if (syncStatus === 'syncing') { log('Already syncing, skip', 'warn'); return { skipped: true }; }

  // Default: today in dd/MM/yyyy format
  const now     = new Date(new Date().toLocaleString('en-US', {timeZone:'Asia/Kolkata'}));
  const dd      = String(now.getDate()).padStart(2, '0');
  const mm      = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy    = now.getFullYear();
  const today   = `${dd}/${mm}/${yyyy}`;

  fromDate = fromDate || today;
  toDate   = toDate   || today;

  syncStatus = 'syncing';
  log(`━━━ SYNC START ${fromDate} → ${toDate} ━━━`, 'info');

  let totalSaved = 0;

  try {
    // 1) Fetch IN/OUT processed data (best for attendance)
    try {
      const inOutRecords = await fetchInOutData(fromDate, toDate);
      const saved = await saveInOutToFirebase(inOutRecords);
      totalSaved += saved;
      log(`InOut saved: ${saved}`, 'success');
    } catch (e) {
      log(`InOut API failed: ${e.message} — trying raw punch API`, 'warn');

      // 2) Fallback: fetch incremental raw punches
      const punches = await fetchLastPunchData();
      const saved   = await saveRawPunchesToFirebase(punches);
      totalSaved += saved;
      log(`Raw punches saved: ${saved}`, 'success');
    }

    totalSynced += totalSaved;
    lastSyncTime = new Date().toISOString();
    lastError    = null;
    syncStatus   = 'idle';
    log(`━━━ SYNC DONE — ${totalSaved} records saved ━━━`, 'success');
    return { synced: totalSaved, total: totalSynced };

  } catch (err) {
    lastError  = err.message;
    syncStatus = 'error';
    log(`━━━ SYNC FAILED: ${err.message} ━━━`, 'error');
    throw err;
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
async function loadLastRecord() {
  try {
    const doc = await db.collection('biometric_meta').doc('lastRecord').get();
    if (doc.exists) {
      lastRecord = doc.data().value;
      log(`Restored LastRecord: ${lastRecord}`, 'info');
    }
  } catch {}
}

function startScheduler() {
  log(`⏰ Auto-sync every ${INTERVAL} minutes`, 'info');
  loadLastRecord().then(() => {
    setTimeout(async () => { try { await runSync(); } catch {} }, 5000);
    setInterval(async () => { try { await runSync(); } catch {} }, INTERVAL * 60 * 1000);
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  app:         'DIMS HRMS — eTimeOffice Live Sync',
  status:       syncStatus,
  lastSyncTime, lastError, totalSynced,
  lastRecord,
  interval:    `Every ${INTERVAL} min`,
  auth:        `Basic ${Buffer.from(`${CORP}:${USER}:${PASS}:true`).toString('base64')}`,
  credentials: {
    corporateId: CORP ? `✅ ${CORP}` : '❌ Missing',
    userName:    USER ? `✅ ${USER}` : '❌ Missing',
    password:    PASS ? '✅ Set'     : '❌ Missing',
    firebase:    serviceAccount.project_id ? `✅ ${serviceAccount.project_id}` : '❌ Missing',
  },
  apiDocs: {
    inOut:     `${BASE_URL}/DownloadInOutPunchData?Empcode=ALL&FromDate=DD/MM/YYYY&ToDate=DD/MM/YYYY`,
    lastPunch: `${BASE_URL}/DownloadLastPunchData?Empcode=ALL&LastRecord=MMYYYY$ID`,
    rawPunch:  `${BASE_URL}/DownloadPunchData?Empcode=ALL&FromDate=DD/MM/YYYY_HH:mm&ToDate=DD/MM/YYYY_HH:mm`,
  },
  recentLogs: syncLog.slice(0, 25),
}));

app.get('/status',    (req, res) => res.json({ syncStatus, lastSyncTime, lastError, totalSynced, lastRecord, logs: syncLog.slice(0, 30) }));
app.get('/sync/now',  async (req, res) => {
  const { from, to } = req.query;
  try   { res.json({ success: true,  ...(await runSync(from, to)), logs: syncLog.slice(0, 20) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message, logs: syncLog.slice(0, 20) }); }
});
app.post('/sync/now', async (req, res) => {
  try   { res.json({ success: true,  ...(await runSync(req.body?.fromDate, req.body?.toDate)) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Test auth header
app.get('/test/auth', (req, res) => {
  const raw     = `${CORP}:${USER}:${PASS}:true`;
  const encoded = Buffer.from(raw).toString('base64');
  res.json({ raw, encoded, header: `Basic ${encoded}` });
});

// Manual date range sync
app.get('/sync/date', async (req, res) => {
  const { from, to } = req.query;
  if (!from) return res.status(400).json({ error: 'Provide ?from=DD/MM/YYYY&to=DD/MM/YYYY' });
  try   { res.json({ success: true, ...(await runSync(from, to || from)) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`🚀 Server on port ${PORT}`, 'info');
  log(`Auth: Basic ${Buffer.from(`${CORP}:${USER}:${PASS}:true`).toString('base64')}`, 'info');
  log(`API Doc says: Header Authorization = Basic base64(corporateid:username:password:true)`, 'info');
  startScheduler();
});
