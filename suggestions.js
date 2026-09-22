const { MongoClient, ObjectId } = require('mongodb');
const { verifyToken } = require('./auth');

const uri = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'enxoval';
const SUGGESTIONS_COLL = process.env.MONGODB_SUGGESTIONS || 'suggestions';
const MAX_ATTEMPTS = 3;
const WINDOW_MS = 30 * 60 * 1000;
const STATUSES = ['new', 'reviewing', 'planned', 'in_progress', 'completed'];

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

function publicSuggestion(item) {
  return {
    nome: item.nome || '',
    titulo: item.titulo,
    mensagem: item.mensagem,
    status: STATUSES.includes(item.status) ? item.status : 'new',
    resposta: item.resposta || '',
    created_at: item.created_at,
    updated_at: item.updated_at || item.created_at
  };
}

function adminSuggestion(item) {
  return { id: String(item._id), ...publicSuggestion(item) };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
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
      const titulo = clean(req.body && req.body.titulo, 120);
      const mensagem = clean(req.body && req.body.mensagem, 1200);
      if (!titulo || mensagem.length < 10) {
        return res.status(400).json({ error: 'Informe um assunto e uma sugestão com pelo menos 10 caracteres.' });
      }

      const now = new Date();
      const suggestion = { nome, titulo, mensagem, status: 'new', resposta: '', created_at: now, updated_at: now };
      await collection.insertOne(suggestion);
      return res.status(201).json(publicSuggestion(suggestion));
    }

    const isAdmin = verifyToken(req.headers['x-admin-token']);

    if (req.method === 'GET' && isAdmin) {
      const suggestions = await collection.find({}).sort({ updated_at: -1, created_at: -1 }).limit(100).toArray();
      return res.status(200).json(suggestions.map(adminSuggestion));
    }

    if (req.method === 'GET') {
      const suggestions = await collection.find({}).sort({ updated_at: -1, created_at: -1 }).limit(100).toArray();
      return res.status(200).json(suggestions.map(publicSuggestion));
    }

    if (!isAdmin) return res.status(401).json({ error: 'Sessão de admin inválida ou expirada.' });

    if (req.method === 'PUT') {
      const id = req.body && req.body.id;
      const status = req.body && req.body.status;
      const resposta = clean(req.body && req.body.resposta, 1200);
      if (!ObjectId.isValid(id) || !STATUSES.includes(status)) {
        return res.status(400).json({ error: 'Sugestão ou status inválido.' });
      }
      const result = await collection.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: { status, resposta, updated_at: new Date() } },
        { returnDocument: 'after' }
      );
      if (!result) return res.status(404).json({ error: 'Sugestão não encontrada.' });
      return res.status(200).json(adminSuggestion(result));
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
