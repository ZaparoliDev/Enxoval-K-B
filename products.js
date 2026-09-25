const { MongoClient } = require('mongodb');
const { verifyToken } = require('./auth');

const uri = process.env.MONGODB_URI;
const DB_NAME       = process.env.MONGODB_DB          || 'enxoval';
const PRODUCTS_COLL = process.env.MONGODB_PRODUCTS    || 'products';
const CLAIMED_COLL  = process.env.MONGODB_CLAIMED     || 'claimed_items';

// Itens iniciais adicionados na segunda versão da lista. A semeadura é idempotente:
// nomes que já existirem no Atlas não são duplicados.
const INITIAL_PRODUCTS = [
  { id: 6,  name: 'Micro-ondas', categoria: 'cozinha', emoji: '📡' },
  { id: 7,  name: 'Forno elétrico', categoria: 'cozinha', emoji: '🔥' },
  { id: 8,  name: 'Sanduicheira', categoria: 'cozinha', emoji: '🥪' },
  { id: 9,  name: 'Pipoqueira elétrica', categoria: 'cozinha', emoji: '🍿' },
  { id: 10, name: 'Jogo de jantar', categoria: 'cozinha', emoji: '🍽️' },
  { id: 11, name: 'Jogo de copos grande', categoria: 'cozinha', emoji: '🥛' },
  { id: 12, name: 'Panela de pressão 2 litros', categoria: 'cozinha', emoji: '🍲' },
  { id: 13, name: 'Panela de pressão 4 litros', categoria: 'cozinha', emoji: '🍲' },
  { id: 14, name: 'Omeleteira elétrica', categoria: 'cozinha', emoji: '🍳' },
  { id: 15, name: 'Varal de parede em alumínio — 1,20 m', categoria: 'servico', emoji: '👕' },
  { id: 16, name: 'Porta-tempero giratório de alumínio', categoria: 'cozinha', emoji: '🧂' },
  { id: 17, name: 'Fatiador profissional 16 em 1', categoria: 'cozinha', emoji: '🔪' },
  { id: 18, name: 'Jogo americano decorado', categoria: 'deco', emoji: '🍽️' },
  { id: 19, name: 'Chaleira elétrica', categoria: 'cozinha', emoji: '🫖' },
  { id: 20, name: 'Batedeira', categoria: 'cozinha', emoji: '🥣' },
  { id: 21, name: 'Kit de fouet', categoria: 'cozinha', emoji: '🥄' },
  { id: 22, name: 'Kit de colheres de silicone', categoria: 'cozinha', emoji: '🥄' },
  { id: 23, name: 'Kit de talheres', categoria: 'cozinha', emoji: '🍴' },
  { id: 24, name: 'Boleira de vidro', categoria: 'deco', emoji: '🎂' },
  { id: 25, name: 'Kit de toalha de mesa', categoria: 'deco', emoji: '🧺' }
];

let cachedClient = null;

async function connectToDatabase() {
  if (cachedClient) return cachedClient;
  const client = new MongoClient(uri);
  await client.connect();
  cachedClient = client;
  return client;
}

function normalizarNome(nome) {
  return String(nome || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

async function semearItensIniciais(collection, products) {
  const nomesExistentes = new Set(products.map(product => normalizarNome(product.name || product.nome)));
  const faltantes = INITIAL_PRODUCTS
    .filter(product => !nomesExistentes.has(normalizarNome(product.name)))
    .map(product => ({ ...product, created_at: new Date() }));

  if (faltantes.length) await collection.insertMany(faltantes);
  return [...products, ...faltantes];
}

async function corrigirProdutosExistentes(collection) {
  // Corrige o item já criado na versão anterior, sem exigir edição manual no Atlas.
  await collection.updateMany(
    { $or: [{ name: 'Omeleteira elétrica — 2 unidades' }, { nome: 'Omeleteira elétrica — 2 unidades' }] },
    { $set: { name: 'Omeleteira elétrica' } }
  );
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const client = await connectToDatabase();
    const db = client.db(DB_NAME);

    // ─────────────────────────────────────────────────────────────
    // GET — lista os produtos cruzando com os itens já reservados
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const collection = db.collection(PRODUCTS_COLL);
      await corrigirProdutosExistentes(collection);
      let products = await collection.find({}).toArray();
      products = await semearItensIniciais(collection, products);
      const claimedItems = await db.collection(CLAIMED_COLL).find({}).toArray();

      const claimedIds = new Set(claimedItems.map(item => String(item.item_id).trim()));

      const productsWithStatus = products.map(product => {
        const id = product.id || product.item_id || product._id;
        return { ...product, id, isClaimed: claimedIds.has(String(id).trim()) };
      });

      productsWithStatus.sort((a, b) => Number(a.id) - Number(b.id));
      return res.status(200).json(productsWithStatus);
    }

    // ─────────────────────────────────────────────────────────────
    // PUT — troca/remove foto e link de referência de um item (somente admin)
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'PUT') {
      if (!verifyToken(req.headers['x-admin-token'])) {
        return res.status(401).json({ error: 'Sessão de admin inválida ou expirada.' });
      }

      const { item_id, imagem, link } = req.body || {};
      const alteraImagem = typeof imagem === 'string';
      const alteraLink = typeof link === 'string';
      if (!item_id || (!alteraImagem && !alteraLink)) {
        return res.status(400).json({ error: 'Informe o item e a foto ou o link de referência.' });
      }

      const foto = alteraImagem ? imagem.trim() : undefined;
      const url = alteraLink ? link.trim() : undefined;
      const fotoValida = foto === '' || /^data:image\/(jpeg|png|webp);base64,[a-z0-9+/=\s]+$/i.test(foto);
      if (alteraImagem && (!fotoValida || foto.length > 3000000)) {
        return res.status(400).json({ error: 'Use uma foto JPG, PNG ou WebP de até 2 MB.' });
      }
      if (alteraLink && url && !/^https?:\/\/\S+$/i.test(url)) {
        return res.status(400).json({ error: 'Use um link começando por http:// ou https://.' });
      }

      const itemQuery = {
        $or: [
          { id: Number(item_id) }, { id: String(item_id) },
          { item_id: Number(item_id) }, { item_id: String(item_id) }
        ]
      };
      const set = { updated_at: new Date() };
      const unset = {};
      if (alteraImagem) {
        if (foto) set.imagem = foto;
        else { unset.imagem = ''; unset.image = ''; }
      }
      if (alteraLink) {
        if (url) set.link = url;
        else { unset.link = ''; unset.url = ''; }
      }
      const update = { $set: set };
      if (Object.keys(unset).length) update.$unset = unset;
      const resultado = await db.collection(PRODUCTS_COLL).updateOne(itemQuery, update);

      if (!resultado.matchedCount) return res.status(404).json({ error: 'Item não encontrado.' });
      return res.status(200).json({ success: true, imagem: foto || null, link: url || null });
    }

    // ─────────────────────────────────────────────────────────────
    // POST — reserva de item (público) ou liberar/marcar (admin)
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { item_id, toggleAdmin } = req.body || {};

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

      // Reserva comum: só marca o que ainda está livre, nunca desmarca
      const alreadyClaimed = await db.collection(CLAIMED_COLL).findOne(query);
      if (alreadyClaimed) {
        return res.status(200).json({ success: true, alreadyClaimed: true, message: 'Item já estava reservado.' });
      }

      await db.collection(CLAIMED_COLL).insertOne({ item_id, claimed_at: new Date() });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Método não permitido.' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
