const { MongoClient } = require('mongodb');

let client;
async function getMongoClient() {
  if (!client) {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
  }
  return client;
}

async function getMongoCollection(collectionName) {
  const client = await getMongoClient();
  const db = client.db(process.env.MONGO_DB_NAME);
  return db.collection(collectionName);
}

module.exports = { getMongoCollection };
