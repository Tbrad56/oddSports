# LineWatch — Collaborator Setup Guide

Welcome! This gets you from a blank computer to running LineWatch locally and
contributing changes. Nothing here assumes prior setup — skip any step you've
already done.

**Shortcut if you use Claude Code:** do sections 1–2 by hand (installing
tools and cloning), then from the project folder just ask Claude:

> "Read docs/ONBOARDING.md and walk me through setup from section 3. I have
> the API key ready."

It'll handle the .env, run the app, and explain the workflow. Sections 3–5
below are the same information for reference. Section 5's ground rules apply
either way — Claude follows them too.

---

## 1. Install the tools (one time)

### VS Code
1. Download from https://code.visualstudio.com and run the installer.
2. Defaults are fine. On the installer page, check **"Add to PATH"** if offered.

### Git
- **Windows:** download from https://git-scm.com/download/win and install.
  Defaults are fine (this also gives you Git Credential Manager, which handles
  GitHub login automatically).
- **Mac:** open Terminal, run `git --version` — if it's missing, macOS offers
  to install it.

### Node.js
1. Download the **LTS** version from https://nodejs.org and install (defaults fine).
2. Verify: open a new terminal and run:
   ```bash
   node --version   # should print v18 or higher
   npm --version
   ```

### GitHub account
1. Create an account at https://github.com if you don't have one.
2. Tell Tai your username — he'll send a **collaborator invite** for
   `Tbrad56/oddSports`. Accept it from the email or
   https://github.com/notifications before you can push.

---

## 2. Get the code (one time)

Open VS Code → **Terminal → New Terminal**, then:

```bash
cd path/to/wherever/you/keep/projects
git clone https://github.com/Tbrad56/oddSports.git
cd oddSports
code .          # reopens VS Code in the project
npm install     # installs dependencies (express, etc.)
```

The first `git push` later will pop up a GitHub login window — sign in once
and Git remembers you.

---

## 3. The API key (one time — IMPORTANT)

The app talks to The Odds API through a server-side key that is **never
committed to git**. You need your own local copy:

1. Get the key from Tai **privately** (text/Signal — never in a commit,
   never in a GitHub comment or issue).
2. In the project folder:
   ```bash
   cp .env.example .env     # Windows PowerShell: copy .env.example .env
   ```
3. Open `.env` and paste the key:
   ```
   ODDS_API_KEY=paste-key-here
   PORT=3000
   ```

`.env` is gitignored — it stays on your machine. If you ever see a key in a
diff you're about to commit, stop and tell Tai.

**Quota heads-up:** the key has 500 free API credits/month shared between us.
Moneyline loads cost ~2, player-props loads ~12 **per game**. The server
caches for 10 minutes, so normal use is cheap — just don't spam "Load props"
on every game.

---

## 4. Run it

```bash
npm start
```

Open http://localhost:3000 — you should see the LineWatch home page.
Pages: Home (value cheatsheet), Board (moneylines), Props (per-game player
props), Slip (parlay builder).

Run the server tests any time:

```bash
npm test        # should say 11 pass, 0 fail
```

Stop the server with `Ctrl+C`.

---

## 5. How we work (every time)

`main` is protected — direct pushes are rejected. All changes go through a
branch and a Pull Request the other person approves.

### Starting a piece of work

```bash
git checkout main
git pull                      # get the latest
git checkout -b short-name    # e.g. fix-ticker-speed
```

### While you work

- Commit early and often:
  ```bash
  git add <files>
  git commit -m "what and why, briefly"
  ```
- If you're on a branch for more than a day, keep it current:
  ```bash
  git fetch && git rebase origin/main
  ```

### Shipping it

```bash
git push -u origin short-name
```

Then open the link git prints (or go to the repo on GitHub → "Compare & pull
request"). Describe what changed; the other person reviews and merges.

### After your PR merges

```bash
git checkout main && git pull
git branch -d short-name      # clean up the old branch
```

### Ground rules

1. **Never push to `main`** (GitHub blocks it anyway).
2. **Never commit `.env`** or paste the API key anywhere public.
3. Small PRs beat big ones — hours of work, not weeks.
4. Say what area you're touching before you start, so we don't collide.
5. If a merge conflict appears: `git rebase origin/main`, fix the marked
   files, `git push --force-with-lease` (only ever on your own branch).

---

## 6. Project layout (30-second tour)

```
public/          the website (what the browser loads)
  common.js        shared helpers: slip storage, nav, odds math
  index.html+home.js    Home page
  board.html+board.js   odds board
  props.html+props.js   player props
  slip.html+slip.js     bet slip / parlay
server.js        Express server: serves public/ + proxies The Odds API
                 (holds the key server-side, caches responses 10 min)
test/            server tests (npm test)
docs/            design specs and plans for each feature
```

Questions → ask Tai.
