const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { createDeck, shuffle, dealHand, dealCommunity, evaluateHand, compareHands } = require('./poker');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

const MAX_PLAYERS = 8;
const STARTING_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const TURN_TIMEOUT = 30000;

const rooms = {};

function createRoom(roomId) {
  return {
    id: roomId,
    players: [],
    deck: null,
    community: [],
    pot: 0,
    currentBet: 0,
    minRaise: BIG_BLIND,
    dealerIndex: -1,
    currentPlayerIndex: -1,
    phase: 'waiting',
    activePlayers: [],
    lastRaiserIndex: -1,
    winners: [],
    roundActions: 0,
  };
}

function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = createRoom(roomId);
  }
  return rooms[roomId];
}

function broadcastRoomState(room) {
  const state = {
    phase: room.phase,
    community: room.community,
    pot: room.pot,
    currentBet: room.currentBet,
    dealerIndex: room.dealerIndex,
    currentPlayerIndex: room.currentPlayerIndex,
    players: room.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      bet: p.bet,
      totalBet: p.totalBet,
      folded: p.folded,
      allIn: p.allIn,
      isDealer: i === room.dealerIndex,
      isCurrent: i === room.currentPlayerIndex,
      cardCount: p.hand ? p.hand.length : 0,
      hand: (room.phase === 'showdown' || !p.folded) && p.hand ? p.hand : null,
      connected: p.connected,
    })),
    winners: room.winners,
  };
  io.to(room.id).emit('gameState', state);
}

function startNewHand(room) {
  if (room.players.filter(p => p.connected && p.chips > 0).length < 2) {
    room.phase = 'waiting';
    broadcastRoomState(room);
    return;
  }

  room.deck = shuffle(createDeck());
  room.community = [];
  room.pot = 0;
  room.currentBet = 0;
  room.minRaise = BIG_BLIND;
  room.winners = [];
  room.roundActions = 0;
  room.lastRaiserIndex = -1;

  room.players.forEach(p => {
    p.hand = null;
    p.bet = 0;
    p.totalBet = 0;
    p.folded = false;
    p.allIn = false;
    p.lastAction = null;
  });

  const eligible = room.players.map((p, i) => ({ p, i })).filter(({ p }) => p.connected && p.chips > 0);
  if (eligible.length < 2) {
    room.phase = 'waiting';
    broadcastRoomState(room);
    return;
  }

  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  while (!room.players[room.dealerIndex] || room.players[room.dealerIndex].chips <= 0 || !room.players[room.dealerIndex].connected) {
    room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  }

  const playerCount = room.players.length;
  let sbIndex = (room.dealerIndex + 1) % playerCount;
  while (room.players[sbIndex].chips <= 0 || !room.players[sbIndex].connected) {
    sbIndex = (sbIndex + 1) % playerCount;
  }
  let bbIndex = (sbIndex + 1) % playerCount;
  while (room.players[bbIndex].chips <= 0 || !room.players[bbIndex].connected) {
    bbIndex = (bbIndex + 1) % playerCount;
  }

  const sbAmount = Math.min(SMALL_BLIND, room.players[sbIndex].chips);
  const bbAmount = Math.min(BIG_BLIND, room.players[bbIndex].chips);
  room.players[sbIndex].chips -= sbAmount;
  room.players[sbIndex].bet = sbAmount;
  room.players[sbIndex].totalBet = sbAmount;
  room.players[bbIndex].chips -= bbAmount;
  room.players[bbIndex].bet = bbAmount;
  room.players[bbIndex].totalBet = bbAmount;
  room.currentBet = bbAmount;
  room.pot = sbAmount + bbAmount;

  room.activePlayers = room.players
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.connected && p.chips > 0 || p.bet > 0)
    .map(({ i }) => i);

  room.players.forEach((p, i) => {
    if (p.connected && p.chips > 0) {
      p.hand = dealHand(room.deck);
    }
  });

  room.phase = 'preflop';
  room.currentPlayerIndex = (bbIndex + 1) % playerCount;
  while (room.players[room.currentPlayerIndex].folded || room.players[room.currentPlayerIndex].chips <= 0 || !room.players[room.currentPlayerIndex].connected) {
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % playerCount;
  }

  broadcastRoomState(room);
  startTurnTimer(room);
}

function startTurnTimer(room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnTimer = setTimeout(() => {
    if (room.phase !== 'waiting' && room.phase !== 'showdown') {
      handlePlayerAction(room, room.players[room.currentPlayerIndex].id, 'fold');
    }
  }, TURN_TIMEOUT);
}

function nextPlayer(room) {
  const playerCount = room.players.length;
  let next = (room.currentPlayerIndex + 1) % playerCount;
  let attempts = 0;
  while (attempts < playerCount) {
    const p = room.players[next];
    if (p.connected && !p.folded && !p.allIn && p.chips > 0) {
      room.currentPlayerIndex = next;
      room.roundActions++;
      broadcastRoomState(room);
      startTurnTimer(room);
      return;
    }
    next = (next + 1) % playerCount;
    attempts++;
  }

  advancePhase(room);
}

function isBettingRoundComplete(room) {
  const activeIndices = room.players
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.connected && !p.folded && !p.allIn && p.chips >= 0)
    .map(({ i }) => i);

  if (activeIndices.length === 0) return true;

  if (activeIndices.length === 1 && room.players.filter(p => !p.folded && p.connected).length <= 1) {
    return true;
  }

  const allMatched = activeIndices.every(i => room.players[i].bet === room.currentBet || room.players[i].allIn);
  const allActed = activeIndices.every(i => room.players[i].lastAction !== null || room.players[i].allIn);

  return allMatched && allActed;
}

function advancePhase(room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);

  if (room.players.filter(p => !p.folded && p.connected).length <= 1) {
    showdown(room);
    return;
  }

  room.players.forEach(p => {
    p.bet = 0;
    p.lastAction = null;
  });
  room.currentBet = 0;
  room.minRaise = BIG_BLIND;
  room.roundActions = 0;
  room.lastRaiserIndex = -1;

  if (room.phase === 'preflop') {
    room.phase = 'flop';
    room.community.push(...dealCommunity(room.deck, 3));
  } else if (room.phase === 'flop') {
    room.phase = 'turn';
    room.community.push(...dealCommunity(room.deck, 1));
  } else if (room.phase === 'turn') {
    room.phase = 'river';
    room.community.push(...dealCommunity(room.deck, 1));
  } else if (room.phase === 'river') {
    showdown(room);
    return;
  }

  const playerCount = room.players.length;
  room.currentPlayerIndex = (room.dealerIndex + 1) % playerCount;
  while (room.players[room.currentPlayerIndex].folded || room.players[room.currentPlayerIndex].chips <= 0 || !room.players[room.currentPlayerIndex].connected) {
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % playerCount;
  }

  broadcastRoomState(room);
  startTurnTimer(room);
}

function showdown(room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);

  const activePlayers = room.players.filter(p => !p.folded && p.connected && p.hand);

  if (activePlayers.length === 1) {
    const winner = activePlayers[0];
    winner.chips += room.pot;
    room.winners = [{ playerIds: [winner.id], hand: null, name: '其他玩家弃牌', amount: room.pot }];
    room.phase = 'showdown';
    broadcastRoomState(room);
    setTimeout(() => startNewHand(room), 5000);
    return;
  }

  while (room.community.length < 5) {
    room.community.push(...dealCommunity(room.deck, 1));
  }

  const evaluations = activePlayers.map(p => ({
    player: p,
    eval: evaluateHand([...p.hand, ...room.community]),
  }));

  evaluations.sort((a, b) => compareHands(b.eval, a.eval));

  const bestHand = evaluations[0].eval;
  const winners = evaluations.filter(e => compareHands(e.eval, bestHand) === 0);
  const winAmount = Math.floor(room.pot / winners.length);

  winners.forEach(w => {
    w.player.chips += winAmount;
  });

  room.winners = [{
    playerIds: winners.map(w => w.player.id),
    hand: bestHand,
    name: bestHand.name,
    amount: winAmount,
  }];

  room.phase = 'showdown';
  broadcastRoomState(room);

  setTimeout(() => startNewHand(room), 6000);
}

function handlePlayerAction(room, playerId, action, amount) {
  const playerIndex = room.players.findIndex(p => p.id === playerId);
  if (playerIndex !== room.currentPlayerIndex) return false;
  if (room.phase === 'waiting' || room.phase === 'showdown') return false;

  const player = room.players[playerIndex];
  if (player.folded || player.allIn) return false;

  if (action === 'fold') {
    player.folded = true;
    player.lastAction = 'fold';
  } else if (action === 'check') {
    if (player.bet < room.currentBet) return false;
    player.lastAction = 'check';
  } else if (action === 'call') {
    const toCall = room.currentBet - player.bet;
    const actualCall = Math.min(toCall, player.chips);
    player.chips -= actualCall;
    player.bet += actualCall;
    player.totalBet += actualCall;
    room.pot += actualCall;
    if (player.chips === 0) player.allIn = true;
    player.lastAction = 'call';
  } else if (action === 'raise') {
    const totalRequired = amount;
    if (totalRequired < room.currentBet + room.minRaise && totalRequired < player.chips + player.bet) return false;
    const raiseAmount = totalRequired - player.bet;
    const actualRaise = Math.min(raiseAmount, player.chips);
    player.chips -= actualRaise;
    player.bet += actualRaise;
    player.totalBet += actualRaise;
    room.pot += actualRaise;
    if (player.bet > room.currentBet) {
      room.minRaise = player.bet - room.currentBet;
      room.currentBet = player.bet;
      room.lastRaiserIndex = playerIndex;
      room.players.forEach((p, i) => {
        if (i !== playerIndex && !p.folded && !p.allIn) {
          p.lastAction = null;
        }
      });
    }
    if (player.chips === 0) player.allIn = true;
    player.lastAction = 'raise';
  }

  if (room.turnTimer) clearTimeout(room.turnTimer);

  if (isBettingRoundComplete(room)) {
    advancePhase(room);
  } else {
    nextPlayer(room);
  }

  return true;
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('joinRoom', ({ roomId, name }) => {
    const room = getOrCreateRoom(roomId || 'default');
    socket.roomId = room.id;

    const existingIndex = room.players.findIndex(p => p.id === socket.id);
    if (existingIndex >= 0) {
      room.players[existingIndex].connected = true;
    } else {
      if (room.players.length >= MAX_PLAYERS) {
        socket.emit('error', { message: '房间已满（最多8人）' });
        return;
      }
      room.players.push({
        id: socket.id,
        name: name || `玩家${room.players.length + 1}`,
        chips: STARTING_CHIPS,
        hand: null,
        bet: 0,
        totalBet: 0,
        folded: false,
        allIn: false,
        connected: true,
        lastAction: null,
      });
    }

    socket.join(room.id);
    socket.emit('joined', { playerId: socket.id, roomId: room.id });
    broadcastRoomState(room);

    if (room.phase === 'waiting' && room.players.filter(p => p.connected && p.chips > 0).length >= 2) {
      setTimeout(() => {
        if (room.phase === 'waiting') startNewHand(room);
      }, 2000);
    }
  });

  socket.on('action', ({ action, amount }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    handlePlayerAction(room, socket.id, action, amount);
    broadcastRoomState(room);
  });

  socket.on('startGame', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    if (room.phase === 'waiting' && room.players.filter(p => p.connected && p.chips > 0).length >= 2) {
      startNewHand(room);
    }
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    const room = rooms[socket.roomId];
    if (!room) return;

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex >= 0) {
      room.players[playerIndex].connected = false;
      room.players[playerIndex].folded = true;

      if (room.currentPlayerIndex === playerIndex && room.phase !== 'waiting' && room.phase !== 'showdown') {
        if (room.turnTimer) clearTimeout(room.turnTimer);
        if (isBettingRoundComplete(room)) {
          advancePhase(room);
        } else {
          nextPlayer(room);
        }
      }

      broadcastRoomState(room);

      setTimeout(() => {
        const r = rooms[socket.roomId];
        if (!r) return;
        r.players = r.players.filter(p => p.connected || p.id !== socket.id);
        if (r.players.length === 0) {
          delete rooms[r.id];
        } else {
          broadcastRoomState(r);
        }
      }, 5000);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
