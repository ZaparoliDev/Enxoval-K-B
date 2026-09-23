const { MongoClient } = require('mongodb');
const { verifyToken } = require('./auth');

const uri = process.env.MONGODB_URI;
const DB_NAME       = process.env.MONGODB_DB          || 'enxoval';
const PRODUCTS_COLL = process.env.MONGODB_PRODUCTS    || 'products';
const CLAIMED_COLL  = process.env.MONGODB_CLAIMED     || 'claimed_items';

let cachedClient = null;

async function connectToDatabase() {
  if (cachedClient) return cachedClient;
  const client = new MongoClient(uri);
  await client.connect();
  cachedClient = client;
  return client;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const client = await connectToDatabase();
    const db = client.db(DB_NAME);

    // ─────────────────────────────────────────────────────────────
    // GET — lista os produtos cruzando com os itens já reservados
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const products     = await db.collection(PRODUCTS_COLL).find({}).toArray();
      const claimedItems = await db.collection(CLAIMED_COLL).find({}).toArray();

      const claimedById = new Map(claimedItems.map(item => [String(item.item_id).trim(), item]));
      const isAdmin = verifyToken(req.headers['x-admin-token']);

      const productsWithStatus = products.map(product => {
        const id = product.id || product.item_id || product._id;
        const claimed = claimedById.get(String(id).trim());
        const base = { ...product, id, isClaimed: !!claimed };
        // O nome de quem presenteou só é exposto para admins autenticados.
        if (isAdmin && claimed) {
          base.doadorNome = claimed.doador_nome || null;
          base.claimedAt = claimed.claimed_at || null;
        }
        return base;
      });

      productsWithStatus.sort((a, b) => Number(a.id) - Number(b.id));
      return res.status(200).json(productsWithStatus);
    }

    // ─────────────────────────────────────────────────────────────
    // POST — reserva de item (público) ou liberar/marcar (admin)
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { item_id, toggleAdmin, doador_nome } = req.body || {};

      if (!item_id) {
        return res.status(400).json({ error: 'O item_id é obrigatório.' });
      }

      const query = {
        $or: [{ item_id: Number(item_id) }, { item_id: String(item_id) }]
      };

      if (toggleAdmin) {
        // Ação administrativa: exige token válido emitido por /api/auth
        if (!verifyToken(req.headers['x-admin-token'])) {
          return res.status(401).json({ error: 'Sessão de admin inválida ou expirada.' });
        }

        const alreadyClaimed = await db.collection(CLAIMED_COLL).findOne(query);
        if (alreadyClaimed) {
          await db.collection(CLAIMED_COLL).deleteOne({ _id: alreadyClaimed._id });
          return res.status(200).json({ success: true, message: 'Item liberado.' });
        }
        await db.collection(CLAIMED_COLL).insertOne({ item_id, claimed_at: new Date() });
        return res.status(200).json({ success: true, message: 'Item marcado.' });
      }

      // Reserva comum: só marca o que ainda está livre, nunca desmarca.
      // O nome de quem presenteou é opcional, mas quando enviado fica
      // guardado só para o painel admin — nunca aparece no mural público.
      const nomeLimpo = typeof doador_nome === 'string' ? doador_nome.trim().slice(0, 80) : '';

      const alreadyClaimed = await db.collection(CLAIMED_COLL).findOne(query);
      if (alreadyClaimed) {
        return res.status(200).json({ success: true, message: 'Item já estava reservado.' });
      }

      await db.collection(CLAIMED_COLL).insertOne({
        item_id,
        claimed_at: new Date(),
        doador_nome: nomeLimpo || null
      });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Método não permitido.' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
