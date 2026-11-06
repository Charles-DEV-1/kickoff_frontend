import { KICKOFF_CONFIG } from './config.js';

let supabaseClientPromise;

async function getSupabase() {
  if (!supabaseClientPromise) {
    supabaseClientPromise = import('https://esm.sh/@supabase/supabase-js@2')
      .then(({ createClient }) => createClient(
        KICKOFF_CONFIG.SUPABASE_URL,
        KICKOFF_CONFIG.SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
      ))
      .catch(() => {
        supabaseClientPromise = null;
        throw new Error('The sign-in service could not load. Check your internet connection and refresh.');
      });
  }
  return supabaseClientPromise;
}

export async function currentSession() {
  const supabase = await getSupabase();
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

function clearCachedAccountData() {
  try {
    const local = JSON.parse(localStorage.getItem('kickoff.v1') || '{}');
    local.cloudEmail = '';
    local.tasks = [];
    local.activeTaskId = null;
    local.activeStepId = null;
    local.timer = null;
    local.points = 0;
    local.plant = 0;
    local.streak = 0;
    local.guestTasksPendingSync = !!local.guestTasksBackup?.length;
    localStorage.setItem('kickoff.v1', JSON.stringify(local));
  } catch {}
}

function clearPrivateSessionCache() {
  sessionStorage.removeItem('kickoff.bootstrap');
  sessionStorage.removeItem('kickoff.tasks.next_since');
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith('kickoff.bootstrap.')) sessionStorage.removeItem(key);
  }
}

export async function sendMagicLink(email) {
  const supabase = await getSupabase();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: new URL('account-sync.html', location.href).href }
  });
  if (error) throw error;
}

export async function signOut() {
  const supabase = await getSupabase();
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  clearPrivateSessionCache();
  localStorage.removeItem('kickoff.dashboard.pending');
  localStorage.removeItem('kickoff.returnTo');
  sessionStorage.removeItem('kickoff.tasks.next_since');
}

export async function apiRequest(path, { method = 'GET', body, idempotency = false, idempotencyKey, headers = {} } = {}) {
  const supabase = await getSupabase();
  let session = await currentSession();
  if (!session) throw new Error('Please sign in to use cloud sync.');
  const requestHeaders = { Accept: 'application/json', Authorization: `Bearer ${session.access_token}`, ...headers };
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  let retrySlot = null;
  if (idempotency) {
    if (!idempotencyKey) {
      const raw = `${method}:${path}:${JSON.stringify(body)}`;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
      const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      retrySlot = `kickoff.idempotency.${fingerprint}`;
      idempotencyKey = sessionStorage.getItem(retrySlot) || crypto.randomUUID();
      sessionStorage.setItem(retrySlot, idempotencyKey);
    }
    requestHeaders['Idempotency-Key'] = idempotencyKey;
  }
  const send = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetch(`${KICKOFF_CONFIG.API_BASE_URL}${path}`, {
          method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body)
        });
      } catch (error) {
        if (attempt >= 2 || (!idempotency && method !== 'GET')) {
          const networkError = new Error('The API request could not reach the server.');
          networkError.name = 'ApiNetworkError';
          networkError.code = 'network_error';
          networkError.cause = error;
          networkError.method = method;
          networkError.path = path;
          throw networkError;
        }
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  };
  let response = await send();
  if (response.status === 401) {
    let initialAuthError = null;
    try { initialAuthError = await response.clone().json(); } catch {}
    if (initialAuthError?.error?.code === 'account_deleted') {
      if (retrySlot) sessionStorage.removeItem(retrySlot);
      try { await supabase.auth.signOut(); } catch {}
      clearCachedAccountData();
      localStorage.removeItem('kickoff.v1');
      clearPrivateSessionCache();
      localStorage.removeItem('kickoff.returnTo');
      location.replace('account-deleted.html');
      throw new Error(initialAuthError.error.message || 'This account is no longer active.');
    }
    const { data, error } = await supabase.auth.refreshSession();
    if (error || !data.session) {
      if (retrySlot) sessionStorage.removeItem(retrySlot);
      try { await supabase.auth.signOut(); } catch {}
      clearCachedAccountData();
      clearPrivateSessionCache();
      if (location.pathname.split('/').pop() !== 'account-sync.html') {
        localStorage.setItem('kickoff.returnTo', location.pathname + location.search);
        localStorage.setItem('kickoff.dashboard.pending', '1');
        location.replace('account-sync.html');
      }
      throw new Error('Your session expired. Please sign in again.');
    }
    requestHeaders.Authorization = `Bearer ${data.session.access_token}`;
    response = await send();
  }
  if (!response.ok) {
    if (retrySlot && response.status < 500 && response.status !== 409) sessionStorage.removeItem(retrySlot);
    let payload = {};
    try { payload = await response.json(); } catch {}
    const message = payload?.error?.message || `Request failed (${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    error.code = payload?.error?.code;
    error.requestId = payload?.error?.request_id || response.headers.get('X-Request-Id');
    error.retryAfter = response.headers.get('Retry-After');
    if (response.status === 401) {
      const deleted = error.code === 'account_deleted';
      try { await supabase.auth.signOut(); } catch {}
      clearCachedAccountData();
      clearPrivateSessionCache();
      localStorage.removeItem('kickoff.dashboard.pending');
      if (deleted) {
        localStorage.removeItem('kickoff.v1');
        localStorage.removeItem('kickoff.returnTo');
        location.replace('account-deleted.html');
      } else if (location.pathname.split('/').pop() !== 'account-sync.html') {
        localStorage.setItem('kickoff.returnTo', location.pathname + location.search);
        localStorage.setItem('kickoff.dashboard.pending', '1');
        location.replace('account-sync.html');
      }
    }
    throw error;
  }
  if (response.status === 204) {
    if (retrySlot) sessionStorage.removeItem(retrySlot);
    return null;
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    const error = new Error('The API returned an invalid JSON response.');
    error.status = response.status;
    error.code = 'invalid_api_response';
    error.requestId = response.headers.get('X-Request-Id');
    throw error;
  }
  if (retrySlot) sessionStorage.removeItem(retrySlot);
  return payload;
}

export async function publicRequest(path, { headers = {}, cacheKey } = {}) {
  let cached = null;
  if (cacheKey) { try { cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null'); } catch {} }
  const requestHeaders = { Accept: 'application/json', ...headers };
  if (cached?.etag) requestHeaders['If-None-Match'] = cached.etag;
  const response = await fetch(`${KICKOFF_CONFIG.API_BASE_URL}${path}`, { headers: requestHeaders });
  if (response.status === 304 && cached?.body) return cached.body;
  if (!response.ok) {
    let payload = {}; try { payload = await response.json(); } catch {}
    const error = new Error(payload?.error?.message || `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = payload?.error?.code;
    error.requestId = payload?.error?.request_id || response.headers.get('X-Request-Id');
    error.retryAfter = response.headers.get('Retry-After');
    throw error;
  }
  const body = await response.json();
  if (cacheKey) { try { sessionStorage.setItem(cacheKey, JSON.stringify({ etag: response.headers.get('ETag'), body })); } catch {} }
  return body;
}

export async function listAllTasks() {
  const items = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({ status: 'all', limit: '50' });
    if (cursor) query.set('cursor', cursor);
    const page = await apiRequest(`/v1/tasks?${query}`);
    items.push(...(page.items || page.tasks || []));
    cursor = page.next_cursor || null;
  } while (cursor);
  return items;
}

export async function syncTaskDelta(updatedSince) {
  const items = [];
  let cursor = null;
  let snapshotAt = null;
  let nextSince = null;
  let fullRefreshRequired = false;
  do {
    const query = new URLSearchParams({ status: 'all', limit: '50', updated_since: updatedSince });
    if (cursor) { query.set('cursor', cursor); if (snapshotAt) query.set('snapshot_at', snapshotAt); }
    const page = await apiRequest(`/v1/tasks?${query}`);
    if (page.full_refresh_required) { fullRefreshRequired = true; nextSince = page.next_since || page.server_time; break; }
    items.push(...(page.items || []));
    snapshotAt = page.snapshot_at || snapshotAt;
    nextSince = page.next_since || nextSince;
    cursor = page.next_cursor || null;
  } while (cursor);
  return { items, nextSince, fullRefreshRequired };
}

export async function getBootstrap() {
  const session = await currentSession();
  if (!session) return null;
  const cacheKey = `kickoff.bootstrap.${session.user.id}`;
  let cached = null;
  try { cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null'); } catch {}
  const headers = cached?.etag ? { 'If-None-Match': cached.etag } : {};
  const response = await fetch(`${KICKOFF_CONFIG.API_BASE_URL}/v1/bootstrap`, { headers: { ...headers, Authorization: `Bearer ${session.access_token}`, Accept: 'application/json' } });
  if (response.status === 304 && cached?.body) return cached.body;
  if (response.status === 401) return apiRequest('/v1/bootstrap');
  if (!response.ok) {
    let payload = {}; try { payload = await response.json(); } catch {}
    throw new Error(payload?.error?.message || `Could not load your cloud data (${response.status}).`);
  }
  const data = await response.json();
  try { sessionStorage.setItem(cacheKey, JSON.stringify({ etag: response.headers.get('ETag'), body: data })); } catch {}
  return data;
}

export function toLocalTask(task) {
  return {
    id: task.id, title: task.title, notes: task.notes || '', type: task.source || 'Task', source: task.source,
    template_id: task.template_id, version: task.version, created: Date.parse(task.created_at) || Date.now(),
    done: task.status === 'completed', status: task.status || 'active', due_at: task.due_at || null, isCourse: false,
    steps: (task.steps || []).map(step => ({
      id: step.id, title: step.text, mins: step.planned_minutes, done: step.status === 'completed',
      started: step.status === 'started' || !!step.started_at, status: step.status, version: step.version, position: step.position,
      actual_minutes: step.actual_minutes
    }))
  };
}

export async function downloadMyExport() {
  const supabase = await getSupabase();
  let session = await currentSession();
  if (!session) throw new Error('Please sign in before exporting your account data.');
  let response = await fetch(`${KICKOFF_CONFIG.API_BASE_URL}/v1/me/export`, {
    headers: { Authorization: `Bearer ${session.access_token}`, Accept: 'application/json' }
  });
  if (response.status === 401) {
    let authError = null;
    try { authError = await response.clone().json(); } catch {}
    if (authError?.error?.code === 'account_deleted') {
      try { await supabase.auth.signOut(); } catch {}
      localStorage.removeItem('kickoff.v1');
      clearPrivateSessionCache();
      location.replace('account-deleted.html');
      throw new Error(authError.error.message || 'This account is no longer active.');
    }
    const refreshed = await supabase.auth.refreshSession();
    session = refreshed.data?.session;
    if (refreshed.error || !session) {
      try { await supabase.auth.signOut(); } catch {}
      clearCachedAccountData();
      clearPrivateSessionCache();
      if (location.pathname.split('/').pop() !== 'account-sync.html') {
        localStorage.setItem('kickoff.returnTo', location.pathname + location.search);
        localStorage.setItem('kickoff.dashboard.pending', '1');
        location.replace('account-sync.html');
      }
      throw new Error('Your session expired. Please sign in again.');
    }
    response = await fetch(`${KICKOFF_CONFIG.API_BASE_URL}/v1/me/export`, {
      headers: { Authorization: `Bearer ${session.access_token}`, Accept: 'application/json' }
    });
  }
  if (!response.ok) {
    let payload = {}; try { payload = await response.json(); } catch {}
    if (response.status === 401) {
      const deleted = payload?.error?.code === 'account_deleted';
      try { await supabase.auth.signOut(); } catch {}
      clearCachedAccountData();
      clearPrivateSessionCache();
      if (deleted) {
        localStorage.removeItem('kickoff.v1');
        localStorage.removeItem('kickoff.returnTo');
        location.replace('account-deleted.html');
      } else if (location.pathname.split('/').pop() !== 'account-sync.html') {
        localStorage.setItem('kickoff.returnTo', location.pathname + location.search);
        localStorage.setItem('kickoff.dashboard.pending', '1');
        location.replace('account-sync.html');
      }
    }
    throw new Error(payload?.error?.message || `Export failed (${response.status}).`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') || '';
  const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || 'kickoff-account-export.json';
  return { blob, filename };
}
