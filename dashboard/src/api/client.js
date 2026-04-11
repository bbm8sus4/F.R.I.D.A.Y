const ALLOWED_ORIGINS = [
  "https://my-ai-bot.friday-bot.workers.dev",
  "https://daisy-ai-bot.friday-bot.workers.dev",
  "https://sigma-ai-bot.friday-bot.workers.dev",
];

function getSafeApiBase() {
  const param = new URLSearchParams(window.location.search).get("api");
  if (param && ALLOWED_ORIGINS.indexOf(param) !== -1) return param;
  const envUrl = import.meta.env.VITE_API_URL || "";
  if (envUrl && ALLOWED_ORIGINS.indexOf(envUrl) !== -1) return envUrl;
  return ALLOWED_ORIGINS[0];
}

const API_BASE = getSafeApiBase();

function getInitData() {
  return window.Telegram?.WebApp?.initData || "";
}

export async function apiFetch(path, options = {}) {
  const initData = getInitData();
  const base = options.baseUrl && ALLOWED_ORIGINS.includes(options.baseUrl) ? options.baseUrl : API_BASE;
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}
