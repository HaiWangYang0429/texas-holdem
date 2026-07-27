const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { createDeck, shuffle, dealHand, dealCommunity, evaluateHand, compareHands } = require('./poker');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 10000,
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e5,
  connectTimeout: 30000,
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

const MAX_PLAYERS = 8;
const STARTING_CHIPS = 500;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const TURN_TIMEOUT = 30000;
const MAX_BUY_IN = 500;

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
    winners: [],
    readyPlayers: {},
    autoStartTimer: null,
    advanceTimer: null,
    lastChatTime: {},
  };
}

function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = createRoom(roomId);
  }
  return rooms[roomId];
}

function clearAllTimers(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  if (room.advanceTimer) { clearTimeout(room.advanceTimer); room.advanceTimer = null; }
  if (room.autoStartTimer) { clearTimeout(room.autoStartTimer); room.autoStartTimer = null; }
}

function buildPlayerPublicData(p, i, room, viewerId) {
  const showHand = (p.id === viewerId || room.phase === 'handEnd') && p.hand;
  return {
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
    hand: showHand ? p.hand : null,
    connected: p.connected,
    isSpectator: p.isSpectator || false,
    hasRaised: p.hasRaised || false,
    lastAction: p.lastAction || null,
    isReady: room.readyPlayers[p.id] || false,
    totalBuyIn: p.totalBuyIn || 0,
    netProfit: p.netProfit !== undefined ? p.netProfit : 0,
    hasRebuy: p.hasRebuy || false,
  };
}

function broadcastRoomState(room) {
  const connectedSockets = Array.from(io.sockets.adapter.rooms.get(room.id) || []);
  const handMap = {};
  for (const p of room.players) {
    if (p.hand) handMap[p.id] = p.hand;
  }
  const basePlayers = room.players.map((p, i) => {
    const data = buildPlayerPublicData(p, i, room, null);
    data.hand = null;
    return data;
  });
  const revealAll = room.phase === 'handEnd';
  for (const sid of connectedSockets) {
    const players = basePlayers.map(p =>
      (p.id === sid || revealAll) && handMap[p.id]
        ? { ...p, hand: handMap[p.id] }
        : p
    );
    io.to(sid).emit('gameState', {
      phase: room.phase,
      community: room.community,
      pot: room.pot,
      currentBet: room.currentBet,
      minRaise: room.minRaise,
      dealerIndex: room.dealerIndex,
      currentPlayerIndex: room.currentPlayerIndex,
      players,
      winners: room.winners,
    });
  }
}

function startNewHand(room) {
  if (room.phase !== 'waiting' && room.phase !== 'handEnd') return;
  clearAllTimers(room);
  room.readyPlayers = {};

  room.players.forEach(p => {
    p.isSpectator = false;
    p.hand = null;
    p.bet = 0;
    p.totalBet = 0;
    p.folded = false;
    p.allIn = false;
    p.lastAction = null;
    p.hasRaised = false;
    p.hasRebuy = false;
  });

  const eligiblePlayers = room.players.filter(p => p.connected && !p.isSpectator && p.chips > 0);
  if (eligiblePlayers.length < 2) {
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

  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  while (!room.players[room.dealerIndex] || room.players[room.dealerIndex].chips <= 0 || !room.players[room.dealerIndex].connected || room.players[room.dealerIndex].isSpectator) {
    room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  }

  const playerCount = room.players.length;

  const activeEligible = room.players.filter(p => p.connected && !p.isSpectator && p.chips > 0);
  const isHeadsUp = activeEligible.length === 2;

  let sbIndex, bbIndex;

  if (isHeadsUp) {
    sbIndex = room.dealerIndex;
    bbIndex = (sbIndex + 1) % playerCount;
    while (room.players[bbIndex].chips <= 0 || !room.players[bbIndex].connected || room.players[bbIndex].isSpectator) {
      bbIndex = (bbIndex + 1) % playerCount;
    }
  } else {
    sbIndex = (room.dealerIndex + 1) % playerCount;
    while (room.players[sbIndex].chips <= 0 || !room.players[sbIndex].connected || room.players[sbIndex].isSpectator) {
      sbIndex = (sbIndex + 1) % playerCount;
    }
    bbIndex = (sbIndex + 1) % playerCount;
    while (room.players[bbIndex].chips <= 0 || !room.players[bbIndex].connected || room.players[bbIndex].isSpectator) {
      bbIndex = (bbIndex + 1) % playerCount;
    }
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

  room.players.forEach((p, i) => {
    if (p.connected && !p.isSpectator && p.chips > 0) {
      p.hand = dealHand(room.deck);
    }
  });

  room.phase = 'preflop';

  if (isHeadsUp) {
    room.currentPlayerIndex = sbIndex;
  } else {
    room.currentPlayerIndex = (bbIndex + 1) % playerCount;
  }

  while (
    room.players[room.currentPlayerIndex].folded ||
    room.players[room.currentPlayerIndex].chips <= 0 ||
    !room.players[room.currentPlayerIndex].connected ||
    room.players[room.currentPlayerIndex].allIn ||
    room.players[room.currentPlayerIndex].isSpectator
  ) {
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % playerCount;
  }

  broadcastRoomState(room);
  startTurnTimer(room);
}

function startTurnTimer(room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  const targetId = room.currentPlayerIndex >= 0 && room.players[room.currentPlayerIndex]
    ? room.players[room.currentPlayerIndex].id : null;
  room.turnTimer = setTimeout(() => {
    if (room.phase !== 'waiting' && room.phase !== 'handEnd' && room.currentPlayerIndex >= 0) {
      const currentP = room.players[room.currentPlayerIndex];
      if (currentP && currentP.id === targetId && currentP.connected && !currentP.folded && !currentP.allIn) {
        handlePlayerAction(room, currentP.id, 'fold');
        broadcastRoomState(room);
      }
    }
  }, TURN_TIMEOUT);
}

function nextPlayer(room) {
  const playerCount = room.players.length;
  let next = (room.currentPlayerIndex + 1) % playerCount;
  let attempts = 0;
  while (attempts < playerCount) {
    const p = room.players[next];
    if (p.connected && !p.folded && !p.allIn && p.chips > 0 && !p.isSpectator) {
      room.currentPlayerIndex = next;
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
    .filter(({ p }) => p.connected && !p.folded && !p.allIn && p.chips > 0 && !p.isSpectator)
    .map(({ i }) => i);

  if (activeIndices.length === 0) return true;

  const stillIn = room.players.filter(p => !p.folded && p.connected && !p.isSpectator);
  if (stillIn.length <= 1) return true;

  const allMatched = activeIndices.every(i => room.players[i].bet === room.currentBet || room.players[i].allIn);
  const allActed = activeIndices.every(i => room.players[i].lastAction !== null || room.players[i].allIn);

  return allMatched && allActed;
}

function advancePhase(room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  if (room.advanceTimer) { clearTimeout(room.advanceTimer); room.advanceTimer = null; }

  if (room.phase === 'handEnd' || room.phase === 'waiting') return;

  if (room.players.filter(p => !p.folded && p.connected && !p.isSpectator).length <= 1) {
    showdown(room);
    return;
  }

  room.players.forEach(p => {
    p.bet = 0;
    p.lastAction = null;
    p.hasRaised = false;
  });
  room.currentBet = 0;
  room.minRaise = BIG_BLIND;

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
  while (
    room.players[room.currentPlayerIndex].folded ||
    room.players[room.currentPlayerIndex].chips <= 0 ||
    !room.players[room.currentPlayerIndex].connected ||
    room.players[room.currentPlayerIndex].allIn ||
    room.players[room.currentPlayerIndex].isSpectator
  ) {
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % playerCount;
    if (room.players.filter(p => !p.folded && p.connected && !p.allIn && p.chips > 0 && !p.isSpectator).length === 0) break;
  }

  broadcastRoomState(room);

  const canStillAct = room.players.filter(p => !p.folded && p.connected && !p.allIn && p.chips > 0 && !p.isSpectator);
  if (canStillAct.length <= 1) {
    room.advanceTimer = setTimeout(() => {
      if (room.phase !== 'handEnd' && room.phase !== 'waiting') {
        advancePhase(room);
      }
    }, 1500);
  } else {
    startTurnTimer(room);
  }
}

function calculateSidePots(room) {
  const contributors = room.players
    .filter(p => p.totalBet > 0)
    .map(p => ({ player: p, totalBet: p.totalBet }));

  contributors.sort((a, b) => a.totalBet - b.totalBet);

  const pots = [];
  let prevLevel = 0;

  for (let i = 0; i < contributors.length; i++) {
    const level = contributors[i].totalBet;
    if (level > prevLevel) {
      const levelAmount = level - prevLevel;
      const eligibleCount = contributors.filter(c => c.totalBet >= level).length;
      const potAmount = levelAmount * eligibleCount;
      const eligiblePlayers = contributors.filter(c => c.totalBet >= level).map(c => c.player);
      pots.push({ amount: potAmount, eligiblePlayers });
      prevLevel = level;
    }
  }

  return pots;
}

function showdown(room) {
  clearAllTimers(room);

  while (room.community.length < 5) {
    room.community.push(...dealCommunity(room.deck, 1));
  }

    const stillInPlayers = room.players.filter(p => !p.folded && p.hand && !p.isSpectator);

  if (stillInPlayers.length === 0) {
    room.phase = 'handEnd';
    broadcastRoomState(room);
    return;
  }

  if (stillInPlayers.length === 1) {
    const winner = stillInPlayers[0];
    winner.chips += room.pot;
    room.winners = [{ playerIds: [winner.id], hand: null, name: '其他玩家弃牌', amount: room.pot, potIndex: 0 }];

    room.players.forEach(p => {
      if (p.connected && !p.isSpectator && p.chips === 0) {
        p.chips += MAX_BUY_IN;
        p.totalBuyIn = (p.totalBuyIn || 0) + MAX_BUY_IN;
      }
      p.netProfit = p.chips - STARTING_CHIPS - (p.totalBuyIn || 0);
    });

    room.phase = 'handEnd';
    broadcastRoomState(room);
    return;
  }

  const pots = calculateSidePots(room);
  const allResults = [];

  for (let potIdx = 0; potIdx < pots.length; potIdx++) {
    const pot = pots[potIdx];
    const eligible = pot.eligiblePlayers.filter(p => !p.folded && p.hand && !p.isSpectator);

    if (eligible.length === 0) continue;
    if (eligible.length === 1) {
      eligible[0].chips += pot.amount;
      allResults.push({ playerIds: [eligible[0].id], hand: null, name: '其他玩家弃牌', amount: pot.amount, potIndex: potIdx });
      continue;
    }

    const evaluations = eligible.map(p => ({
      player: p,
      eval: evaluateHand([...p.hand, ...room.community]),
    }));

    evaluations.sort((a, b) => compareHands(b.eval, a.eval));

    const bestHand = evaluations[0].eval;
    const winners = evaluations.filter(e => compareHands(e.eval, bestHand) === 0);

    const baseAmount = Math.floor(pot.amount / winners.length);
    const remainder = pot.amount - baseAmount * winners.length;

    const sortedWinners = winners.sort((a, b) => {
      const aIdx = room.players.indexOf(a.player);
      const bIdx = room.players.indexOf(b.player);
      let aDist = (aIdx - room.dealerIndex + room.players.length) % room.players.length;
      let bDist = (bIdx - room.dealerIndex + room.players.length) % room.players.length;
      return aDist - bDist;
    });

    sortedWinners.forEach((w, i) => {
      w.player.chips += baseAmount + (i < remainder ? 1 : 0);
    });

    allResults.push({
      playerIds: sortedWinners.map(w => w.player.id),
      hand: bestHand,
      name: bestHand.name,
      amount: baseAmount,
      potIndex: potIdx,
    });
  }

  room.winners = allResults;
  room.phase = 'handEnd';

  room.players.forEach(p => {
    if (p.connected && !p.isSpectator && p.chips === 0) {
      p.chips += MAX_BUY_IN;
      p.totalBuyIn = (p.totalBuyIn || 0) + MAX_BUY_IN;
    }
    p.netProfit = p.chips - STARTING_CHIPS - (p.totalBuyIn || 0);
  });

  broadcastRoomState(room);
}

function checkAllReady(room) {
  if (room.phase !== 'handEnd') return;
  const activePlayers = room.players.filter(p => p.connected && !p.isSpectator && p.chips > 0);
  if (activePlayers.length < 2) {
    room.phase = 'waiting';
    broadcastRoomState(room);
    return;
  }
  const allReady = activePlayers.every(p => room.readyPlayers[p.id]);
  if (allReady) {
    startNewHand(room);
  }
}

function handlePlayerAction(room, playerId, action, amount) {
  const playerIndex = room.players.findIndex(p => p.id === playerId);
  if (playerIndex < 0 || playerIndex !== room.currentPlayerIndex) return false;
  if (room.phase === 'waiting' || room.phase === 'showdown' || room.phase === 'handEnd') return false;

  const player = room.players[playerIndex];
  if (player.folded || player.allIn || player.isSpectator) return false;

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
    if (player.hasRaised) return false;

    if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) return false;
    const totalRequired = Math.floor(amount);
    if (totalRequired <= player.bet) return false;
    if (totalRequired < room.currentBet + room.minRaise && totalRequired < player.chips + player.bet) return false;

    const raiseAmount = totalRequired - player.bet;
    const actualRaise = Math.min(raiseAmount, player.chips);
    player.chips -= actualRaise;
    player.bet += actualRaise;
    player.totalBet += actualRaise;
    room.pot += actualRaise;

    if (player.bet > room.currentBet) {
      const raiseIncrement = player.bet - room.currentBet;
      if (raiseIncrement >= room.minRaise) {
        room.players.forEach((p, i) => {
          if (i !== playerIndex && !p.folded && !p.allIn && !p.isSpectator) {
            p.lastAction = null;
          }
        });
        room.minRaise = raiseIncrement;
      }
      room.currentBet = player.bet;
    }

    if (player.chips === 0) player.allIn = true;
    player.hasRaised = true;
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
    const cleanRoom = String(roomId || 'default').slice(0, 30).trim() || 'default';
    const cleanName = String(name || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 12).trim() || `玩家${Date.now() % 1000}`;
    const room = getOrCreateRoom(cleanRoom);

    const isInGame = room.phase !== 'waiting' && room.phase !== 'handEnd';

    const existingIndex = room.players.findIndex(p => p.name === cleanName && !p.connected);
    if (existingIndex >= 0) {
      room.players[existingIndex].id = socket.id;
      room.players[existingIndex].connected = true;
      if (room.phase === 'waiting' || room.phase === 'handEnd') {
        room.players[existingIndex].folded = false;
        room.players[existingIndex].isSpectator = false;
      }
    } else {
      const existingSocketIndex = room.players.findIndex(p => p.id === socket.id);
      if (existingSocketIndex >= 0) {
        room.players[existingSocketIndex].connected = true;
      } else {
        if (room.players.length >= MAX_PLAYERS) {
          socket.emit('error', { message: '房间已满（最多8人）' });
          return;
        }
        room.players.push({
          id: socket.id,
          name: cleanName,
          chips: STARTING_CHIPS,
          hand: null,
          bet: 0,
          totalBet: 0,
          folded: false,
          allIn: false,
          connected: true,
          lastAction: null,
          hasRaised: false,
          isSpectator: isInGame,
          totalBuyIn: 0,
          netProfit: 0,
          hasRebuy: false,
        });
      }
    }

    socket.roomId = room.id;
    socket.join(room.id);
    socket.emit('joined', { playerId: socket.id, roomId: room.id, isSpectator: isInGame });
    broadcastRoomState(room);

    if (room.phase === 'waiting' && room.players.filter(p => p.connected && !p.isSpectator && p.chips > 0).length >= 2) {
      if (room.autoStartTimer) clearTimeout(room.autoStartTimer);
      room.autoStartTimer = setTimeout(() => {
        if (room.phase === 'waiting') startNewHand(room);
      }, 2000);
    }
  });

  socket.on('action', ({ action, amount }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const wasHandled = handlePlayerAction(room, socket.id, action, amount);
    if (!wasHandled) {
      broadcastRoomState(room);
    }
  });

  socket.on('chat', ({ message }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const now = Date.now();
    const last = room.lastChatTime[socket.id] || 0;
    if (now - last < 500) return;
    room.lastChatTime[socket.id] = now;
    const text = String(message || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100).trim();
    if (!text) return;
    io.to(room.id).emit('chat', {
      playerId: socket.id,
      name: player.name,
      message: text,
      timestamp: now,
    });
  });

  socket.on('readyForNext', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    if (room.phase !== 'handEnd') return;
    room.readyPlayers[socket.id] = true;
    broadcastRoomState(room);
    checkAllReady(room);
  });

  socket.on('rebuy', ({ amount }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    if (room.phase !== 'handEnd') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.isSpectator) return;
    if (player.hasRebuy) return;
    const rebuyAmount = Math.min(Math.max(1, parseInt(amount) || 0), MAX_BUY_IN);
    player.chips += rebuyAmount;
    player.totalBuyIn = (player.totalBuyIn || 0) + rebuyAmount;
    player.netProfit = player.chips - STARTING_CHIPS - (player.totalBuyIn || 0);
    player.hasRebuy = true;
    broadcastRoomState(room);
  });

  socket.on('startGame', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    if (room.phase === 'waiting' && room.players.filter(p => p.connected && !p.isSpectator && p.chips > 0).length >= 2) {
      startNewHand(room);
    }
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    const room = rooms[socket.roomId];
    if (!room) return;

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex >= 0) {
      const wasAllIn = room.players[playerIndex].allIn;
      room.players[playerIndex].connected = false;
      if (!wasAllIn) {
        room.players[playerIndex].folded = true;
      }
      delete room.readyPlayers[socket.id];

      if (room.currentPlayerIndex === playerIndex && room.phase !== 'waiting' && room.phase !== 'handEnd') {
        if (room.turnTimer) clearTimeout(room.turnTimer);
        if (isBettingRoundComplete(room)) {
          advancePhase(room);
        } else {
          nextPlayer(room);
        }
      }

      if (room.phase === 'handEnd') {
        checkAllReady(room);
      }

      broadcastRoomState(room);

      setTimeout(() => {
        const r = rooms[socket.roomId];
        if (!r) return;
        const removingIndex = r.players.findIndex(p => p.id === socket.id);
        if (removingIndex < 0) return;

        r.players.splice(removingIndex, 1);

        if (r.currentPlayerIndex > removingIndex) r.currentPlayerIndex--;
        if (r.dealerIndex > removingIndex) r.dealerIndex--;
        if (r.dealerIndex === removingIndex && r.players.length > 0) {
          r.dealerIndex = (r.dealerIndex - 1 + r.players.length) % r.players.length;
        }

        if (r.currentPlayerIndex >= r.players.length && r.players.length > 0) {
          r.currentPlayerIndex = r.currentPlayerIndex % r.players.length;
        }
        if (r.dealerIndex >= r.players.length && r.players.length > 0) {
          r.dealerIndex = r.dealerIndex % r.players.length;
        }

        if (r.players.length === 0) {
          clearAllTimers(r);
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
