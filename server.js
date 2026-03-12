const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// ── Firebase Init ─────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── eTimeOffice Credentials ───────────────────────────────────────────────────
// From login screen: CorporateID | User Name | Password
const ETO_CORPORATE = process.env.ETIMEOFFICE_CORPORATEID || 'DIMENSIONS';
const ETO_USERNAME  = process.env.ETIMEOFFICE_USERNAME    || 'DIMENSIONS';
const ETO_PASSWORD  = process.env.ETIMEOFFICE_PASSWORD    || 'Dimensions@1';
const ETO_BASE      = 'https://api.etimeoffice.com';
const INTERVAL_MIN  = parseInt(process.env.FETCH_INTERVAL_MIN || '5');

let authToken    = '';
let tokenExpiry  = 0;
let cookieHeader = '';
let syncStatus   = 'idle';
let lastSyncTime = null;
let lastError    = null;
let totalSynced  = 0;
let syncLog      = [];

function addLog(msg, type = 'info') {
  const entry = { time: new Date().toLocaleTimeString('en-IN'), msg, type };
  syncLog.unshift(entry);
  if (syncLog.length > 150) syncLog.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// LOGIN — uses exact field names from eTimeOffice login screen
// CorporateID | UserName | Password
// ══════════════════════════════════════════════════════════════════════════════
async function login() {
  addLog(`Logging in — CorporateID: ${ETO_CORPORATE}, UserName: ${ETO_USERNAME}`, 'info');

  // Exact field names matching the eTimeOffice login form
  const loginPayloads = [
    // Most likely — matches the form field labels exactly
    { CorporateId: ETO_CORPORATE, UserName: ETO_USERNAME, Password: ETO_PASSWORD },
    { CorporateID: ETO_CORPORATE, UserName: ETO_USERNAME, Password: ETO_PASSWORD },
    { corporateId: ETO_CORPORATE, userName: ETO_USERNAME, password: ETO_PASSWORD },
    // Alternate formats
    { CorporateCode: ETO_CORPORATE, UserName: ETO_USERNAME, Password: ETO_PASSWORD },
    { CompanyId: ETO_CORPORATE,     UserName: ETO_USERNAME, Password: ETO_PASSWORD },
    { OrgId: ETO_CORPORATE,         UserName: ETO_USERNAME, Password: ETO_PASSWORD },
    // Flat format
    { UserName: `${ETO_CORPORATE}\\${ETO_USERNAME}`, Password: ETO_PASSWORD },
    { UserName: `${ETO_CORPORATE}/${ETO_USERNAME}`,  Password: ETO_PASSWORD },
  ];

  const loginEndpoints = [
    `${ETO_BASE}/api/Login`,
    `${ETO_BASE}/api/UserLogin`,
    `${ETO_BASE}/api/Account/Login`,
    `${ETO_BASE}/api/Auth/Login`,
    `${ETO_BASE}/api/v1/Login`,
    `${ETO_BASE}/api/CorporateLogin`,
  ];

  for (const url of loginEndpoints) {
    for (const payload of loginPayloads) {
      try {
        addLog(`POST ${url} → ${JSON.stringify(payload)}`, 'info');

        const res  = await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body:    JSON.stringify(payload),
        });

        const text = await res.text();
        addLog(`← ${res.status}: ${text.substring(0, 250)}`, 'info');

        if (res.status === 404) break; // wrong endpoint — try next URL

        // Capture session cookie if present
        const sc = res.headers.get('set-cookie');
        if (sc) cookieHeader = sc.split(';')[0];

        let data;
        try { data = JSON.parse(text); } catch { continue; }

        // Extract token — every possible field name
        const token =
          data.Token       || data.token       ||
          data.AccessToken || data.access_token ||
          data.AuthToken   || data.auth_token   ||
          data.SessionId   || data.sessionId    ||
          data.BearerToken || data.bearer_token ||
          data.Key         || data.key          || null;

        if (token) {
          authToken   = token;
          tokenExpiry = Date.now() + 55 * 60 * 1000;
          addLog(`✅ Login SUCCESS — token from ${url}`, 'success');
          return true;
        }

        // Session-based success (no token in body)
        const ok =
          res.status === 200 && (
            data.Status    === 'Success' || data.status    === 'success' ||
            data.IsSuccess === true      || data.isSuccess === true      ||
            data.Result    === true      || data.success   === true      ||
            (typeof data.Message === 'string' && data.Message.toLowerCase().includes('success'))
          );

        if (ok) {
          authToken   = 'SESSION';
          tokenExpiry = Date.now() + 55 * 60 * 1000;
          addLog(`✅ Login SUCCESS (session) from ${url}`, 'success');
          return true;
        }

        const errMsg = data.Message || data.message || data.Error || data.error || text.substring(0, 100);
        addLog(`✗ ${url}: ${errMsg}`, 'warn');

      } catch (err) {
        addLog(`✗ Network error at ${url}: ${err.message}`, 'warn');
      }
    }
  }

  addLog('❌ All login attempts failed. eTimeOffice may not have API access enabled for this account.', 'error');
  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// FETCH ATTENDANCE LOGS
// ══════════════════════════════════════════════════════════════════════════════
async function fetchLogs(fromDate, toDate) {
  if (!authToken || Date.now() > tokenExpiry) {
    const ok = await login();
    if (!ok) throw new Error('eTimeOffice login failed — check credentials');
  }

  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (authToken && authToken !== 'SESSION') {
    headers['Authorization'] = `Bearer ${authToken}`;
    headers['Token']         = authToken;
    headers['X-Auth-Token']  = authToken;
  }
  if (cookieHeader) headers['Cookie'] = cookieHeader;

  const body = {
    CorporateId: ETO_CORPORATE,
    CorporateID: ETO_CORPORATE,
    UserName:    ETO_USERNAME,
    Password:    ETO_PASSWORD,
    FromDate:    fromDate,
    ToDate:      toDate,
    StartDate:   fromDate,
    EndDate:     toDate,
    Date:        fromDate,
    EmpCode:     '',
  };

  const endpoints = [
    `${ETO_BASE}/api/GetAttendanceLogs`,
    `${ETO_BASE}/api/GetPunchLogs`,
    `${ETO_BASE}/api/AttendanceLogs`,
    `${ETO_BASE}/api/GetDailyAttendance`,
    `${ETO_BASE}/api/GetEmployeePunches`,
    `${ETO_BASE}/api/Attendance/GetLogs`,
    `${ETO_BASE}/api/Report/Attendance`,
    `${ETO_BASE}/api/v1/AttendanceLogs`,
  ];

  for (const url of endpoints) {
    try {
      addLog(`Fetching: POST ${url}`, 'info');
      const res  = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      const text = await res.text();
      addLog(`← ${res.status}: ${text.substring(0, 150)}`, 'info');

      if (res.status === 404 || res.status === 401) continue;

      let data;
      try { data = JSON.parse(text); } catch { continue; }

      const arr =
        data.Data   || data.data   || data.Logs    || data.logs    ||
        data.Records|| data.records|| data.Result  || data.result  ||
        data.AttendanceLogs || (Array.isArray(data) ? data : null);

      if (Array.isArray(arr)) {
        addLog(`✅ ${arr.length} punch records from ${url}`, 'success');
        return arr;
      }
    } catch (err) {
      addLog(`✗ ${url}: ${err.message}`, 'warn');
    }
  }

  throw new Error('No working attendance endpoint. Contact eTimeOffice (080-6901 0000) to enable API access for account: ' + ETO_CORPORATE);
}

// ══════════════════════════════════════════════════════════════════════════════
// NORMALIZE RAW RECORD
// ══════════════════════════════════════════════════════════════════════════════
function normalize(log) {
  const empCode = String(log.EmpCode || log.empCode || log.UserId || log.EmployeeCode || '').trim();
  const empName = String(log.EmpName || log.empName || log.Name   || log.EmployeeName || '').trim();

  let date = String(log.PunchDate || log.LogDate || log.AttDate || log.Date || log.date || '').split('T')[0];
  if (/^\d{2}[-\/]\d{2}[-\/]\d{4}$/.test(date)) {
    const [d, m, y] = date.split(/[-\/]/);
    date = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }

  const time  = String(log.PunchTime || log.Time || log.AttTime || log.time || '').trim();
  const dirRaw = String(log.Direction || log.PunchType || log.InOut || log.type || '').toLowerCase();
  const direction = (dirRaw.includes('out') || dirRaw === '1' || dirRaw === 'exit') ? 'OUT' : 'IN';

  return { empCode, empName, date, time, direction };
}

// ══════════════════════════════════════════════════════════════════════════════
// SAVE TO FIREBASE
// ══════════════════════════════════════════════════════════════════════════════
async function saveToFirebase(records) {
  const groups = {};
  for (const r of records) {
    if (!r.empCode || !r.date) continue;
    const key = `${r.empCode}_${r.date}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }

  let saved = 0;
  for (const punches of Object.values(groups)) {
    const sorted   = punches.sort((a, b) => a.time.localeCompare(b.time));
    const first    = sorted[0];
    const punchIn  = sorted.find(p => p.direction === 'IN')?.time  || sorted[0].time;
    const punchOut = [...sorted].reverse().find(p => p.direction === 'OUT')?.time || (sorted.length > 1 ? sorted.at(-1).time : '');

    try {
      const snap = await db.collection('attendance')
        .where('empCode', '==', first.empCode)
        .where('date',    '==', first.date)
        .get();

      if (snap.empty) {
        await db.collection('attendance').add({
          empCode:    first.empCode,
          empName:    first.empName,
          date:       first.date,
          punchIn,
          punchOut,
          status:     'Present',
          source:     'eTimeOffice-LiveSync',
          punchCount: sorted.length,
          liveSync:   true,
          syncedAt:   admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        const cur = snap.docs[0].data();
        const upd = {
          punchCount: sorted.length,
          liveSync:   true,
          syncedAt:   admin.firestore.FieldValue.serverTimestamp(),
        };
        if (!cur.punchIn && punchIn)                                    upd.punchIn  = punchIn;
        if (punchOut && (!cur.punchOut || punchOut > cur.punchOut))     upd.punchOut = punchOut;
        await snap.docs[0].ref.update(upd);
      }

      // Also save raw punch log
      for (const p of sorted) {
        await db.collection('biometric_logs').add({
          ...p, source: 'eTimeOffice-LiveSync',
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      saved++;
    } catch (e) {
      addLog(`Firebase error for ${first.empCode}: ${e.message}`, 'error');
    }
  }
  return saved;
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN SYNC
// ══════════════════════════════════════════════════════════════════════════════
async function runSync(fromDate, toDate) {
  if (syncStatus === 'syncing') { addLog('Already syncing, skipping...', 'warn'); return { skipped: true }; }

  const today = new Date().toISOString().split('T')[0];
  fromDate = fromDate || today;
  toDate   = toDate   || today;

  syncStatus = 'syncing';
  addLog(`━━━ SYNC START ${fromDate} → ${toDate} ━━━`, 'info');

  try {
    const raw     = await fetchLogs(fromDate, toDate);
    const records = raw.map(normalize).filter(r => r.empCode && r.date);
    addLog(`Normalized ${records.length} records`, 'info');

    const saved  = await saveToFirebase(records);
    totalSynced += saved;
    lastSyncTime = new Date().toISOString();
    lastError    = null;
    syncStatus   = 'idle';
    addLog(`━━━ SYNC DONE — ${saved} saved to Firebase ━━━`, 'success');
    return { synced: saved, total: totalSynced };
  } catch (err) {
    lastError  = err.message;
    syncStatus = 'error';
    addLog(`━━━ SYNC FAILED: ${err.message} ━━━`, 'error');
    throw err;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SCHEDULER — runs automatically every N minutes
// ══════════════════════════════════════════════════════════════════════════════
function startScheduler() {
  addLog(`⏰ Auto-sync every ${INTERVAL_MIN} minutes`, 'info');
  setTimeout(async () => { try { await runSync(); } catch {} }, 10000);
  setInterval(async () => { try { await runSync(); } catch {} }, INTERVAL_MIN * 60 * 1000);
}

// ══════════════════════════════════════════════════════════════════════════════
// HTTP ROUTES
// ══════════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => res.json({
  app: 'DIMS HRMS — eTimeOffice Live Sync Server',
  status: syncStatus, lastSyncTime, lastError, totalSynced,
  interval: `Every ${INTERVAL_MIN} min`,
  credentials: {
    corporateId: ETO_CORPORATE  ? `✅ ${ETO_CORPORATE}` : '❌ Missing',
    userName:    ETO_USERNAME   ? `✅ ${ETO_USERNAME}`  : '❌ Missing',
    password:    ETO_PASSWORD   ? '✅ Set'              : '❌ Missing',
    firebase:    serviceAccount.project_id ? `✅ ${serviceAccount.project_id}` : '❌ Missing',
  },
  recentLogs: syncLog.slice(0, 20),
}));

app.get('/status',     (req, res) => res.json({ syncStatus, lastSyncTime, lastError, totalSynced, logs: syncLog.slice(0, 30) }));
app.get('/test/login', async (req, res) => {
  authToken = ''; tokenExpiry = 0; cookieHeader = '';
  const ok = await login();
  res.json({ success: ok, corporateId: ETO_CORPORATE, userName: ETO_USERNAME, logs: syncLog.slice(0, 30) });
});
app.get('/sync/now',  async (req, res) => {
  try   { res.json({ success: true,  ...(await runSync()), logs: syncLog.slice(0, 20) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message, logs: syncLog.slice(0, 20) }); }
});
app.post('/sync/now', async (req, res) => {
  try   { res.json({ success: true,  ...(await runSync(req.body?.fromDate, req.body?.toDate)) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  addLog(`🚀 Server running on port ${PORT}`, 'info');
  addLog(`CorporateID: ${ETO_CORPORATE} | UserName: ${ETO_USERNAME}`, 'info');
  if (ETO_USERNAME && ETO_PASSWORD) startScheduler();
  else addLog('⚠️ Set ETIMEOFFICE_CORPORATEID, ETIMEOFFICE_USERNAME, ETIMEOFFICE_PASSWORD in Render!', 'error');
});
