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
  phase: 'waiting', // 'betting', 'flying', 'crashed'
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
  const crashPoint = Math.max(1.1, -Math.log(Math.random()) * 2);
  io.emit('game_start');

  const interval = setInterval(() => {
    gameState.multiplier = parseFloat((gameState.multiplier * 1.02).toFixed(2));
    io.emit('multiplier_update', { multiplier: gameState.multiplier });

    if (gameState.multiplier >= crashPoint) {
      clearInterval(interval);
      gameState.phase = 'crashed';
      io.emit('game_crash', { crashAt: gameState.multiplier });

      // Perte pour ceux qui n'ont pas cashout (balance déjà déduite à la mise)
      setTimeout(startBetting, 3000);
    }
  }, 100);
}

io.on('connection', (socket)
