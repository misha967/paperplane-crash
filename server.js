const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.static('public'));

const SECRET = 'paperplane_secret';
const users = {};           // username -> { password, balance, history, bestCashout, streak, currentStreak }
const connectedUsers = {};  // socketId -> username
const gameState = {
  multiplier: 1.0,
  phase: 'waiting',
  bets: {}           // username -> { amount, amount2, socketId, cashedOut, cashedOut2, cashoutMultiplier, cashoutMultiplier2 }
};
let gameInterval = null;
const crashHistory = [];

// ─── AUTH ─────────────────────────────────────────────────────
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (users[username]) return res.json({ error: 'Utilisateur existe déjà' });
  const hash = await bcrypt.hash(password, 10);
  users[username] = {
    password: hash,
    balance: 1000,
    history: [],       // [{ round, bet, bet2, cashout, cashout2, profit, timestamp }]
    bestCashout: 0,
    streak: 0,
    currentStreak: 0
  };
  const token = jwt.sign({ username }, SECRET);
  res.json({ success: true, token, balance: 1000 });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user) return res.json({ error: 'Utilisateur introuvable' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.json({ error: 'Mot de passe incorrect' });
  const token = jwt.sign({ username }, SECRET);
  res.json({
    token,
    balance: user.balance,
    history: user.history.slice(-20),
    bestCashout: user.bestCashout,
    streak: user.streak
  });
});

// ─── HELPERS ──────────────────────────────────────────────────
function getLeaderboard() {
  return Object.entries(users)
    .map(([username, data]) => ({ username, balance: data.balance }))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 10);
}

function getActiveBets() {
  return Object.entries(gameState.bets).map(([username, bet]) => ({
    username,
    amount: bet.amount,
    amount2: bet.amount2 || null,
    cashedOut: bet.cashedOut,
    cashedOut2: bet.cashedOut2,
    multiplier: bet.cashoutMultiplier || null,
    multiplier2: bet.cashoutMultiplier2 || null
  }));
}

function broadcastLobby() {
  io.emit('lobby_update', {
    connectedCount: Object.keys(connectedUsers).length,
    connectedUsers: Object.values(connectedUsers),
    leaderboard: getLeaderboard(),
    activeBets: getActiveBets()
  });
}

// ─── GAME LOOP ────────────────────────────────────────────────
let roundNumber = 0;

function startBetting() {
  gameState.phase = 'betting';
  gameState.bets = {};
  gameState.multiplier = 1.0;
  roundNumber++;
  io.emit('betting_phase', { duration: 5000 });
  broadcastLobby();
  setTimeout(startFlying, 5000);
}

function startFlying() {
  gameState.phase = 'flying';

  // Provably fair-ish crash point: house edge ~3%
  const r = Math.random();
  const crashPoint = parseFloat(Math.max(1.01, (0.97 / (1 - r))).toFixed(2));

  io.emit('game_start');

  if (gameInterval) clearInterval(gameInterval);

  gameInterval = setInterval(() => {
    // Acceleration: slow start, faster climb
    const increment = 0.03 + (gameState.multiplier - 1) * 0.012;
    gameState.multiplier = parseFloat((gameState.multiplier + increment).toFixed(2));
    io.emit('multiplier_update', { multiplier: gameState.multiplier });
    io.emit('bets_update', { activeBets: getActiveBets() });

    if (gameState.multiplier >= crashPoint) {
      clearInterval(gameInterval);
      gameInterval = null;
      gameState.phase = 'crashed';

      crashHistory.unshift(parseFloat(gameState.multiplier.toFixed(2)));
      if (crashHistory.length > 10) crashHistory.pop();

      // Resolve bets
      Object.entries(gameState.bets).forEach(([uname, bet]) => {
        const user = users[uname];
        if (!user) return;

        let totalProfit = 0;

        // Bet 1
        if (!bet.cashedOut) {
          totalProfit -= bet.amount;
        }
        // Bet 2
        if (bet.amount2 && !bet.cashedOut2) {
          totalProfit -= bet.amount2;
        }

        // Record history entry
        const entry = {
          round: roundNumber,
          crashAt: gameState.multiplier,
          bet: bet.amount,
          cashout: bet.cashedOut ? bet.cashoutMultiplier : null,
          bet2: bet.amount2 || null,
          cashout2: bet.cashedOut2 ? bet.cashoutMultiplier2 : null,
          profit: parseFloat(totalProfit.toFixed(2)),
          timestamp: Date.now()
        };
        user.history.push(entry);
        if (user.history.length > 50) user.history.shift();

        // Streak tracking (per round: win if any cashout)
        const anyWin = bet.cashedOut || bet.cashedOut2;
        if (anyWin) {
          user.currentStreak = (user.currentStreak || 0) + 1;
          if (user.currentStreak > (user.streak || 0)) user.streak = user.currentStreak;
        } else {
          user.currentStreak = 0;
        }

        if (!bet.cashedOut && !(bet.cashedOut2)) {
          io.to(bet.socketId).emit('lost', { crashAt: gameState.multiplier });
        }

        // Send personal history update
        io.to(bet.socketId).emit('personal_stats', {
          history: user.history.slice(-20),
          bestCashout: user.bestCashout,
          streak: user.streak,
          currentStreak: user.currentStreak
        });
      });

      io.emit('game_crash', {
        crashAt: gameState.multiplier,
        crashHistory: [...crashHistory]
      });

      broadcastLobby();
      setTimeout(startBetting, 4000);
    }
  }, 150);
}

// ─── SOCKETS ──────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('🔌 Connecté :', socket.id);

  socket.emit('crash_history', { crashHistory: [...crashHistory] });
  if (gameState.phase === 'betting') {
    socket.emit('betting_phase', { duration: 3000 });
  } else if (gameState.phase === 'flying') {
    socket.emit('game_start');
    socket.emit('multiplier_update', { multiplier: gameState.multiplier });
  }

  // ── IDENTIFY ──
  socket.on('identify', (data) => {
    try {
      const decoded = jwt.verify(data.token, SECRET);
      connectedUsers[socket.id] = decoded.username;
      broadcastLobby();
    } catch (e) {}
  });

  // ── BET (supports bet1 + optional bet2) ──
  socket.on('place_bet', (data) => {
    if (gameState.phase !== 'betting') {
      return socket.emit('bet_error', { message: 'Phase de mise terminée' });
    }
    try {
      const decoded = jwt.verify(data.token, SECRET);
      const user = users[decoded.username];
      if (!user) return socket.emit('bet_error', { message: 'Utilisateur introuvable' });

      const amount = parseFloat(data.amount) || 0;
      const amount2 = parseFloat(data.amount2) || 0;
      const total = amount + amount2;

      if (amount <= 0) return socket.emit('bet_error', { message: 'Mise invalide' });
      if (user.balance < total) return socket.emit('bet_error', { message: 'Solde insuffisant' });
      if (gameState.bets[decoded.username]) return socket.emit('bet_error', { message: 'Mise déjà placée' });

      user.balance = parseFloat((user.balance - total).toFixed(2));
      gameState.bets[decoded.username] = {
        amount,
        amount2: amount2 > 0 ? amount2 : null,
        socketId: socket.id,
        cashedOut: false,
        cashedOut2: amount2 > 0 ? false : null,
        cashoutMultiplier: null,
        cashoutMultiplier2: null
      };

      socket.emit('bet_placed', {
        balance: user.balance,
        amount,
        amount2: amount2 > 0 ? amount2 : null
      });
      broadcastLobby();
    } catch (e) {
      socket.emit('bet_error', { message: 'Token invalide' });
    }
  });

  // ── CASHOUT (which: 1 or 2) ──
  socket.on('cashout', (data) => {
    if (gameState.phase !== 'flying') {
      return socket.emit('cashout_error', { message: 'Pas en vol' });
    }
    try {
      const decoded = jwt.verify(data.token, SECRET);
      const bet = gameState.bets[decoded.username];
      if (!bet) return socket.emit('cashout_error', { message: 'Aucune mise trouvée' });

      const which = data.which || 1;

      if (which === 1) {
        if (bet.cashedOut) return socket.emit('cashout_error', { message: 'Déjà cashout' });
        bet.cashedOut = true;
        bet.cashoutMultiplier = gameState.multiplier;
        const winnings = parseFloat((bet.amount * gameState.multiplier).toFixed(2));
        const profit = parseFloat((winnings - bet.amount).toFixed(2));
        users[decoded.username].balance = parseFloat((users[decoded.username].balance + winnings).toFixed(2));

        // Best cashout tracking
        if (gameState.multiplier > (users[decoded.username].bestCashout || 0)) {
          users[decoded.username].bestCashout = gameState.multiplier;
        }

        socket.emit('cashout_success', {
          which: 1,
          multiplier: gameState.multiplier,
          winnings,
          profit,
          balance: users[decoded.username].balance
        });
        io.emit('cashout_event', { username: decoded.username, multiplier: gameState.multiplier, which: 1 });
      } else if (which === 2) {
        if (!bet.amount2) return socket.emit('cashout_error', { message: 'Pas de 2ème mise' });
        if (bet.cashedOut2) return socket.emit('cashout_error', { message: 'Déjà cashout (2)' });
        bet.cashedOut2 = true;
        bet.cashoutMultiplier2 = gameState.multiplier;
        const winnings2 = parseFloat((bet.amount2 * gameState.multiplier).toFixed(2));
        const profit2 = parseFloat((winnings2 - bet.amount2).toFixed(2));
        users[decoded.username].balance = parseFloat((users[decoded.username].balance + winnings2).toFixed(2));

        if (gameState.multiplier > (users[decoded.username].bestCashout || 0)) {
          users[decoded.username].bestCashout = gameState.multiplier;
        }

        socket.emit('cashout_success', {
          which: 2,
          multiplier: gameState.multiplier,
          winnings: winnings2,
          profit: profit2,
          balance: users[decoded.username].balance
        });
        io.emit('cashout_event', { username: decoded.username, multiplier: gameState.multiplier, which: 2 });
      }

      broadcastLobby();
    } catch (e) {
      socket.emit('cashout_error', { message: 'Token invalide' });
    }
  });

  // ── EMOJI ──
  socket.on('send_emoji', (data) => {
    try {
      const decoded = jwt.verify(data.token, SECRET);
      const allowed = ['💩', '🖕', '🍆', '😂', '🔥', '💸', '😱'];
      if (!allowed.includes(data.emoji)) return;
      io.emit('emoji_received', {
        username: decoded.username,
        emoji: data.emoji
      });
    } catch (e) {}
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    delete connectedUsers[socket.id];
    broadcastLobby();
    console.log('❌ Déconnecté :', socket.id);
  });
});

// ─── START ────────────────────────────────────────────────────
server.listen(3000, () => {
  console.log('✈️  Paperplane Crash → http://localhost:3000');
  startBetting();
});
