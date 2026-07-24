const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUES = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, value: RANK_VALUES[rank] });
    }
  }
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function dealHand(deck) {
  return [deck.pop(), deck.pop()];
}

function dealCommunity(deck, count) {
  const cards = [];
  for (let i = 0; i < count; i++) {
    cards.push(deck.pop());
  }
  return cards;
}

function evaluateHand(cards) {
  if (cards.length < 5) return null;

  const allCombos = combinations(cards, 5);
  let best = null;

  for (const combo of allCombos) {
    const result = rankFiveCardHand(combo);
    if (!best || compareHands(result, best) > 0) {
      best = result;
    }
  }

  return best;
}

function combinations(arr, k) {
  if (k === 1) return arr.map(x => [x]);
  if (k === arr.length) return [arr];
  const result = [];
  for (let i = 0; i <= arr.length - k; i++) {
    const head = arr[i];
    const tailCombos = combinations(arr.slice(i + 1), k - 1);
    for (const tail of tailCombos) {
      result.push([head, ...tail]);
    }
  }
  return result;
}

function rankFiveCardHand(cards) {
  const sorted = [...cards].sort((a, b) => b.value - a.value);
  const values = sorted.map(c => c.value);
  const suits = sorted.map(c => c.suit);

  const isFlush = suits.every(s => s === suits[0]);
  const { isStraight, highValue } = checkStraight(values);

  if (isFlush && isStraight) {
    if (highValue === 14) return { rank: 9, name: '皇家同花顺', values: [highValue], cards: sorted };
    return { rank: 8, name: '同花顺', values: [highValue], cards: sorted };
  }

  const counts = countValues(values);
  const groups = Object.entries(counts).map(([v, c]) => ({ value: +v, count: c })).sort((a, b) => b.count - a.count || b.value - a.value);

  if (groups[0].count === 4) {
    return { rank: 7, name: '四条', values: [groups[0].value, groups[1].value], cards: sorted };
  }

  if (groups[0].count === 3 && groups[1].count === 2) {
    return { rank: 6, name: '葫芦', values: [groups[0].value, groups[1].value], cards: sorted };
  }

  if (isFlush) {
    return { rank: 5, name: '同花', values, cards: sorted };
  }

  if (isStraight) {
    return { rank: 4, name: '顺子', values: [highValue], cards: sorted };
  }

  if (groups[0].count === 3) {
    return { rank: 3, name: '三条', values: [groups[0].value, groups[1].value, groups[2].value], cards: sorted };
  }

  if (groups[0].count === 2 && groups[1].count === 2) {
    return { rank: 2, name: '两对', values: [groups[0].value, groups[1].value, groups[2].value], cards: sorted };
  }

  if (groups[0].count === 2) {
    return { rank: 1, name: '一对', values: [groups[0].value, groups[1].value, groups[2].value, groups[3].value], cards: sorted };
  }

  return { rank: 0, name: '高牌', values, cards: sorted };
}

function checkStraight(values) {
  const unique = [...new Set(values)].sort((a, b) => b - a);
  if (unique.length < 5) return { isStraight: false, highValue: 0 };

  if (unique[0] - unique[4] === 4) {
    return { isStraight: true, highValue: unique[0] };
  }

  if (unique[0] === 14 && unique[1] === 5 && unique[2] === 4 && unique[3] === 3 && unique[4] === 2) {
    return { isStraight: true, highValue: 5 };
  }

  return { isStraight: false, highValue: 0 };
}

function countValues(values) {
  const counts = {};
  for (const v of values) {
    counts[v] = (counts[v] || 0) + 1;
  }
  return counts;
}

function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < a.values.length; i++) {
    if (a.values[i] !== b.values[i]) return a.values[i] - b.values[i];
  }
  return 0;
}

module.exports = { createDeck, shuffle, dealHand, dealCommunity, evaluateHand, compareHands };
