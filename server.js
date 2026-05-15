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
const users = {};
const gameState = {
  multiplier: 1.0,
  phase: 'waiting',
  bets: {}
};

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (users[username]) return res.json({ error: 'Utilisateur existe déjà' });
  const hash = await bcrypt.hash(password, 10);
  users[username] = { password: hash, balance: 1000 };
  res.json({ success: true });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user) return res.json({ error: 'Utilisateur introuvable' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.json({ error: 'Mot de passe incorrect' });
  const token = jwt.sign({ username }, SECRET);
  res.json({ token, balance: user.balance });
});

function startBetting() {
  gameState.phase = 'betting';
  gameState.bets = {};
  gameState.multiplier = 1.0;
  io.emit('betting_phase', { duration: 5000 });
  setTimeout(startFlying, 5000);
}

function startFlying() {
  gameState.phase = 'flying';
  const crashPoint = parseFloat((1 + Math.random() * 9).toFixed(2));
  io.emit('game_start');

  const interval = setInterval(() => {
    gameState.multiplier = parseFloat((gameState.multiplier + 0.05).toFixed(2));
    io.emit('multiplier_update', { multiplier: gameState.multiplier });

    if (gameState.multiplier >= crashPoint) {
      clearInterval(interval);
      gameState.phase = 'crashed';

      // Pertes pour ceux qui n'ont pas cashout
      Object.entries(gameState.bets).forEach(([username, bet]) => {
        if (!bet.cashedOut) {
          io.to(bet.socketId).emit('game_crash', {
            crashAt: gameState.multiplier,
            message: '💥 Perdu !'
          });
        }
      });

      io.emit('game_crash', { crashAt: gameState.multiplier });
      setTimeout(startBetting, 4000);
    }
  }, 200);
}

io.on('connection', (socket) => {
  // Envoie l'état actuel au nouveau connecté
  if (gameState.phase === 'betting') {
    socket.emit('betting_phase', { duration: 3000 });
  } else if (gameState.phase === 'flying') {
    socket.emit('game_start');
    socket.emit('multiplier_update', { multiplier: gameState.multiplier });
  }

  socket.on('place_bet', (data) => {
    if (gameState.phase !== 'betting') {
      return socket.emit('bet_error', { message: 'Phase de mise terminée' });
    }
    try {
      const decoded = jwt.verify(data.token, SECRET);
      const user = users[decoded.username];
      if (!user) return socket.emit('bet_error', { message: 'Utilisateur introuvable' });
      if (user.balance < data.amount) return socket.emit('bet_error', { message: 'Solde insuffisant' });
      user.balance -= data.amount;
      gameState.bets[decoded.username] = {
        amount: data.amount,
        socketId: socket.id,
        cashedOut: false
      };
      socket.emit('balance_update', { balance: user.balance });
    } catch (e) {
      socket.emit('bet_error', { message: 'Token invalide' });
    }
  });

  socket.on('cashout', (data) => {
    if (gameState.phase !== 'flying') return;
    try {
      const decoded = jwt.verify(data.token, SECRET);
      const bet = gameState.bets[decoded.username];
      if (!bet || bet.cashedOut) return;
      bet.cashedOut = true;
      const winnings = parseFloat((bet.amount * gameState.multiplier).toFixed(2));
      const profit = parseFloat((winnings - bet.amount).toFixed(2));
      users[decoded.username].balance += winnings;
      socket.emit('cashout_success', {
        multiplier: gameState.multiplier,
        profit,
        balance: users[decoded.username].balance
      });
    } catch (e) {}
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log('Serveur démarré');
  startBetting();
});
