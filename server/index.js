require('dotenv').config();
const cors = require('cors');
const express = require('express');
const { MongoClient } = require('mongodb');

const { MONGODB_DB = 'todo', PORT = 4000 } = process.env;
const corsOrigins = process.env.CORS_ORIGINS?.split(',').map((origin) => origin.trim()).filter(Boolean);

// User ids come from the login: "local:<username>:<phone>" or "google:<google user id>".
const USER_ID_PATTERN = /^(local|google):[A-Za-z0-9:._-]{1,128}$/;
const SESSION_MODES = ['create', 'signin', 'upsert'];

let clientPromise;

const app = express();
app.use(cors(corsOrigins?.length ? { origin: corsOrigins } : undefined));
app.use(express.json({ limit: '1mb' }));

function getUsersCollection() {
  const { MONGODB_URI } = process.env;
  if (!MONGODB_URI) {
    throw new Error('Missing MONGODB_URI. Set it in the server environment.');
  }

  if (!clientPromise) {
    const client = new MongoClient(MONGODB_URI);
    clientPromise = client.connect()
      .then(() => client)
      .catch((error) => {
        clientPromise = undefined;
        throw error;
      });
  }

  return clientPromise.then((client) => client.db(process.env.MONGODB_DB || MONGODB_DB).collection('users'));
}

function toPublicUser({ _id, ...user }) {
  return { id: _id, ...user };
}

function cleanProfile(profile = {}) {
  const text = (value) => (typeof value === 'string' ? value.trim().slice(0, 120) : undefined);
  return Object.fromEntries(
    Object.entries({ username: text(profile.username), phone: text(profile.phone), email: text(profile.email) })
      .filter(([, value]) => value !== undefined),
  );
}

app.get('/health', (_req, res) => res.json({ ok: true }));

// Starts a session for a user.
// create: the account must not exist yet. signin: it must exist. upsert: create or update (Google, restoring a session).
app.post('/api/session', async (req, res) => {
  const { id, mode, profile } = req.body ?? {};
  if (typeof id !== 'string' || !USER_ID_PATTERN.test(id) || !SESSION_MODES.includes(mode)) {
    return res.status(400).json({ error: 'Invalid sign-in request.' });
  }

  const users = await getUsersCollection();
  const now = new Date();
  const existing = await users.findOne({ _id: id });

  if (mode === 'signin' && !existing) {
    return res.status(404).json({ error: 'No account matches that user name and phone number. Create an account first.' });
  }
  if (mode === 'create' && existing) {
    return res.status(409).json({ error: 'An account with that user name and phone number already exists. Sign in instead.' });
  }

  if (existing) {
    const update = { ...(mode === 'upsert' ? cleanProfile(profile) : {}), lastLoginAt: now };
    const user = await users.findOneAndUpdate({ _id: id }, { $set: update }, { returnDocument: 'after' });
    return res.json(toPublicUser(user));
  }

  const user = { _id: id, provider: id.split(':')[0], ...cleanProfile(profile), tasks: [], createdAt: now, lastLoginAt: now };
  await users.insertOne(user);
  return res.status(201).json(toPublicUser(user));
});

app.get('/api/users/:id', async (req, res) => {
  const users = await getUsersCollection();
  const user = await users.findOne({ _id: req.params.id });
  if (!user) return res.status(404).json({ error: 'User not found.' });
  return res.json(toPublicUser(user));
});

app.put('/api/users/:id/tasks', async (req, res) => {
  const { tasks } = req.body ?? {};
  if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks must be an array.' });
  const users = await getUsersCollection();
  const result = await users.updateOne({ _id: req.params.id }, { $set: { tasks, updatedAt: new Date() } });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'User not found.' });
  return res.json({ ok: true });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Server error. Please try again.' });
});

module.exports = app;

if (require.main === module) {
  getUsersCollection().then(() => {
    app.listen(Number(PORT), '0.0.0.0', () => console.log(`Todo API listening on port ${PORT}`));
  }).catch((error) => {
    console.error('Could not connect to MongoDB:', error.message);
    process.exit(1);
  });
}
