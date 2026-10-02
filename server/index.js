require('dotenv').config();
const cors = require('cors');
const express = require('express');
const { MongoClient } = require('mongodb');

const { MONGODB_URI, MONGODB_DB = 'todo', PORT = 4000 } = process.env;
if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI. Copy server/.env.example to server/.env and paste your Atlas connection string.');
  process.exit(1);
}

// User ids come from the login: "local:<username>:<phone>" or "google:<google user id>".
const USER_ID_PATTERN = /^(local|google):[A-Za-z0-9:._-]{1,128}$/;
const SESSION_MODES = ['create', 'signin', 'upsert'];

const client = new MongoClient(MONGODB_URI);
let users;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

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
  const user = await users.findOne({ _id: req.params.id });
  if (!user) return res.status(404).json({ error: 'User not found.' });
  return res.json(toPublicUser(user));
});

app.put('/api/users/:id/tasks', async (req, res) => {
  const { tasks } = req.body ?? {};
  if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks must be an array.' });
  const result = await users.updateOne({ _id: req.params.id }, { $set: { tasks, updatedAt: new Date() } });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'User not found.' });
  return res.json({ ok: true });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Server error. Please try again.' });
});

client.connect().then(() => {
  users = client.db(MONGODB_DB).collection('users');
  app.listen(Number(PORT), '0.0.0.0', () => console.log(`Todo API listening on port ${PORT}`));
}).catch((error) => {
  console.error('Could not connect to MongoDB Atlas:', error.message);
  process.exit(1);
});
