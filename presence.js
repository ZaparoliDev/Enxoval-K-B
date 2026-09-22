const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'enxoval';
const PRESENCE_COLL = process.env.MONGODB_PRESENCE || 'active_visitors';
const ACTIVE_FOR_MS = 90 * 1000;

let cachedClient = null;

async function connectToDatabase() {
  if (cachedClient) return cachedClient;
  if (!uri) throw new Error('MONGODB_URI não configurado.');
  const client = new MongoClient(uri);
  await client.connect();
  cachedClient = client;
  return client;
}

function visitorId(value) {
  const id = String(value || '');
  return /^[a-zA-Z0-9_-]{16,80}$/.test(id) ? id : null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const collection = (await connectToDatabase()).db(DB_NAME).collection(PRESENCE_COLL);
    const now = new Date();
    if (req.method === 'POST') {
      const id = visitorId(req.body && req.body.id);
      if (!id) return res.status(400).json({ error: 'Identificador de visita inválido.' });
      await collection.updateOne({ _id: id }, { $set: { last_seen: now } }, { upsert: true });
    } else if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Método não permitido.' });
    }

    await collection.deleteMany({ last_seen: { $lt: new Date(now.getTime() - ACTIVE_FOR_MS) } });
    const online = await collection.countDocuments({ last_seen: { $gte: new Date(now.getTime() - ACTIVE_FOR_MS) } });
    return res.status(200).json({ online });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
