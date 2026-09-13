// Push-notification state: subscriptions, team watchlist, prefs, and the
// "have we already alerted for this" markers that keep the poller from
// re-firing the same score/kickoff every cycle. Whole-file JSON snapshot
// (not JSONL like store.js) — this data mutates and shrinks (unsubscribe,
// remove from watchlist), unlike the append-only pick log.
const fs = require('fs');
const path = require('path');

function createNotifyStore({ dataDir } = {}){
  const file = dataDir ? path.join(dataDir, 'notify.json') : null;
  let state = { subscriptions: [], watchlist: [], prefs: { gameStart: true, betGraded: true }, seenScores: {}, notifiedStarts: {} };

  if (file) {
    try {
      if (fs.existsSync(file)) {
        state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      }
    } catch (e) {
      console.error(`notify: load failed (${e.message}) — starting empty`);
    }
  }

  function persist(){
    if (!file) return;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state));
    } catch (e) {
      console.error(`notify: write failed (${e.message})`);
    }
  }

  return {
    addSubscription(sub){
      if (!sub || !sub.endpoint) return false;
      if (state.subscriptions.some(s => s.endpoint === sub.endpoint)) return false;
      state.subscriptions.push(sub);
      persist();
      return true;
    },
    removeSubscription(endpoint){
      const before = state.subscriptions.length;
      state.subscriptions = state.subscriptions.filter(s => s.endpoint !== endpoint);
      if (state.subscriptions.length !== before) persist();
    },
    subscriptions: () => state.subscriptions,

    watchlist: () => state.watchlist,
    addWatch(sport, team){
      const key = sport + '|' + team;
      if (state.watchlist.some(w => (w.sport + '|' + w.team) === key)) return false;
      state.watchlist.push({ sport, team });
      persist();
      return true;
    },
    removeWatch(sport, team){
      const before = state.watchlist.length;
      state.watchlist = state.watchlist.filter(w => !(w.sport === sport && w.team === team));
      if (state.watchlist.length !== before) persist();
    },

    prefs: () => state.prefs,
    setPrefs(next){
      state.prefs = { ...state.prefs, ...next };
      persist();
    },

    // gameId+team -> last score seen, so we only alert on an actual increase.
    seenScore(key){ return state.seenScores[key]; },
    setSeenScore(key, score){ state.seenScores[key] = score; persist(); },

    startAlreadyNotified(gameId){ return !!state.notifiedStarts[gameId]; },
    markStartNotified(gameId){ state.notifiedStarts[gameId] = true; persist(); }
  };
}

module.exports = { createNotifyStore };
