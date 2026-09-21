const { MongoClient, ObjectId } = require('mongodb');
const { verifyToken } = require('./auth');

const uri = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'enxoval';
const SUGGESTIONS_COLL = process.env.MONGODB_SUGGESTIONS || 'suggestions';
const MAX_ATTEMPTS = 3;
const WINDOW_MS = 30 * 60 * 1000;

let cachedClient = null;
const attempts = new Map();

async function connectToDatabase() {
  if (cachedClient) return cachedClient;
  if (!uri) throw new Error('MONGODB_URI não configurado.');
  const client = new MongoClient(uri);
  await client.connect();
  cachedClient = client;
  return client;
}

function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : (fwd || '')).split(',')[0].trim() || 'desconhecido';
}

function rateLimited(key) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.start > WINDOW_MS) {
    attempts.set(key, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

function clean(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const client = await connectToDatabase();
    const collection = client.db(DB_NAME).collection(SUGGESTIONS_COLL);

    if (req.method === 'POST') {
      if (req.body && req.body.website) return res.status(200).json({ success: true });
      if (rateLimited(clientKey(req))) {
        return res.status(429).json({ error: 'Limite de sugestões atingido. Tente novamente mais tarde.' });
      }

      const nome = clean(req.body && req.body.nome, 60);
      const mensagem = clean(req.body && req.body.mensagem, 500);
      if (mensagem.length < 10) {
        return res.status(400).json({ error: 'Escreva uma sugestão com pelo menos 10 caracteres.' });
      }

      await collection.insertOne({ nome, mensagem, created_at: new Date() });
      return res.status(201).json({ success: true });
    }

    if (!verifyToken(req.headers['x-admin-token'])) {
      return res.status(401).json({ error: 'Sessão de admin inválida ou expirada.' });
    }

    if (req.method === 'GET') {
      const suggestions = await collection.find({}).sort({ created_at: -1 }).limit(100).toArray();
      return res.status(200).json(suggestions.map(item => ({
        id: String(item._id),
        nome: item.nome || '',
        mensagem: item.mensagem,
        created_at: item.created_at
      })));
    }

    if (req.method === 'DELETE') {
      const id = req.body && req.body.id;
      if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Sugestão inválida.' });
      await collection.deleteOne({ _id: new ObjectId(id) });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Método não permitido.' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
