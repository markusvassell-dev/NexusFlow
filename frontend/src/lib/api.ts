// Tiny typed fetch wrapper. Cookies carry the session JWT; a 401 kicks the
// user to /login, a 409 surfaces the saga's concurrency conflicts.

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  if (res.status === 401 && !path.startsWith('/api/auth')) {
    window.location.assign('/login');
    throw new ApiError(401, 'unauthenticated', 'Session expired');
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, string> & T;
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body)
};
