// ── DM ONLINE ──────────────────────────────────────────────
// State
const S = {
  myId: null,         // ホスト or ゲスト
  roomId: null,
  role: null,         // 'host' | 'guest'
  opponentReady: false,
  turn: null,         // 'host' | 'guest' (誰のターン)
  round: 1,
  phase: 'lobby',     // lobby | setup | waiting | playing

  // ローカルのデッキ・手札（相手には見えない）
  localDeck: [],      // [{id, img}] シャッフル済み
  localHand: [],      // [{id, img}]

  // 公開ゾーン（Firebase と同期）
  myZones: {
    battleZone: [],   // [{id, img, tapped}]
    manaZone:   [],   // [{id, img, tapped}]
    graveyard:  [],   // [{id, img}]
    shields:    [],   // [{id, img, broken}] 最大5
  },
  oppZones: {
    battleZone: [],
    manaZone:   [],
    graveyard:  [],
    shields:    [],   // 相手シールド（imgは非公開、brokenになったら公開）
  },
  oppHandCount: 0,
  oppDeckCount: 0,

  unsubscribe: null,  // Firebase listener解除用
  logs: [],
  dragState: null,    // ドラッグ中の情報

  graveModal: null,   // 'my' | 'opp' | null（墓地モーダル）
};

// ── UTILS ──────────────────────────────────────────────────
function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < 6; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function render(html) {
  document.getElementById('app').innerHTML = html;
}
function toast(msg, dur = 2500) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), dur);
}
function addLog(msg, type = 'sys') {
  S.logs.unshift({ msg, type });
  if (S.logs.length > 30) S.logs.pop();
  const el = document.getElementById('game-log');
  if (el) {
    el.innerHTML = S.logs.map(l =>
      `<div class="log-entry ${l.type}">${l.msg}</div>`
    ).join('');
  }
}
function resizeImage(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const W = 200, H = 280;
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        // カバーフィット
        const scale = Math.max(W / img.width, H / img.height);
        const sw = img.width * scale, sh = img.height * scale;
        ctx.drawImage(img, (W - sw) / 2, (H - sh) / 2, sw, sh);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── FIREBASE HELPERS ───────────────────────────────────────
function dbRef(path) { return FB.ref(RTDB, path); }
function dbSet(path, val) { return FB.set(dbRef(path), val); }
function dbUpdate(path, val) { return FB.update(dbRef(path), val); }
function dbGet(path) { return FB.get(dbRef(path)); }

function myPath(sub)  { return `dm-rooms/${S.roomId}/${S.role}/${sub}`; }
function oppPath(sub) {
  const opp = S.role === 'host' ? 'guest' : 'host';
  return `dm-rooms/${S.roomId}/${opp}/${sub}`;
}
function roomPath(sub) { return `dm-rooms/${S.roomId}/${sub}`; }

// ── LOBBY ──────────────────────────────────────────────────
function renderLobby() {
  S.phase = 'lobby';
  render(`
    <div class="lobby">
      <h1>DM Online</h1>
      <p class="subtitle">デュエルマスターズ オンライン対戦ツール</p>
      <div class="lobby-card">
        <h2>ルームを作成</h2>
        <button class="btn" onclick="createRoom()">ルームを作る（ホスト）</button>
        <hr class="divider">
        <h2>ルームに参加</h2>
        <input type="text" id="room-input" placeholder="ルームIDを入力（例: AB3K7Z）"
          maxlength="6" style="text-transform:uppercase"
          oninput="this.value=this.value.toUpperCase()">
        <button class="btn secondary" onclick="joinRoom()">参加する</button>
      </div>
    </div>
  `);
}

async function createRoom() {
  const id = roomCode();
  S.roomId = id;
  S.role = 'host';
  S.myId = 'host';
  await dbSet(roomPath('meta'), { createdAt: Date.now(), hostReady: false, guestReady: false, turn: 'host', round: 1 });
  renderSetup();
}

async function joinRoom() {
  const id = document.getElementById('room-input')?.value.trim().toUpperCase();
  if (!id || id.length !== 6) { toast('ルームIDを6文字で入力してください'); return; }
  const snap = await dbGet(`dm-rooms/${id}/meta`);
  if (!snap.exists()) { toast('ルームが見つかりません'); return; }
  S.roomId = id;
  S.role = 'guest';
  S.myId = 'guest';
  renderSetup();
}

// ── DECK SETUP ─────────────────────────────────────────────
function renderSetup() {
  S.phase = 'setup';
  render(`
    <div class="setup">
      <h2>デッキをセットアップ</h2>
      <p style="color:var(--text2)">カード画像を40枚選択してください</p>

      <div class="deck-drop-area" id="drop-area"
        onclick="document.getElementById('file-input').click()"
        ondragover="event.preventDefault();this.classList.add('dragover')"
        ondragleave="this.classList.remove('dragover')"
        ondrop="handleFileDrop(event)">
        <span class="icon">🃏</span>
        <span>クリックまたはドラッグ＆ドロップ</span>
        <span style="font-size:11px;color:var(--text2)">40枚のカード画像（JPG/PNG）</span>
      </div>
      <input type="file" id="file-input" accept="image/*" multiple style="display:none"
        onchange="handleFileSelect(this.files)">

      <div id="deck-preview" class="deck-preview"></div>
      <p id="deck-status" class="status"></p>
      <button class="btn" id="ready-btn" style="display:none" onclick="confirmDeck()">準備完了！</button>
    </div>
  `);
}

async function handleFileDrop(e) {
  e.preventDefault();
  document.getElementById('drop-area').classList.remove('dragover');
  await handleFileSelect(e.dataTransfer.files);
}

async function handleFileSelect(files) {
  const arr = Array.from(files).filter(f => f.type.startsWith('image/'));
  if (arr.length === 0) { toast('画像ファイルを選択してください'); return; }

  const statusEl = document.getElementById('deck-status');
  statusEl.className = 'status wait';
  statusEl.textContent = `読み込み中… 0/${arr.length}`;

  const cards = [];
  for (let i = 0; i < arr.length; i++) {
    const img = await resizeImage(arr[i]);
    cards.push({ id: uid(), img });
    statusEl.textContent = `読み込み中… ${i+1}/${arr.length}`;
  }

  // プレビュー
  const preview = document.getElementById('deck-preview');
  preview.innerHTML = cards.map(c => `<img src="${c.img}" alt="">`).join('');

  const count = cards.length;
  if (count !== 40) {
    statusEl.className = 'status';
    statusEl.style.color = '#ff9800';
    statusEl.textContent = `${count}枚（40枚推奨ですがこのまま続けることもできます）`;
  } else {
    statusEl.className = 'status ok';
    statusEl.textContent = `${count}枚 ✓`;
  }

  // デッキとして保存（シャッフルは後で）
  S._deckImages = cards;
  document.getElementById('ready-btn').style.display = '';
}

async function confirmDeck() {
  if (!S._deckImages || S._deckImages.length === 0) return;
  const btn = document.getElementById('ready-btn');
  btn.disabled = true;
  btn.textContent = '準備中…';

  // シャッフル
  S.localDeck = shuffle(S._deckImages);

  // シールド5枚セット
  const shieldCards = S.localDeck.splice(0, 5);
  S.myZones.shields = shieldCards.map(c => ({ id: c.id, img: c.img, broken: false }));

  // 手札5枚ドロー
  S.localHand = S.localDeck.splice(0, 5);

  // Firebase に公開情報をアップ
  // シールドは枚数のみ（imgは非公開）・手札も枚数のみ
  await dbSet(myPath('public'), {
    deckCount: S.localDeck.length,
    handCount: S.localHand.length,
    shields: S.myZones.shields.map(s => ({ id: s.id, broken: false })), // imgなし
    battleZone: [],
    manaZone: [],
    graveyard: [],
  });
  await dbUpdate(roomPath('meta'), S.role === 'host' ? { hostReady: true } : { guestReady: true });

  renderWaiting();
}

// ── WAITING ────────────────────────────────────────────────
function renderWaiting() {
  S.phase = 'waiting';
  render(`
    <div class="waiting">
      <h2>ルームID</h2>
      <div class="room-code">${S.roomId}</div>
      <p>相手の参加を待っています…</p>
      <div class="spinner"></div>
      <p style="font-size:11px">このIDを相手に伝えてください</p>
    </div>
  `);
  listenForGameStart();
}

function listenForGameStart() {
  const { onValue } = FB;
  const unsub = onValue(dbRef(roomPath('meta')), snap => {
    const meta = snap.val();
    if (!meta) return;
    const bothReady = meta.hostReady && meta.guestReady;
    if (bothReady) {
      unsub();
      S.turn = meta.turn || 'host';
      S.round = meta.round || 1;
      startGame();
    }
  });
}

// ── GAME START ─────────────────────────────────────────────
function startGame() {
  S.phase = 'playing';
  addLog('ゲーム開始！', 'sys');
  addLog(S.turn === S.role ? 'あなたのターンから始まります' : '相手のターンから始まります', 'sys');
  renderBoard();
  listenOpponent();
}

function listenOpponent() {
  const opp = S.role === 'host' ? 'guest' : 'host';
  const { onValue } = FB;

  // 相手の公開ゾーン監視
  const unsub1 = onValue(dbRef(`dm-rooms/${S.roomId}/${opp}/public`), snap => {
    const data = snap.val();
    if (!data) return;
    S.oppDeckCount = data.deckCount || 0;
    S.oppHandCount = data.handCount || 0;
    // シールド：相手のimgはサーバーにないので表示は枚数のみ
    S.oppZones.shields = (data.shields || []).map(s => ({ id: s.id, broken: s.broken, img: s.img || null }));
    S.oppZones.battleZone = data.battleZone || [];
    S.oppZones.manaZone   = data.manaZone   || [];
    S.oppZones.graveyard  = data.graveyard  || [];
    if (S.phase === 'playing') renderBoard();
  });

  // ターン・メタ監視
  const unsub2 = onValue(dbRef(roomPath('meta')), snap => {
    const meta = snap.val();
    if (!meta || S.phase !== 'playing') return;
    if (meta.turn !== S.turn || meta.round !== S.round) {
      S.turn = meta.turn;
      S.round = meta.round;
      if (S.turn === S.role) {
        addLog('あなたのターンです', 'mine');
        toast('あなたのターンです！');
      } else {
        addLog('相手のターンです', 'opp');
      }
      renderBoard();
    }
  });

  // ログ監視
  const unsub3 = onValue(dbRef(roomPath('logs')), snap => {
    const logs = snap.val();
    if (!logs) return;
    // 相手のログを表示
    const entries = Object.values(logs).sort((a,b) => a.t - b.t);
    entries.forEach(e => {
      if (e.role !== S.role) {
        addLog(e.msg, 'opp');
      }
    });
  });

  S.unsubscribe = () => { unsub1(); unsub2(); unsub3(); };
}

async function pushLog(msg) {
  const { push } = FB;
  await FB.push(dbRef(roomPath('logs')), { msg, role: S.role, t: Date.now() });
}

// ── SYNC MY ZONES ──────────────────────────────────────────
async function syncMyZones() {
  await dbUpdate(myPath('public'), {
    deckCount: S.localDeck.length,
    handCount: S.localHand.length,
    shields: S.myZones.shields.map(s => ({
      id: s.id,
      broken: s.broken,
      img: s.broken ? s.img : null   // 割れたシールドのみ画像公開
    })),
    battleZone: S.myZones.battleZone,
    manaZone:   S.myZones.manaZone,
    graveyard:  S.myZones.graveyard,
  });
}

// ── BOARD RENDER ───────────────────────────────────────────
function renderBoard() {
  const isMyTurn = S.turn === S.role;

  // 相手エリア
  const oppBZ   = renderZoneCards(S.oppZones.battleZone, 'opp', 'battleZone');
  const oppMana = renderZoneCards(S.oppZones.manaZone, 'opp', 'manaZone');
  const oppGrave= renderGraveyard(S.oppZones.graveyard, 'opp');
  const oppDeck = renderDeckPile(S.oppDeckCount, false, 'opp');
  const oppShields = renderShields(S.oppZones.shields, 'opp');
  const oppHandInfo = `<span style="color:var(--text2);font-size:11px">手札: ${S.oppHandCount}枚</span>`;

  // 自分エリア
  const myBZ   = renderZoneCards(S.myZones.battleZone, 'my', 'battleZone');
  const myMana = renderZoneCards(S.myZones.manaZone, 'my', 'manaZone');
  const myGrave= renderGraveyard(S.myZones.graveyard, 'my');
  const myDeck = renderDeckPile(S.localDeck.length, true, 'my');
  const myShields = renderShields(S.myZones.shields, 'my');
  const myHand  = renderHandZone();

  const html = `
    <div class="board">
      <!-- Header -->
      <div class="board-header">
        <span class="room-id">ルーム <span>${S.roomId}</span></span>
        <span class="turn-indicator ${isMyTurn ? 'my-turn' : ''}">${isMyTurn ? '▶ あなたのターン' : '相手のターン'}</span>
        <span class="round">ラウンド ${S.round}</span>
        <span class="spacer"></span>
        <span style="color:var(--text2);font-size:11px">自分: ${S.role === 'host' ? 'ホスト' : 'ゲスト'}</span>
      </div>

      <!-- 相手エリア -->
      <div class="player-area opponent">
        <div class="zone-row shields-row">
          ${oppDeck}
          ${oppGrave}
          <div style="flex:1"></div>
          ${oppShields}
          <div style="margin-left:8px">${oppHandInfo}</div>
        </div>
        <div class="zone-row">
          <div class="zone battle" id="zone-opp-battleZone" data-zone="battleZone" data-owner="opp">
            <span class="zone-label">バトルゾーン（相手）</span>
            ${oppBZ}
          </div>
        </div>
        <div class="zone-row">
          <div class="zone mana" id="zone-opp-manaZone" data-zone="manaZone" data-owner="opp">
            <span class="zone-label">マナゾーン（相手）</span>
            ${oppMana}
          </div>
        </div>
      </div>

      <div class="board-divider"></div>

      <!-- 自分エリア -->
      <div class="player-area">
        <div class="zone-row">
          <div class="zone mana" id="zone-my-manaZone" data-zone="manaZone" data-owner="my"
            ondragover="onDragOver(event)" ondragleave="onDragLeave(event)" ondrop="onDrop(event,'my','manaZone')">
            <span class="zone-label">マナゾーン</span>
            ${myMana}
          </div>
        </div>
        <div class="zone-row">
          <div class="zone battle" id="zone-my-battleZone" data-zone="battleZone" data-owner="my"
            ondragover="onDragOver(event)" ondragleave="onDragLeave(event)" ondrop="onDrop(event,'my','battleZone')">
            <span class="zone-label">バトルゾーン</span>
            ${myBZ}
          </div>
        </div>
        <div class="zone-row shields-row">
          ${myDeck}
          ${myGrave}
          <div style="flex:1"></div>
          ${myShields}
        </div>
        <!-- 手札 -->
        <div class="zone-row">
          <div class="zone hand" id="zone-my-hand" data-zone="hand" data-owner="my"
            ondragover="onDragOver(event)" ondragleave="onDragLeave(event)" ondrop="onDrop(event,'my','hand')">
            <span class="zone-label">手札</span>
            ${myHand}
          </div>
        </div>
      </div>

      <!-- アクションバー -->
      <div class="action-bar">
        <button class="btn draw-btn" onclick="drawCard()" ${!isMyTurn ? 'disabled' : ''}>
          デッキからドロー（残${S.localDeck.length}枚）
        </button>
        <span class="spacer"></span>
        <button class="btn end-turn" onclick="endTurn()" ${!isMyTurn ? 'disabled' : ''}>
          ターン終了
        </button>
      </div>
    </div>
    <div id="game-log" class="game-log"></div>
  `;

  render(html);

  // ドラッグゴースト
  if (!document.getElementById('drag-ghost')) {
    const g = document.createElement('div');
    g.id = 'drag-ghost';
    g.innerHTML = '<img src="" alt="">';
    document.body.appendChild(g);
  }

  // ログ再描画
  const logEl = document.getElementById('game-log');
  if (logEl) {
    logEl.innerHTML = S.logs.map(l =>
      `<div class="log-entry ${l.type}">${l.msg}</div>`
    ).join('');
  }

  // 墓地モーダルが開いていたら再表示
  if (S.graveModal) openGraveyard(S.graveModal);
}

// ── ZONE CARD RENDERING ────────────────────────────────────
function renderZoneCards(cards, owner, zone) {
  if (!cards || cards.length === 0) return '';
  return cards.map((c, i) => {
    const tapStyle = c.tapped ? 'tapped' : '';
    const events = owner === 'my'
      ? `draggable="true"
         onmousedown="startHover(event,'${c.img}')"
         onmouseup="endHover()"
         onmouseleave="endHover()"
         ondragstart="onDragStart(event,'${owner}','${zone}',${i})"
         ondragend="onDragEnd()"
         onclick="onCardClick(event,'${owner}','${zone}',${i})"
         `
      : `onmousedown="startHover(event,'${c.img}')"
         onmouseup="endHover()"
         onmouseleave="endHover()"
         onclick="onCardClick(event,'${owner}','${zone}',${i})"
         `;
    return `<div class="card ${tapStyle}" data-owner="${owner}" data-zone="${zone}" data-idx="${i}" ${events}>
      <img src="${c.img}" alt="">
    </div>`;
  }).join('');
}

function renderHandZone() {
  if (!S.localHand || S.localHand.length === 0) return '';
  return S.localHand.map((c, i) =>
    `<div class="card" data-owner="my" data-zone="hand" data-idx="${i}"
       draggable="true"
       onmousedown="startHover(event,'${c.img}')"
       onmouseup="endHover()"
       onmouseleave="endHover()"
       ondragstart="onDragStart(event,'my','hand',${i})"
       ondragend="onDragEnd()"
       onclick="onCardClick(event,'my','hand',${i})">
      <img src="${c.img}" alt="">
    </div>`
  ).join('');
}

function renderShields(shields, owner) {
  const MAX = 5;
  let html = '<div class="shields-container">';
  for (let i = 0; i < MAX; i++) {
    const s = shields[i];
    if (!s) {
      html += `<div class="shield-slot empty"></div>`;
    } else if (s.broken) {
      // 割れたシールド（自分だけimgあり）
      const imgSrc = s.img || '';
      html += `<div class="shield-slot"
        onmousedown="${imgSrc ? `startHover(event,'${imgSrc}')` : ''}"
        onmouseup="endHover()" onmouseleave="endHover()"
        ${owner === 'my' ? `onclick="breakShield(${i})" title="クリックで手札へ"` : ''}>
        ${imgSrc
          ? `<img src="${imgSrc}" alt="">`
          : `<div class="shield-back">🛡</div>`}
      </div>`;
    } else {
      // 未割れシールド
      const isMyShield = owner === 'my';
      const hoverImg = isMyShield ? s.img : '';
      html += `<div class="shield-slot"
        ${hoverImg ? `onmousedown="startHover(event,'${hoverImg}')" onmouseup="endHover()" onmouseleave="endHover()"` : ''}
        ${isMyShield ? `draggable="true" ondragstart="onDragStart(event,'my','shields',${i})" ondragend="onDragEnd()"` : ''}
        data-owner="${owner}" data-zone="shields" data-idx="${i}">
        <div class="shield-back">🛡</div>
      </div>`;
    }
  }
  html += '</div>';
  return html;
}

function renderDeckPile(count, clickable, owner) {
  return `
    <div class="side-zone">
      <span class="side-zone-label">山札</span>
      <div class="deck-card" ${clickable ? 'onclick="drawCard()" title="クリックでドロー"' : ''}>
        <div style="font-size:28px;opacity:0.4">🂠</div>
        <span class="deck-count">${count}</span>
      </div>
    </div>`;
}

function renderGraveyard(cards, owner) {
  const count = cards ? cards.length : 0;
  const topImg = count > 0 ? cards[count - 1].img : null;
  const clickFn = `openGraveyard('${owner}')`;
  return `
    <div class="side-zone">
      <span class="side-zone-label">墓地</span>
      <div class="grave-card ${owner === 'my' ? 'drop-target-check' : ''}"
        id="grave-${owner}"
        onclick="${clickFn}"
        ${owner === 'my' ? `ondragover="onDragOver(event)" ondragleave="onDragLeave(event)" ondrop="onDrop(event,'my','graveyard')"` : ''}
        title="${count}枚 クリックで確認">
        ${topImg ? `<img src="${topImg}" alt="">` : '<span style="font-size:20px;opacity:0.3">💀</span>'}
        ${count > 0 ? `<span class="grave-count">${count}</span>` : ''}
      </div>
    </div>`;
}

// ── CARD INTERACTIONS ──────────────────────────────────────
function getCardFromZone(owner, zone, idx) {
  if (owner === 'my') {
    if (zone === 'hand')       return S.localHand[idx];
    if (zone === 'shields')    return S.myZones.shields[idx];
    if (zone === 'battleZone') return S.myZones.battleZone[idx];
    if (zone === 'manaZone')   return S.myZones.manaZone[idx];
    if (zone === 'graveyard')  return S.myZones.graveyard[idx];
  }
  return null;
}

function removeCardFromZone(owner, zone, idx) {
  if (owner !== 'my') return null;
  let card;
  if (zone === 'hand')       card = S.localHand.splice(idx, 1)[0];
  else if (zone === 'shields')    card = S.myZones.shields.splice(idx, 1)[0];
  else if (zone === 'battleZone') card = S.myZones.battleZone.splice(idx, 1)[0];
  else if (zone === 'manaZone')   card = S.myZones.manaZone.splice(idx, 1)[0];
  else if (zone === 'graveyard')  card = S.myZones.graveyard.splice(idx, 1)[0];
  return card;
}

function addCardToZone(zone, card) {
  if (zone === 'hand')         S.localHand.push(card);
  else if (zone === 'battleZone') S.myZones.battleZone.push({ ...card, tapped: false });
  else if (zone === 'manaZone')   S.myZones.manaZone.push({ ...card, tapped: false });
  else if (zone === 'graveyard')  S.myZones.graveyard.push(card);
}

// タップ/アンタップ
function onCardClick(e, owner, zone, idx) {
  // ドラッグ後のクリックは無視
  if (S._justDragged) { S._justDragged = false; return; }
  if (owner !== 'my') return;
  if (zone === 'battleZone' || zone === 'manaZone') {
    const arr = zone === 'battleZone' ? S.myZones.battleZone : S.myZones.manaZone;
    if (arr[idx]) {
      arr[idx].tapped = !arr[idx].tapped;
      const label = arr[idx].tapped ? 'タップ' : 'アンタップ';
      addLog(`${zone === 'battleZone' ? 'バトルゾーン' : 'マナゾーン'}のカードを${label}`, 'mine');
      pushLog(`相手が${zone === 'battleZone' ? 'バトルゾーン' : 'マナゾーン'}のカードを${label}`);
      syncMyZones();
      renderBoard();
    }
  }
}

// ── DRAG & DROP ────────────────────────────────────────────
function onDragStart(e, owner, zone, idx) {
  S.dragState = { owner, zone, idx };
  const card = getCardFromZone(owner, zone, idx);
  if (!card) return;

  // ゴースト表示
  const ghost = document.getElementById('drag-ghost');
  if (ghost) {
    ghost.querySelector('img').src = card.img;
    ghost.style.display = 'block';
    ghost.style.left = (e.clientX - 36) + 'px';
    ghost.style.top  = (e.clientY - 50) + 'px';
  }
  e.dataTransfer.setDragImage(new Image(), 0, 0);
  e.dataTransfer.effectAllowed = 'move';

  // ドラッグ中のカードを薄く
  setTimeout(() => {
    const el = document.querySelector(`.card[data-owner="${owner}"][data-zone="${zone}"][data-idx="${idx}"]`);
    if (el) el.classList.add('dragging');
  }, 0);

  document.addEventListener('dragover', ghostMove);
}

function ghostMove(e) {
  const ghost = document.getElementById('drag-ghost');
  if (ghost) {
    ghost.style.left = (e.clientX - 36) + 'px';
    ghost.style.top  = (e.clientY - 50) + 'px';
  }
}

function onDragEnd() {
  const ghost = document.getElementById('drag-ghost');
  if (ghost) ghost.style.display = 'none';
  document.removeEventListener('dragover', ghostMove);
  S._justDragged = true;
  document.querySelectorAll('.card.dragging').forEach(el => el.classList.remove('dragging'));
  document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drop-target');
}
function onDragLeave(e) {
  e.currentTarget.classList.remove('drop-target');
}

function onDrop(e, toOwner, toZone) {
  e.preventDefault();
  e.currentTarget.classList.remove('drop-target');
  if (!S.dragState) return;

  const { owner, zone, idx } = S.dragState;
  S.dragState = null;

  // 自分のカードのみ移動可能
  if (owner !== 'my') return;
  // 同じゾーンへのドロップは無視
  if (owner === toOwner && zone === toZone) return;
  // 相手エリアへの移動は不可
  if (toOwner === 'opp') return;

  const card = removeCardFromZone(owner, zone, idx);
  if (!card) return;

  // tapped フラグをリセット（手札や墓地に戻る場合）
  if (toZone === 'hand' || toZone === 'graveyard') {
    delete card.tapped;
  }

  addCardToZone(toZone, card);

  const zoneNames = { hand: '手札', battleZone: 'バトルゾーン', manaZone: 'マナゾーン', graveyard: '墓地', shields: 'シールド' };
  const from = zoneNames[zone] || zone;
  const to   = zoneNames[toZone] || toZone;
  addLog(`${from} → ${to}`, 'mine');
  pushLog(`相手が${from}から${to}へカードを移動`);

  syncMyZones();
  renderBoard();
}

// ── SHIELD BREAK ───────────────────────────────────────────
function breakShield(idx) {
  const s = S.myZones.shields[idx];
  if (!s) return;
  // シールドを割られた → 手札へ移動
  S.myZones.shields[idx].broken = true;
  S.localHand.push({ id: s.id, img: s.img });
  addLog(`シールドが割られた！ 手札に加えました`, 'opp');
  syncMyZones();
  renderBoard();
}

// ── DRAW ───────────────────────────────────────────────────
function drawCard() {
  if (S.localDeck.length === 0) { toast('デッキが0枚です！'); return; }
  const card = S.localDeck.shift();
  S.localHand.push(card);
  addLog(`ドロー（残${S.localDeck.length}枚）`, 'mine');
  pushLog('相手がカードをドロー');
  syncMyZones();
  renderBoard();
}

// ── TURN END ───────────────────────────────────────────────
async function endTurn() {
  if (S.turn !== S.role) return;
  // 自分のマナ・BZのカードをアンタップ
  S.myZones.battleZone.forEach(c => c.tapped = false);
  S.myZones.manaZone.forEach(c => c.tapped = false);

  const nextTurn = S.role === 'host' ? 'guest' : 'host';
  const nextRound = nextTurn === 'host' ? S.round + 1 : S.round;

  S.turn = nextTurn;
  S.round = nextRound;

  addLog('ターン終了 → 相手のターン', 'mine');
  pushLog('相手がターンエンド');

  await syncMyZones();
  await dbUpdate(roomPath('meta'), { turn: nextTurn, round: nextRound });
  renderBoard();
}

// ── GRAVEYARD MODAL ────────────────────────────────────────
function openGraveyard(owner) {
  S.graveModal = owner;
  const cards = owner === 'my' ? S.myZones.graveyard : S.oppZones.graveyard;
  const title = owner === 'my' ? '自分の墓地' : '相手の墓地';

  const existing = document.getElementById('grave-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'grave-modal';
  modal.innerHTML = `
    <div class="modal">
      <h3>${title}（${cards.length}枚）</h3>
      <div class="card-list">
        ${cards.length === 0
          ? '<span style="color:var(--text2)">まだカードがありません</span>'
          : cards.map((c, i) => `
              <div class="card"
                onmousedown="startHover(event,'${c.img}')"
                onmouseup="endHover()"
                onmouseleave="endHover()"
                ${owner === 'my' ? `onclick="reviveFromGrave(${i})"  title="クリックで手札に戻す"` : ''}>
                <img src="${c.img}" alt="">
              </div>`).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn secondary" onclick="closeGraveyard()">閉じる</button>
      </div>
    </div>
  `;
  modal.addEventListener('click', e => { if (e.target === modal) closeGraveyard(); });
  document.body.appendChild(modal);
}

function closeGraveyard() {
  S.graveModal = null;
  const el = document.getElementById('grave-modal');
  if (el) el.remove();
}

function reviveFromGrave(idx) {
  const card = S.myZones.graveyard.splice(idx, 1)[0];
  if (!card) return;
  S.localHand.push(card);
  addLog('墓地から手札に戻した', 'mine');
  pushLog('相手が墓地から手札にカードを戻した');
  closeGraveyard();
  syncMyZones();
  renderBoard();
}

// ── CARD ZOOM (HOVER) ──────────────────────────────────────
let _hoverTimer = null;
function startHover(e, imgSrc) {
  if (!imgSrc) return;
  clearTimeout(_hoverTimer);
  _hoverTimer = setTimeout(() => {
    const zoom = document.getElementById('card-zoom');
    if (!zoom) return;
    zoom.querySelector('img').src = imgSrc;
    zoom.style.display = 'block';
    positionZoom(e);
  }, 400);

  document.addEventListener('mousemove', moveZoom);
}
function endHover() {
  clearTimeout(_hoverTimer);
  document.removeEventListener('mousemove', moveZoom);
  const zoom = document.getElementById('card-zoom');
  if (zoom) zoom.style.display = 'none';
}
function moveZoom(e) {
  positionZoom(e);
}
function positionZoom(e) {
  const zoom = document.getElementById('card-zoom');
  if (!zoom || zoom.style.display === 'none') return;
  const W = window.innerWidth, H = window.innerHeight;
  const zw = 236, zh = 324;
  let x = e.clientX + 16, y = e.clientY - 20;
  if (x + zw > W) x = e.clientX - zw - 8;
  if (y + zh > H) y = H - zh - 8;
  if (y < 0) y = 8;
  zoom.style.left = x + 'px';
  zoom.style.top  = y + 'px';
}

// ── INIT ───────────────────────────────────────────────────
window.addEventListener('load', () => {
  renderLobby();
});

// グローバル公開（HTML onclick から呼ぶため）
window.createRoom       = createRoom;
window.joinRoom         = joinRoom;
window.handleFileDrop   = handleFileDrop;
window.handleFileSelect = handleFileSelect;
window.confirmDeck      = confirmDeck;
window.drawCard         = drawCard;
window.endTurn          = endTurn;
window.onDragStart      = onDragStart;
window.onDragEnd        = onDragEnd;
window.onDragOver       = onDragOver;
window.onDragLeave      = onDragLeave;
window.onDrop           = onDrop;
window.onCardClick      = onCardClick;
window.startHover       = startHover;
window.endHover         = endHover;
window.openGraveyard    = openGraveyard;
window.closeGraveyard   = closeGraveyard;
window.reviveFromGrave  = reviveFromGrave;
window.breakShield      = breakShield;
