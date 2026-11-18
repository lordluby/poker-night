// Multiplayer Texas Hold'em (No-Limit) — Node.js + WebSocket
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const START_CHIPS = +process.env.START_CHIPS || 1000;
const SB = +process.env.SMALL_BLIND || 10;
const BB = +process.env.BIG_BLIND || 20;
const TURN_MS = 45000;
const NEXT_HAND_MS = +process.env.NEXT_HAND_MS || 6000;
const MAX_PLAYERS = 9;

// ---------- Cards & hand evaluation ----------
const RANKS = '23456789TJQKA';
const SUITS = 'shdc';
const HAND_NAMES = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];

function newDeck() {
  const d = [];
  for (const r of RANKS) for (const s of SUITS) d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
const parse = c => ({ r: RANKS.indexOf(c[0]) + 2, s: c[1] });

function eval5(cards) {
  const rs = cards.map(c => c.r).sort((a, b) => b - a);
  const flush = cards.length === 5 && cards.every(c => c.s === cards[0].s);
  let straight = 0;
  if (cards.length === 5 && new Set(rs).size === 5) {
    if (rs[0] - rs[4] === 4) straight = rs[0];
    else if (rs[0] === 14 && rs[1] === 5) straight = 5;
  }
  const cnt = {};
  rs.forEach(r => (cnt[r] = (cnt[r] || 0) + 1));
  const g = Object.entries(cnt).map(([r, c]) => [c, +r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const ord = g.map(x => x[1]);
  if (straight && flush) return [8, straight];
  if (g[0][0] === 4) return [7, ...ord];
  if (g[0][0] === 3 && g[1]?.[0] === 2) return [6, ...ord];
  if (flush) return [5, ...rs];
  if (straight) return [4, straight];
  if (g[0][0] === 3) return [3, ...ord];
  if (g[0][0] === 2 && g[1]?.[0] === 2) return [2, ...ord];
  if (g[0][0] === 2) return [1, ...ord];
  return [0, ...rs];
}
const cmp = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
};
function bestHand(cardStrs) {
  const cs = cardStrs.map(parse);
  const k = Math.min(5, cs.length);
  let best = null;
  const pick = (start, chosen) => {
    if (chosen.length === k) { const sc = eval5(chosen); if (!best || cmp(sc, best) > 0) best = sc; return; }
    for (let i = start; i < cs.length; i++) pick(i + 1, [...chosen, cs[i]]);
  };
  pick(0, []);
  const name = best[0] === 8 && best[1] === 14 ? 'Royal Flush' : HAND_NAMES[best[0]];
  return { score: best, name };
}

// ---------- Room / game logic ----------
class Room {
  constructor(code) {
    this.code = code;
    this.players = [];
    this.dealer = -1;
    this.stage = 'waiting';
    this.community = [];
    this.deck = [];
    this.currentBet = 0;
    this.minRaise = BB;
    this.toAct = -1;
    this.pending = new Set();
    this.reveal = false;
    this.result = null;
    this.log = [];
    this.handNo = 0;
    this.timer = null;
    this.deadline = 0;
    this.hostId = null;
    this.gen = 0; // invalidates stale timeouts
    this.chat = [];
  }

  addLog(s) { this.log.push(s); if (this.log.length > 40) this.log.shift(); }
  byId(id) { return this.players.find(p => p.id === id); }
  canAct(p) { return p.inHand && !p.folded && !p.allIn; }
  live() { return this.players.filter(p => p.inHand && !p.folded); }

  nextIdx(from, pred) {
    const n = this.players.length;
    for (let k = 1; k <= n; k++) {
      const i = (((from + k) % n) + n) % n;
      if (pred(this.players[i])) return i;
    }
    return -1;
  }

  fixHost() {
    const h = this.byId(this.hostId);
    if (!h || !h.connected) {
      const c = this.players.find(p => p.connected);
      if (c) this.hostId = c.id;
    }
  }

  inHandNow() { return ['preflop', 'flop', 'turn', 'river'].includes(this.stage); }

  join(ws, name, token) {
    let p = token && this.byId(token);
    if (p) {
      if (p.ws && p.ws !== ws) try { p.ws.close(); } catch {}
      p.ws = ws; p.connected = true; p.name = name || p.name;
    } else {
      if (this.players.length >= MAX_PLAYERS) {
        // drop offline players who are not in a hand
        this.players = this.players.filter(q => q.connected || (q.inHand && this.inHandNow()));
      }
      if (this.players.length >= MAX_PLAYERS) return null;
      p = {
        id: crypto.randomBytes(12).toString('hex'), name: (name || 'Player').slice(0, 16),
        chips: START_CHIPS, ws, connected: true, inHand: false, hole: [], folded: true,
        allIn: false, bet: 0, total: 0, lastAction: '', best: null,
      };
      // keep dealer pointer stable: append to end
      this.players.push(p);
      this.addLog(`${p.name} joined`);
    }
    this.fixHost();
    return p;
  }

  leave(p) {
    p.connected = false; p.ws = null;
    this.fixHost();
    if (this.inHandNow() && this.players[this.toAct] === p) {
      // give them a few seconds to reconnect (page refresh), then fold
      this.armTimer(8000);
    }
  }

  startHand() {
    clearTimeout(this.timer);
    this.gen++;
    const elig = this.players.filter(p => p.chips > 0 && p.connected);
    if (elig.length < 2) { this.stage = 'waiting'; this.toAct = -1; this.broadcast(); return; }
    this.handNo++;
    for (const p of this.players) {
      p.inHand = p.chips > 0 && p.connected;
      p.hole = []; p.folded = !p.inHand; p.allIn = false; p.bet = 0; p.total = 0; p.lastAction = ''; p.best = null;
    }
    this.dealer = this.nextIdx(this.dealer, p => p.inHand);
    this.deck = newDeck(); this.community = []; this.reveal = false; this.result = null;
    for (const p of this.players) if (p.inHand) p.hole = [this.deck.pop(), this.deck.pop()];
    const n = this.players.filter(p => p.inHand).length;
    const sbI = n === 2 ? this.dealer : this.nextIdx(this.dealer, p => p.inHand);
    const bbI = this.nextIdx(sbI, p => p.inHand);
    this.commit(this.players[sbI], SB); this.players[sbI].lastAction = `SB ${this.players[sbI].bet}`;
    this.commit(this.players[bbI], BB); this.players[bbI].lastAction = `BB ${this.players[bbI].bet}`;
    this.currentBet = BB; this.minRaise = BB; this.stage = 'preflop';
    this.addLog(`— Hand #${this.handNo} — dealer: ${this.players[this.dealer].name}`);
    this.pending = new Set(this.players.filter(p => this.canAct(p)).map(p => p.id));
    this.toAct = bbI;
    this.afterAction();
  }

  commit(p, amt) {
    amt = Math.max(0, Math.min(amt, p.chips));
    p.chips -= amt; p.bet += amt; p.total += amt;
    if (p.chips === 0) p.allIn = true;
  }

  act(p, action, amount) {
    if (!this.inHandNow() || this.players[this.toAct] !== p || !this.pending.has(p.id)) return;
    const toCall = this.currentBet - p.bet;
    if (action === 'fold') {
      p.folded = true; p.lastAction = 'Fold'; this.addLog(`${p.name} folds`);
    } else if (action === 'check') {
      if (toCall > 0) return;
      p.lastAction = 'Check'; this.addLog(`${p.name} checks`);
    } else if (action === 'call') {
      if (toCall <= 0) return;
      this.commit(p, toCall);
      p.lastAction = p.allIn ? 'All-in' : `Call ${p.bet}`; this.addLog(`${p.name} calls ${p.bet}`);
    } else if (action === 'raise') {
      let to = Math.floor(Number(amount));
      if (!Number.isFinite(to)) return;
      const maxTo = p.bet + p.chips;
      to = Math.min(to, maxTo);
      if (to <= this.currentBet) return;
      if (to < this.currentBet + this.minRaise && to < maxTo) return; // only all-in may be short
      const size = to - this.currentBet;
      const wasBet = this.currentBet === 0;
      if (size >= this.minRaise) this.minRaise = size;
      this.commit(p, to - p.bet);
      this.currentBet = to;
      p.lastAction = p.allIn ? `All-in ${to}` : `${wasBet ? 'Bet' : 'Raise to'} ${to}`;
      this.addLog(`${p.name} ${p.lastAction.toLowerCase()}`);
      this.pending = new Set(this.players.filter(q => q !== p && this.canAct(q) && q.bet < to).map(q => q.id));
    } else return;
    this.pending.delete(p.id);
    this.afterAction();
  }

  afterAction() {
    clearTimeout(this.timer);
    const live = this.live();
    if (live.length === 1) return this.winUncontested(live[0]);
    for (const id of [...this.pending]) { const q = this.byId(id); if (!q || !this.canAct(q)) this.pending.delete(id); }
    const ca = live.filter(p => !p.allIn);
    if (ca.length === 0 || (ca.length === 1 && ca[0].bet >= this.currentBet)) this.pending.clear();
    if (this.pending.size === 0) return this.nextStreet();
    this.toAct = this.nextIdx(this.toAct, p => this.pending.has(p.id));
    this.armTimer();
    this.broadcast();
  }

  armTimer(ms = TURN_MS) {
    clearTimeout(this.timer);
    const gen = this.gen, idx = this.toAct;
    this.deadline = Date.now() + ms;
    this.timer = setTimeout(() => {
      if (gen !== this.gen || idx !== this.toAct) return;
      const p = this.players[idx];
      if (!p) return;
      this.act(p, this.currentBet - p.bet > 0 ? 'fold' : 'check');
    }, ms);
  }

  nextStreet() {
    for (const p of this.players) { p.bet = 0; if (!p.folded && !p.allIn) p.lastAction = ''; }
    this.currentBet = 0; this.minRaise = BB;
    const order = { preflop: 'flop', flop: 'turn', turn: 'river', river: 'showdown' };
    this.stage = order[this.stage];
    if (this.stage === 'flop') this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
    else if (this.stage === 'turn' || this.stage === 'river') this.community.push(this.deck.pop());
    if (this.stage === 'showdown') return this.showdown();
    if (this.stage === 'flop') this.addLog(`Flop: ${this.community.join(' ')}`);
    else this.addLog(`${this.stage[0].toUpperCase() + this.stage.slice(1)}: ${this.community.at(-1)}`);

    const ca = this.live().filter(p => !p.allIn);
    if (ca.length <= 1) {
      // everybody all-in: reveal and run out the board
      this.reveal = true; this.toAct = -1;
      this.broadcast();
      const gen = this.gen;
      this.timer = setTimeout(() => { if (gen === this.gen) this.nextStreet(); }, 1500);
      return;
    }
    this.pending = new Set(ca.map(p => p.id));
    this.toAct = this.dealer;
    this.afterAction();
  }

  winUncontested(w) {
    const pot = this.players.reduce((s, p) => s + p.total, 0);
    w.chips += pot;
    this.result = [{ names: [w.name], amount: pot, hand: null }];
    this.addLog(`${w.name} wins ${pot}`);
    this.endHand();
  }

  showdown() {
    this.reveal = true;
    const live = this.live();
    for (const p of live) p.best = bestHand([...p.hole, ...this.community]);
    const contrib = this.players.filter(p => p.total > 0);
    const levels = [...new Set(contrib.map(p => p.total))].sort((a, b) => a - b);
    let prev = 0;
    const results = [];
    for (const lvl of levels) {
      const amount = contrib.reduce((s, p) => s + Math.min(p.total, lvl) - Math.min(p.total, prev), 0);
      let elig = live.filter(p => p.total >= lvl);
      prev = lvl;
      if (!amount) continue;
      if (!elig.length) elig = live;
      let top = null;
      for (const p of elig) if (!top || cmp(p.best.score, top) > 0) top = p.best.score;
      const winners = elig.filter(p => cmp(p.best.score, top) === 0);
      // order winners starting left of dealer (for odd chips)
      winners.sort((a, b) => this.seatDist(a) - this.seatDist(b));
      const share = Math.floor(amount / winners.length);
      let rem = amount - share * winners.length;
      for (const w of winners) { w.chips += share + (rem > 0 ? 1 : 0); rem--; }
      const names = winners.map(w => w.name);
      const last = results.at(-1);
      if (last && last.names.join() === names.join()) last.amount += amount;
      else results.push({ names, amount, hand: winners[0].best.name });
    }
    this.result = results;
    for (const r of results) this.addLog(`${r.names.join(' & ')} win${r.names.length > 1 ? '' : 's'} ${r.amount} with ${r.hand}`);
    this.endHand();
  }

  seatDist(p) {
    const n = this.players.length;
    return ((this.players.indexOf(p) - this.dealer - 1) % n + n) % n;
  }

  endHand() {
    clearTimeout(this.timer);
    this.stage = 'showdown'; this.toAct = -1; this.pending.clear();
    for (const p of this.players) p.bet = 0;
    this.broadcast();
    const gen = ++this.gen;
    this.timer = setTimeout(() => { if (gen === this.gen) this.startHand(); }, NEXT_HAND_MS);
  }

  view(me) {
    return {
      type: 'state', code: this.code, stage: this.stage, handNo: this.handNo,
      community: this.community, pot: this.players.reduce((s, p) => s + p.total, 0),
      currentBet: this.currentBet, minRaise: this.minRaise, sb: SB, bb: BB,
      toAct: this.players[this.toAct]?.id || null, deadline: this.deadline, now: Date.now(),
      dealer: this.players[this.dealer]?.id || null, host: this.hostId, you: me.id,
      result: this.result, log: this.log.slice(-20),
      players: this.players.map(p => ({
        id: p.id, name: p.name, chips: p.chips, bet: p.bet, folded: p.folded, allIn: p.allIn,
        inHand: p.inHand, connected: p.connected, lastAction: p.lastAction,
        hole: p === me || (this.reveal && p.inHand && !p.folded) ? p.hole : p.inHand && !p.folded && p.hole.length ? ['??', '??'] : [],
        hand: this.reveal && p.best ? p.best.name : (p === me && p.hole.length ? bestHand([...p.hole, ...this.community]).name : null),
      })),
    };
  }

  broadcast() {
    for (const p of this.players) if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(this.view(p)));
  }
}

// ---------- Server ----------
const rooms = new Map();
const indexHtml = () => fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const server = http.createServer((req, res) => {
  if (req.url === '/health') return res.end('ok');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(indexHtml());
});

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  let room = null, me = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join') {
      let code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      if (!code) do code = crypto.randomBytes(3).toString('hex').toUpperCase(); while (rooms.has(code));
      room = rooms.get(code) || rooms.set(code, new Room(code)).get(code);
      clearTimeout(room.cleanup);
      me = room.join(ws, String(m.name || '').trim(), m.token);
      if (!me) { ws.send(JSON.stringify({ type: 'error', msg: 'Table is full (max 9).' })); room = null; return; }
      ws.send(JSON.stringify({ type: 'joined', code, token: me.id }));
      ws.send(JSON.stringify({ type: 'chatHistory', msgs: room.chat }));
      room.broadcast();
      return;
    }
    if (!room || !me) return;
    if (m.type === 'chat') {
      const text = String(m.text || '').trim().slice(0, 200);
      const now = Date.now();
      if (!text || now - (me.lastChat || 0) < 400) return;
      me.lastChat = now;
      const msg = { type: 'chat', id: me.id, name: me.name, text, t: now };
      room.chat.push(msg); if (room.chat.length > 50) room.chat.shift();
      const out = JSON.stringify(msg);
      for (const p of room.players) if (p.ws && p.ws.readyState === 1) p.ws.send(out);
      return;
    }
    if (m.type === 'start' && room.hostId === me.id && room.stage === 'waiting') room.startHand();
    else if (m.type === 'act') room.act(me, m.action, m.amount);
    else if (m.type === 'rebuy' && me.chips === 0 && !(me.inHand && room.inHandNow())) {
      me.chips = START_CHIPS; room.addLog(`${me.name} rebuys ${START_CHIPS}`); room.broadcast();
    }
  });
  ws.on('close', () => {
    if (!room || !me || me.ws !== ws) return;
    room.leave(me);
    room.broadcast();
    if (!room.players.some(p => p.connected)) {
      const r = room;
      r.cleanup = setTimeout(() => { if (!r.players.some(p => p.connected)) { clearTimeout(r.timer); rooms.delete(r.code); } }, 30 * 60 * 1000);
    }
  });
});

// keep connections alive behind proxies
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 25000);

if (require.main === module) server.listen(PORT, () => console.log(`Poker running on http://localhost:${PORT}`));

module.exports = { bestHand };
