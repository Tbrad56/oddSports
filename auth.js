// Single-user credential store: a password (scrypt-hashed, never stored
// plaintext) plus zero or more WebAuthn platform credentials (Face ID /
// Touch ID / Windows Hello). Persisted as one JSON file on the same dataDir
// volume store.js already uses, so it survives Railway redeploys.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createAuthStore({ dataDir } = {}){
  const file = dataDir ? path.join(dataDir, 'auth.json') : null;
  let data = { username: null, passwordSalt: null, passwordHash: null, webauthnCredentials: [] };

  if (file) {
    try {
      if (fs.existsSync(file)) {
        data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      }
    } catch (e) {
      console.error(`auth: load failed (${e.message}) — starting unconfigured`);
    }
  }

  function persist(){
    if (!file) return; // memory-only (tests, or no volume mounted)
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error(`auth: write failed (${e.message}) — continuing in-memory only`);
    }
  }

  function hasCredentials(){
    return !!(data.username && data.passwordHash);
  }

  function setPassword(username, password){
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    data.username = username;
    data.passwordSalt = salt;
    data.passwordHash = hash;
    persist();
  }

  function verifyPassword(username, password){
    if (!hasCredentials()) return false;
    if (username !== data.username) return false;
    const candidate = crypto.scryptSync(password, data.passwordSalt, 64).toString('hex');
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(data.passwordHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function username(){ return data.username; }
  function webauthnCredentials(){ return data.webauthnCredentials; }

  function addWebauthnCredential(cred){
    data.webauthnCredentials.push(cred);
    persist();
  }

  function updateWebauthnCounter(credentialID, counter){
    const c = data.webauthnCredentials.find(c => c.credentialID === credentialID);
    if (c) { c.counter = counter; persist(); }
  }

  function removeWebauthnCredential(credentialID){
    data.webauthnCredentials = data.webauthnCredentials.filter(c => c.credentialID !== credentialID);
    persist();
  }

  return {
    hasCredentials, setPassword, verifyPassword, username, webauthnCredentials,
    addWebauthnCredential, updateWebauthnCounter, removeWebauthnCredential
  };
}

module.exports = { createAuthStore };
