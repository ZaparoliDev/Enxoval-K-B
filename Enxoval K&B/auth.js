const crypto = require('crypto');

/**
 * Autenticação do painel admin.
 * A senha NUNCA vai para o front-end. Ela vive apenas em process.env.ADMIN_PASSWORD.
 *
 * Fluxo:
 *   POST /api/auth  { password }  ->  { token, expiresAt }
 *   O token é assinado com HMAC-SHA256 (ADMIN_SECRET) e tem validade de 6h.
 *   O front guarda o token em sessionStorage e envia no header x-admin-token.
 */

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas
const MAX_ATTEMPTS  = 6;                 // por janela
const WINDOW_MS     = 10 * 60 * 1000;    // 10 minutos

// Throttle em memória. Some a cada cold start da Vercel, mas já corta
// ataques de força bruta rápidos vindos do mesmo IP.
const attempts = new Map();

function getSecret() {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) throw new Error('ADMIN_SECRET não configurado.');
  return secret;
}

function sign(payload) {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

function issueToken() {
  const exp = Date.now() + TOKEN_TTL_MS;
  return { token: `${exp}.${sign(String(exp))}`, expiresAt: exp };
}

/** Usado também pelo products.js */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [expRaw, sig] = token.split('.');
  if (!expRaw || !sig) return false;

  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;

  const expected = sign(expRaw);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function safeEquals(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : (fwd || '')).split(',')[0].trim() || 'desconhecido';
}

function tooManyAttempts(key) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.start > WINDOW_MS) {
    attempts.set(key, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  try {
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected) return res.status(500).json({ error: 'ADMIN_PASSWORD não configurado.' });

    const key = clientKey(req);
    if (tooManyAttempts(key)) {
      return res.status(429).json({ error: 'Muitas tentativas. Espere alguns minutos.' });
    }

    const { password } = req.body || {};
    if (!password || !safeEquals(password, expected)) {
      // Atraso curto para desencorajar tentativas automatizadas
      await new Promise(r => setTimeout(r, 600));
      return res.status(401).json({ error: 'Senha incorreta.' });
    }

    attempts.delete(key);
    return res.status(200).json(issueToken());
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

module.exports.verifyToken = verifyToken;
