/**
 * Transcription Service
 *
 * Abstracts where transcription records are read from.
 *
 *   VITE_TRANSCRIPTION_STORAGE=local  →  src/data/transcriptions.json  (dev / fallback)
 *   VITE_TRANSCRIPTION_STORAGE=s3     →  AWS S3 bucket via native SigV4 fetch
 *
 * Required env vars when storage = "s3":
 *   VITE_AWS_REGION            e.g. ap-southeast-2
 *   VITE_AWS_ACCESS_KEY_ID     IAM user with s3:ListBucket + s3:GetObject on the bucket
 *   VITE_AWS_SECRET_ACCESS_KEY
 *   VITE_S3_BUCKET             bucket name
 *   VITE_S3_PREFIX             key prefix inside the bucket, e.g. "transcriptions/"
 *
 * S3 CORS requirement — add this rule to the bucket's CORS configuration:
 *   AllowedOrigins: ["*"]  (or your specific hostname)
 *   AllowedMethods: ["GET"]
 *   AllowedHeaders: ["*", "Authorization", "x-amz-*"]
 *   ExposedHeaders: []
 *   MaxAgeSeconds: 3600
 *
 * File layout written by the backend:
 *   {PREFIX}{call_sid}.json   — one JSON object per call, matching the record shape.
 */

const STORAGE = import.meta.env.VITE_TRANSCRIPTION_STORAGE || 'local';

// ─── Local (dev / fallback) ───────────────────────────────────────────────────

let _localCache = null;

async function loadLocalData() {
  if (_localCache) return _localCache;
  const mod = await import('../data/transcriptions.json');
  _localCache = mod.default;
  return _localCache;
}

async function getAllLocal() {
  const data = await loadLocalData();
  return data.records ?? [];
}

async function getByIdLocal(id) {
  const all = await getAllLocal();
  return all.find((r) => r.id === id) || null;
}

// ─── AWS SigV4 signer — browser-native, zero dependencies ────────────────────
// Uses the SubtleCrypto API available in all modern browsers.

async function _sha256hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hash  = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function _hmac256(key, msg) {
  const rawKey = key instanceof CryptoKey ? key
    : await crypto.subtle.importKey(
        'raw',
        typeof key === 'string' ? new TextEncoder().encode(key) : key,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
  const sig = await crypto.subtle.sign('HMAC', rawKey, new TextEncoder().encode(msg));
  return new Uint8Array(sig);
}

function _toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sign and execute an S3 GET request using AWS Signature Version 4.
 * All signing is done in the browser with native Web Crypto — no SDK needed.
 */
async function sigV4Fetch(url, region, accessKeyId, secretAccessKey) {
  const now     = new Date();
  const isoDate = now.toISOString().slice(0, 10).replace(/-/g, '');            // YYYYMMDD
  const isoFull = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, ''); // YYYYMMDDTHHmmssZ

  const parsed = new URL(url);
  const host   = parsed.host;
  const path   = parsed.pathname || '/';

  // SigV4 requires canonical query string: params sorted by key, URI-encoded
  const sortedQS = [...parsed.searchParams.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const bodyHash = await _sha256hex('');   // GET has empty body

  // Canonical headers (must be sorted, lowercase, no extra whitespace)
  const headers = {
    host,
    'x-amz-content-sha256': bodyHash,
    'x-amz-date':           isoFull,
  };
  const hdrKeys   = Object.keys(headers).sort();
  const canonHdrs = hdrKeys.map((k) => `${k}:${headers[k]}`).join('\n') + '\n';
  const signedHdrs = hdrKeys.join(';');

  const canonical = ['GET', path, sortedQS, canonHdrs, signedHdrs, bodyHash].join('\n');
  const scope     = `${isoDate}/${region}/s3/aws4_request`;
  const sts       = ['AWS4-HMAC-SHA256', isoFull, scope, await _sha256hex(canonical)].join('\n');

  // Derive signing key: HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), "s3"), "aws4_request")
  const kDate    = await _hmac256('AWS4' + secretAccessKey, isoDate);
  const kRegion  = await _hmac256(kDate, region);
  const kService = await _hmac256(kRegion, 's3');
  const kSigning = await _hmac256(kService, 'aws4_request');
  const sig      = _toHex(await _hmac256(kSigning, sts));

  return fetch(url, {
    method: 'GET',
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHdrs}, Signature=${sig}`,
    },
  });
}

// ─── S3 Storage ───────────────────────────────────────────────────────────────

const BUCKET = import.meta.env.VITE_S3_BUCKET;
const PREFIX = import.meta.env.VITE_S3_PREFIX ?? 'transcriptions/';
const REGION = import.meta.env.VITE_AWS_REGION ?? 'ap-southeast-2';
// Virtual-hosted-style URL: https://{bucket}.s3.{region}.amazonaws.com
const S3_BASE = `https://${BUCKET}.s3.${REGION}.amazonaws.com`;

function _creds() {
  return {
    region:          REGION,
    accessKeyId:     import.meta.env.VITE_AWS_ACCESS_KEY_ID,
    secretAccessKey: import.meta.env.VITE_AWS_SECRET_ACCESS_KEY,
  };
}

/**
 * Map whatever field names the backend uses to the shape the UI expects.
 * Handles common naming variations so the page works even if the backend
 * stores "timestamp" instead of "created_at", "duration" instead of "duration_s", etc.
 */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const transcript = (() => {
    const t = raw.transcript ?? raw.messages ?? raw.conversation ?? raw.turns ?? [];
    if (!Array.isArray(t)) return [];
    return t.map((turn) => ({
      role: turn.role ?? (turn.speaker === 'agent' ? 'assistant' : 'user'),
      text: turn.text ?? turn.content ?? turn.message ?? '',
      time: turn.time ?? turn.timestamp_s ?? turn.offset ?? undefined,
    }));
  })();

  return {
    id:               raw.id ?? raw.log_id ?? raw.call_sid ?? `rec-${Math.random().toString(36).slice(2)}`,
    call_sid:         raw.call_sid ?? raw.callSid ?? raw.sid ?? '',
    outcome:          raw.outcome ?? (raw.appointment_booked ? 'appointment_booked' : 'no_appointment'),
    duration_s:       raw.duration_s ?? raw.duration ?? raw.call_duration_s ?? 0,
    created_at:       raw.created_at ?? raw.timestamp ?? raw.date ?? raw.started_at ?? new Date().toISOString(),
    patient_name:     raw.patient_name ?? raw.patient ?? raw.caller_name ?? raw.caller ?? 'Unknown Caller',
    doctor_name:      raw.doctor_name ?? raw.doctor ?? raw.physician ?? null,
    appointment_time: raw.appointment_time ?? raw.slot_start ?? raw.booked_time ?? null,
    transcript,
    cost_usd:         raw.cost_usd ?? null,
    cost_breakdown:   raw.cost_breakdown ?? null,
  };
}

/** List all JSON object keys under PREFIX, following S3 pagination tokens. */
async function _listKeys() {
  const { region, accessKeyId, secretAccessKey } = _creds();
  const keys = [];
  let continuationToken = null;

  do {
    const params = new URLSearchParams({ 'list-type': '2', prefix: PREFIX, 'max-keys': '1000' });
    if (continuationToken) params.set('continuation-token', continuationToken);
    const url = `${S3_BASE}/?${params.toString()}`;

    const res = await sigV4Fetch(url, region, accessKeyId, secretAccessKey);
    if (!res.ok) throw new Error(`S3 list failed (${res.status}): ${await res.text()}`);

    const xml = await res.text();
    const doc = new DOMParser().parseFromString(xml, 'application/xml');

    // Extract object keys
    for (const el of doc.querySelectorAll('Contents > Key')) {
      const key = el.textContent;
      if (key !== PREFIX && key.endsWith('.json')) keys.push(key);
    }

    // Follow pagination
    const truncated = doc.querySelector('IsTruncated')?.textContent;
    continuationToken = truncated === 'true'
      ? doc.querySelector('NextContinuationToken')?.textContent ?? null
      : null;
  } while (continuationToken);

  return keys;
}

/** Fetch and parse a single JSON file from S3, normalising field names. */
async function _fetchJSON(key) {
  const { region, accessKeyId, secretAccessKey } = _creds();
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const url = `${S3_BASE}/${encodedKey}`;
  const res = await sigV4Fetch(url, region, accessKeyId, secretAccessKey);
  if (!res.ok) throw new Error(`S3 get failed for "${key}" (${res.status})`);
  const raw = await res.json();

  // Backend wraps records: { "_meta": {...}, "records": [{...}] }
  // Extract the first (and normally only) record. Fall back to bare object.
  const record = (raw && Array.isArray(raw.records) && raw.records.length > 0)
    ? raw.records[0]
    : raw;

  return normalizeRecord(record);
}

// Session-level cache so page navigation doesn't re-fetch all files every time
let _s3Cache = null;

function _detectCORS(err) {
  // "Failed to fetch" with no HTTP status = browser blocked the request at the CORS
  // preflight stage. S3 must have a CORS rule allowing GET from this origin.
  if (err instanceof TypeError && err.message.toLowerCase().includes('failed to fetch')) {
    throw new Error(
      'S3 CORS not configured — the browser blocked the request before it reached S3. ' +
      'Add a CORS rule to the "transcripts-bot" bucket: AllowedOrigins ["*"], ' +
      'AllowedMethods ["GET"], AllowedHeaders ["*"]. ' +
      'Run: aws s3api put-bucket-cors --bucket transcripts-bot --cors-configuration \'{"CORSRules":[{"AllowedOrigins":["*"],"AllowedMethods":["GET"],"AllowedHeaders":["*"],"MaxAgeSeconds":3600}]}\''
    );
  }
  throw err;
}

async function getAllS3() {
  if (_s3Cache) return _s3Cache;
  if (!BUCKET) throw new Error('VITE_S3_BUCKET is not set — check receptionist-ui/.env');

  const keys = await _listKeys().catch(_detectCORS);
  if (keys.length === 0) return [];

  // Fetch all JSON files in parallel
  const results = await Promise.allSettled(keys.map((k) => _fetchJSON(k).catch(_detectCORS)));

  const records = results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter(Boolean);

  if (results.some((r) => r.status === 'rejected')) {
    console.warn('Some transcription files could not be fetched:',
      results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message));
  }

  _s3Cache = records.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return _s3Cache;
}

async function getByIdS3(id) {
  // Search the full list first (uses cache if available)
  const all = await getAllS3();
  return all.find((r) => r.id === id || r.call_sid === id) ?? null;
}

// The frontend never writes to S3 — persistence is handled by the backend.
async function saveS3() {
  throw new Error('S3 writes are handled by the backend. This service is read-only.');
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const transcriptionService = {
  getAll:  STORAGE === 's3' ? getAllS3   : getAllLocal,
  getById: STORAGE === 's3' ? getByIdS3  : getByIdLocal,
  save:    STORAGE === 's3' ? saveS3     : async (record) => {
    const data = await loadLocalData();
    const idx  = data.records.findIndex((r) => r.id === record.id);
    idx >= 0 ? (data.records[idx] = record) : data.records.push(record);
    return record;
  },

  async getAppointmentTranscripts() {
    const all = await transcriptionService.getAll();
    return all.filter((r) => r.outcome === 'appointment_booked');
  },

  /** Force a fresh S3 fetch on the next getAll() call — call after a new transcription is saved */
  invalidateCache() { _s3Cache = null; },
};
