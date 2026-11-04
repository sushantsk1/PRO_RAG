const ROOT = '/api/v1';

export class ApiError extends Error {
  constructor(message, code, status, details = {}, requestId = '') {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.requestId = requestId;
  }
}

export async function api(path, options = {}) {
  const { body, ...rest } = options;
  const isForm = body instanceof FormData;
  let response;
  try {
    response = await fetch(`${ROOT}${path}`, {
      ...rest,
      headers: {
        ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
        ...(rest.headers || {})
      },
      body: body == null ? undefined : isForm ? body : JSON.stringify(body)
    });
  } catch {
    throw new ApiError('Cannot reach the local API. Start the backend and try again.', 'NETWORK_ERROR', 0);
  }
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = payload?.error || {};
    throw new ApiError(
      problem.message || `Request failed (HTTP ${response.status}).`,
      problem.code || 'REQUEST_FAILED',
      response.status,
      problem.details || {},
      problem.requestId || ''
    );
  }
  return payload;
}

export function queryString(params) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') q.set(key, String(value));
  });
  const s = q.toString();
  return s ? `?${s}` : '';
}
