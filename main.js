// main.js
// UI制御・ゲーム進行・Firebase連携のメインモジュール

import {
  auth,
  db,
  signInAnonymously,
  onAuthStateChanged,
  ref,
  get,
  set,
  update,
  onValue,
  remove,
  runTransaction,
  push
} from "./firebaseClient.js";

import { TicTacToeAI, checkWinnerForBoard } from "./ai.js";

// DOM 要素
const connectionStatusEl = document.getElementById("connectionStatus");
const userIdEl = document.getElementById("userId");
const ratingEl = document.getElementById("rating");
const statusEl = document.getElementById("status");
const matchButton = document.getElementById("matchButton");
const cancelButton = document.getElementById("cancelButton");
const rematchButton = document.getElementById("rematchButton");
const leaveButton = document.getElementById("leaveButton");
const boardEl = document.getElementById("board");
const nicknameInput = document.getElementById("nicknameInput");
const saveNicknameButton = document.getElementById("saveNicknameButton");
const rankingContent = document.getElementById("rankingContent");
const startSound = document.getElementById("startSound");

// 状態（共通）
let currentUser = null;
let currentRoomId = null;          // PvP 用ルームID
let playerSymbol = null;           // "X" or "O"（PvP のとき）
let isSearching = false;
let roomUnsubscribe = null;
let currentRoomData = null;
let rankingListenerSet = false;
let lastRoomStatus = null;         // 対戦開始SE用
let currentRating = 1500;

// ロビーの待機状況
let hasWaitingOpponent = false;
let queueListenerSet = false;
let baseStatusMessage = "ログイン待ち...";

// 盤面UI
const cells = [];

// PvP のターンタイマー（2秒）
let pvpTurnTimeoutId = null;

// AI 対戦用
let isAIGame = false;
let aiBoardStr = ".........";
let aiCurrentTurn = "X";           // 現在の手番（"X" or "O"）
let aiGameActive = false;
let aiThinking = false;

// vs AI へのフェイルオーバー用（マッチング10秒待ち）
let aiTimeoutId = null;

// AI プレイヤー情報
const ai = new TicTacToeAI(currentRating);
let aiHumanSymbol = "X";           // この対局で人間が使う記号
let aiAiSymbol = "O";              // この対局でAIが使う記号
let aiNextHumanSymbol = "X";       // 次の対局で人間が使う記号（X/Oで交互）
let aiHumanTimeoutId = null;       // 人間の2秒タイマー

// ---------------------------
// 共通ステータス管理
// ---------------------------
function isInGameNow() {
  if (isAIGame) {
    return aiGameActive;
  }
  if (currentRoomId && lastRoomStatus === "playing") {
    return true;
  }
  return false;
}

function applyStatus() {
  let msg = baseStatusMessage;
  if (isInGameNow() && hasWaitingOpponent) {
    msg += "（ロビーで誰かが対戦待ち中）";
  }
  statusEl.textContent = msg;
}

function setStatus(message) {
  baseStatusMessage = message;
  applyStatus();
}

// ---------------------------
// サウンド再生
// ---------------------------
function playStartSound() {
  if (!startSound) return;
  try {
    startSound.currentTime = 0;
    const p = startSound.play();
    if (p && typeof p.catch === "function") {
      p.catch(() => {
        // 自動再生制限で失敗しても無視
      });
    }
  } catch (e) {
    console.error("playStartSound error:", e);
  }
}

// ---------------------------
// UIヘルパー
// ---------------------------
function initBoardUI() {
  boardEl.innerHTML = "";
  cells.length = 0;
  for (let i = 0; i < 9; i++) {
    const btn = document.createElement("button");
    btn.className = "cell";
    btn.dataset.index = String(i);
    btn.textContent = "";
    btn.disabled = true;
    btn.addEventListener("click", () => handleCellClick(i));
    boardEl.appendChild(btn);
    cells.push(btn);
  }
}

function setSearchingUI(on) {
  isSearching = on;
  matchButton.disabled = on || !!currentRoomId || isAIGame;
  cancelButton.disabled = !on;
}

function setInGameUI(on) {
  leaveButton.disabled = !on;
  for (const cell of cells) {
    cell.disabled = !on;
  }
  if (on) {
    rematchButton.disabled = true;
  }
}

function updateBoardUI(boardStr) {
  const b = boardStr || ".........";
  for (let i = 0; i < 9; i++) {
    const ch = b[i] || ".";
    cells[i].textContent = ch === "." ? "" : ch;
  }
}

function resetBoardUI() {
  updateBoardUI(".........");
}

// ---------------------------
// PvP 用ターンタイマー（2秒）
// ---------------------------
function clearPvpTurnTimer() {
  if (pvpTurnTimeoutId) {
    clearTimeout(pvpTurnTimeoutId);
    pvpTurnTimeoutId = null;
  }
}

function schedulePvpTurnTimer(room) {
  clearPvpTurnTimer();
  if (!room || room.status !== "playing") return;
  const deadline = room.turnDeadline;
  if (typeof deadline !== "number") return;
  const delay = Math.max(0, deadline - Date.now());
  pvpTurnTimeoutId = setTimeout(() => {
    attemptSkipTurnForPvp();
  }, delay + 10);
}

async function attemptSkipTurnForPvp() {
  if (!currentRoomId) return;
  const roomRef = ref(db, "rooms/" + currentRoomId);
  try {
    await runTransaction(roomRef, (room) => {
      if (!room) return room;
      if (room.status !== "playing") return room;

      const deadline = room.turnDeadline;
      if (typeof deadline !== "number") return room;
      if (Date.now() < deadline) return room;

      // 時間切れ：手番を交代（盤面はそのまま）
      const cur = room.turn;
      const next = cur === "X" ? "O" : "X";
      room.turn = next;
      room.turnDeadline = Date.now() + 2000;
      return room;
    });
  } catch (e) {
    console.error("PVP timeout skip error:", e);
  }
}

// ---------------------------
// AI 用ターンタイマー（人間 2秒）
// ---------------------------
function clearAiHumanTimer() {
  if (aiHumanTimeoutId) {
    clearTimeout(aiHumanTimeoutId);
    aiHumanTimeoutId = null;
  }
}

function scheduleAiHumanTimer() {
  clearAiHumanTimer();
  if (!isAIGame || !aiGameActive) return;
  if (aiCurrentTurn !== aiHumanSymbol) return;
  aiHumanTimeoutId = setTimeout(() => {
    onAiHumanTimeout();
  }, 2000);
}

function onAiHumanTimeout() {
  aiHumanTimeoutId = null;
  if (!isAIGame || !aiGameActive) return;
  if (aiCurrentTurn !== aiHumanSymbol) return;

  // 時間切れ → AIの手番へ
  aiCurrentTurn = aiAiSymbol;
  aiThinking = true;
  setStatus(`対戦中：あなたは ${aiHumanSymbol} です。 相手の手番です。（時間切れ）`);

  setTimeout(() => {
    const move = ai.chooseMove(aiBoardStr, aiAiSymbol, aiHumanSymbol);
    if (move !== null && aiBoardStr[move] === ".") {
      const arr2 = aiBoardStr.split("");
      arr2[move] = aiAiSymbol;
      aiBoardStr = arr2.join("");
      updateBoardUI(aiBoardStr);
    }
    const result2 = checkWinnerForBoard(aiBoardStr);
    if (result2) {
      finishAiGame(result2);
    } else {
      aiCurrentTurn = aiHumanSymbol;
      aiThinking = false;
      setStatus(`対戦中：あなたは ${aiHumanSymbol} です。 あなたの手番です。`);
      scheduleAiHumanTimer();
    }
  }, 500);
}

// ---------------------------
// Firebase 認証 & ユーザー情報
// ---------------------------
async function initUserData(uid) {
  const userRef = ref(db, "users/" + uid);
  const snap = await get(userRef);
  if (!snap.exists()) {
    await set(userRef, {
      rating: 1500,
      currentRoom: null,
      currentSymbol: null,
      nickname: null
    });
  }
  onValue(userRef, (snapshot) => {
    const data = snapshot.val() || {};
    if (typeof data.rating === "number") {
      currentRating = data.rating;
      ratingEl.textContent = String(data.rating);
    } else {
      currentRating = 1500;
      ratingEl.textContent = "-";
    }
    // AI にもレートを反映
    ai.setRating(currentRating);

    if (data.currentSymbol === "X" || data.currentSymbol === "O") {
      playerSymbol = data.currentSymbol;
    }
    if (typeof data.nickname === "string") {
      nicknameInput.value = data.nickname;
    } else if (!nicknameInput.value) {
      nicknameInput.value = "";
    }
    const newRoomId = data.currentRoom || null;
    if (!currentRoomId && newRoomId && !isAIGame) {
      joinRoom(newRoomId);
    }
  });
}

// ランキング購読
function subscribeRanking() {
  if (rankingListenerSet) return;
  rankingListenerSet = true;

  const usersRef = ref(db, "users");
  onValue(usersRef, (snapshot) => {
    const list = [];
    snapshot.forEach((child) => {
      const val = child.val() || {};
      if (typeof val.rating === "number") {
        list.push({
          uid: child.key,
          rating: val.rating,
          nickname: typeof val.nickname === "string" && val.nickname.trim()
            ? val.nickname.trim()
            : ""
        });
      }
    });

    if (list.length === 0) {
      rankingContent.textContent = "まだ対戦履歴がありません。";
      return;
    }

    list.sort((a, b) => b.rating - a.rating);
    const top = list.slice(0, 20);

    const ol = document.createElement("ol");
    top.forEach((p) => {
      const li = document.createElement("li");
      const name = p.nickname || "(名無し)";
      const shortUid = p.uid.slice(0, 6);
      li.textContent = `${name} [${p.rating}] (${shortUid})`;
      if (currentUser && p.uid === currentUser.uid) {
        li.style.fontWeight = "bold";
      }
      ol.appendChild(li);
    });

    rankingContent.innerHTML = "";
    rankingContent.appendChild(ol);
  });
}

// ロビー待ち監視
function subscribeQueueInfo() {
  if (queueListenerSet) return;
  queueListenerSet = true;
  const queueRef = ref(db, "queue");
  onValue(queueRef, (snapshot) => {
    let found = false;
    snapshot.forEach((child) => {
      const uidKey = child.key;
      if (!currentUser || uidKey !== currentUser.uid) {
        found = true;
      }
    });
    hasWaitingOpponent = found;
    applyStatus();
  });
}

// ---------------------------
// マッチング（10秒待ち → AI fallback）
// ---------------------------
async function startMatchmaking() {
  if (!currentUser || isSearching || currentRoomId || isAIGame) {
    return;
  }
  if (aiTimeoutId) {
    clearTimeout(aiTimeoutId);
    aiTimeoutId = null;
  }

  setSearchingUI(true);
  setStatus("対戦相手を探しています…");

  const uid = currentUser.uid;
  const queueRef = ref(db, "queue");

  try {
    const snapshot = await get(queueRef);
    let opponentUid = null;

    if (snapshot.exists()) {
      snapshot.forEach((child) => {
        const otherUid = child.key;
        if (!opponentUid && otherUid !== uid) {
          opponentUid = otherUid;
        }
      });
    }

    if (opponentUid) {
      // 即マッチング（対人）
      const roomId = push(ref(db, "rooms")).key;
      const roomPath = "rooms/" + roomId;

      const updates = {};
      const initialBoard = ".........";

      updates[roomPath] = {
        players: {
          X: opponentUid,
          O: uid
        },
        board: initialBoard,
        turn: "X",
        status: "playing",
        winner: null,
        ratingUpdated: false,
        rematchRequests: null,
        rematchReady: null,
        turnDeadline: Date.now() + 2000 // 2秒制限の締切
      };

      updates["queue/" + uid] = null;
      updates["queue/" + opponentUid] = null;

      updates["users/" + uid + "/currentRoom"] = roomId;
      updates["users/" + uid + "/currentSymbol"] = "O";
      updates["users/" + opponentUid + "/currentRoom"] = roomId;
      updates["users/" + opponentUid + "/currentSymbol"] = "X";

      await update(ref(db), updates);

      setStatus("対戦が開始されました。");
      setSearchingUI(false);
    } else {
      // キューに入り、10秒待ってもマッチしなければ AI 対戦へ
      await set(ref(db, "queue/" + uid), {
        timestamp: Date.now()
      });
      setStatus("対戦相手を待っています…");

      aiTimeoutId = setTimeout(() => {
        aiTimeoutId = null;
        if (!currentRoomId && isSearching && !isAIGame) {
          startAIGameFallback();
        }
      }, 10000);
    }
  } catch (e) {
    console.error("Matching error:", e);
    setStatus("マッチング中にエラーが発生しました: " + e.message);
    setSearchingUI(false);
  }
}

async function cancelMatchmaking() {
  if (!currentUser || !isSearching || currentRoomId || isAIGame) {
    return;
  }
  setSearchingUI(false);
  setStatus("マッチングをキャンセルしました。");
  if (aiTimeoutId) {
    clearTimeout(aiTimeoutId);
    aiTimeoutId = null;
  }
  try {
    await remove(ref(db, "queue/" + currentUser.uid));
  } catch (e) {
    console.error("Cancel matching error:", e);
  }
}

async function startAIGameFallback() {
  if (!currentUser) return;
  try {
    await remove(ref(db, "queue/" + currentUser.uid));
  } catch (e) {
    console.error("AI fallback queue remove error:", e);
  }
  setSearchingUI(false);
  startAIGame();
}

// ---------------------------
// AI 対戦ロジック
// ---------------------------
function startAIGame() {
  if (roomUnsubscribe) {
    roomUnsubscribe();
    roomUnsubscribe = null;
  }
  currentRoomId = null;
  currentRoomData = null;
  playerSymbol = null;
  lastRoomStatus = null;
  clearPvpTurnTimer();

  isAIGame = true;
  aiBoardStr = ".........";

  // この対局での人間の記号を決定（X/Oが交互になる）
  aiHumanSymbol = aiNextHumanSymbol;
  aiAiSymbol = aiHumanSymbol === "X" ? "O" : "X";
  aiNextHumanSymbol = aiAiSymbol; // 次回は逆側の記号を使う

  aiCurrentTurn = "X";          // 常に X が先手
  aiGameActive = true;
  aiThinking = false;
  clearAiHumanTimer();

  setInGameUI(true);
  resetBoardUI();
  rematchButton.disabled = true;
  matchButton.disabled = true;
  cancelButton.disabled = true;

  playStartSound();

  if (aiCurrentTurn === aiHumanSymbol) {
    // 人間が先手
    setStatus(`対戦中：あなたは ${aiHumanSymbol} です。 あなたの手番です。`);
    scheduleAiHumanTimer();
  } else {
    // AIが先手
    setStatus(`対戦中：あなたは ${aiHumanSymbol} です。 相手の手番です。`);
    aiThinking = true;
    setTimeout(() => {
      const move = ai.chooseMove(aiBoardStr, aiAiSymbol, aiHumanSymbol);
      if (move !== null && aiBoardStr[move] === ".") {
        const arr = aiBoardStr.split("");
        arr[move] = aiAiSymbol;
        aiBoardStr = arr.join("");
        updateBoardUI(aiBoardStr);
      }
      const result = checkWinnerForBoard(aiBoardStr);
      if (result) {
        finishAiGame(result);
      } else {
        aiCurrentTurn = aiHumanSymbol;
        aiThinking = false;
        setStatus(`対戦中：あなたは ${aiHumanSymbol} です。 あなたの手番です。`);
        scheduleAiHumanTimer();
      }
    }, 500);
  }
}

function handleCellClickVsAI(index) {
  if (!isAIGame || !aiGameActive || aiThinking) return;
  if (aiCurrentTurn !== aiHumanSymbol) return;
  if (aiBoardStr[index] !== ".") return;

  clearAiHumanTimer();

  // 人間の手
  let arr = aiBoardStr.split("");
  arr[index] = aiHumanSymbol;
  aiBoardStr = arr.join("");
  updateBoardUI(aiBoardStr);

  let result = checkWinnerForBoard(aiBoardStr);
  if (result) {
    finishAiGame(result);
    return;
  }

  // AI の手番
  aiCurrentTurn = aiAiSymbol;
  aiThinking = true;
  setStatus(`対戦中：あなたは ${aiHumanSymbol} です。 相手の手番です。`);

  setTimeout(() => {
    const move = ai.chooseMove(aiBoardStr, aiAiSymbol, aiHumanSymbol);
    if (move !== null && aiBoardStr[move] === ".") {
      const arr2 = aiBoardStr.split("");
      arr2[move] = aiAiSymbol;
      aiBoardStr = arr2.join("");
      updateBoardUI(aiBoardStr);
    }
    const result2 = checkWinnerForBoard(aiBoardStr);
    if (result2) {
      finishAiGame(result2);
    } else {
      aiCurrentTurn = aiHumanSymbol;
      aiThinking = false;
      setStatus(`対戦中：あなたは ${aiHumanSymbol} です。 あなたの手番です。`);
      scheduleAiHumanTimer();
    }
  }, 500);
}

function finishAiGame(result) {
  aiGameActive = false;
  aiThinking = false;
  clearAiHumanTimer();

  let msg = "対戦終了：";
  let score = null;
  if (result === "draw") {
    msg += "引き分けです。";
    score = 0.5;
  } else if (result === aiHumanSymbol) {
    msg += "あなたの勝ちです！";
    score = 1;
  } else if (result === aiAiSymbol) {
    msg += "あなたの負けです…。";
    score = 0;
  } else {
    msg += "ゲーム終了。";
  }

  // vs AI でもレート変動
  if (currentUser && score !== null) {
    const K = 32;
    const ratingAI = currentRating; // AIのレートを自分と同じとみなす
    const expected = 1 / (1 + Math.pow(10, (ratingAI - currentRating) / 400));
    const newRating = Math.round(currentRating + K * (score - expected));
    currentRating = newRating;
    ratingEl.textContent = String(newRating);
    ai.setRating(newRating);
    update(ref(db, "users/" + currentUser.uid), {
      rating: newRating
    }).catch((e) => {
      console.error("AI rating update error:", e);
    });
  }

  msg += " 「再戦希望」で再戦できます。";
  setStatus(msg);
  rematchButton.disabled = false;
}

// ---------------------------
// 再戦希望
// ---------------------------
async function requestRematch() {
  // AI 対戦中の再戦
  if (isAIGame) {
    startAIGame();
    return;
  }

  // 通常の PvP 再戦
  if (!currentUser || !currentRoomId) return;
  const uid = currentUser.uid;
  const reqRef = ref(db, "rooms/" + currentRoomId + "/rematchRequests/" + uid);
  try {
    await set(reqRef, true);
    rematchButton.disabled = true;
    setStatus("再戦希望を送りました。相手の同意を待っています…");
  } catch (e) {
    console.error("Rematch request error:", e);
  }
}

async function tryStartRematchOnce(roomId) {
  const flagRef = ref(db, "rooms/" + roomId + "/rematchReady");
  try {
    const result = await runTransaction(flagRef, (current) => {
      if (current === true) {
        return;
      }
      return true;
    });
    if (!result.committed) return;
    await startRematch(roomId);
  } catch (e) {
    console.error("Rematch transaction error:", e);
  }
}

async function startRematch(roomId) {
  const roomRef = ref(db, "rooms/" + roomId);
  const roomSnap = await get(roomRef);
  if (!roomSnap.exists()) return;

  const room = roomSnap.val();
  if (room.status !== "finished") return;

  const players = room.players || {};
  const prevX = players.X;
  const prevO = players.O;
  if (!prevX || !prevO) return;

  const newPlayers = {
    X: prevO,
    O: prevX
  };

  const updates = {};
  const initialBoard = ".........";

  updates["rooms/" + roomId + "/players"] = newPlayers;
  updates["rooms/" + roomId + "/board"] = initialBoard;
  updates["rooms/" + roomId + "/turn"] = "X";
  updates["rooms/" + roomId + "/status"] = "playing";
  updates["rooms/" + roomId + "/winner"] = null;
  updates["rooms/" + roomId + "/ratingUpdated"] = false;
  updates["rooms/" + roomId + "/rematchRequests"] = null;
  updates["rooms/" + roomId + "/rematchReady"] = null;
  updates["rooms/" + roomId + "/turnDeadline"] = Date.now() + 2000;

  updates["users/" + prevX + "/currentSymbol"] = "O";
  updates["users/" + prevO + "/currentSymbol"] = "X";

  await update(ref(db), updates);
}

// ---------------------------
// ルーム参加 & 監視（PvP）
// ---------------------------
function joinRoom(roomId) {
  if (!roomId) return;

  if (roomUnsubscribe) {
    roomUnsubscribe();
    roomUnsubscribe = null;
  }

  isAIGame = false;
  aiGameActive = false;
  aiThinking = false;
  clearAiHumanTimer();
  currentRoomId = roomId;
  setSearchingUI(false);
  setInGameUI(true);
  rematchButton.disabled = true;
  resetBoardUI();
  lastRoomStatus = null;

  const roomRef = ref(db, "rooms/" + roomId);

  roomUnsubscribe = onValue(roomRef, async (snapshot) => {
    const room = snapshot.val();
    currentRoomData = room;

    if (!room) {
      clearPvpTurnTimer();
      setStatus("対戦が終了しました。（ルームが削除されました）");
      currentRoomId = null;
      playerSymbol = null;
      setInGameUI(false);
      rematchButton.disabled = true;
      resetBoardUI();
      lastRoomStatus = null;
      return;
    }

    // ターンタイマー更新
    schedulePvpTurnTimer(room);

    const prevStatus = lastRoomStatus;
    lastRoomStatus = room.status || null;
    if (room.status === "playing" && prevStatus !== "playing") {
      playStartSound();
    }

    updateBoardUI(room.board || ".........");

    if (currentUser && !playerSymbol) {
      const userSnap = await get(ref(db, "users/" + currentUser.uid));
      const userData = userSnap.val() || {};
      if (userData.currentSymbol === "X" || userData.currentSymbol === "O") {
        playerSymbol = userData.currentSymbol;
      }
    }

    if (!playerSymbol) {
      setStatus("対戦情報を取得中です…");
      return;
    }

    if (room.status === "playing") {
      rematchButton.disabled = true;
      const myTurn = room.turn === playerSymbol;
      let msg = `対戦中：あなたは ${playerSymbol} です。`;
      msg += myTurn ? " あなたの手番です。" : " 相手の手番です。";
      setStatus(msg);
    } else if (room.status === "finished") {
      let msg = "対戦終了：";
      if (room.winner === "draw") {
        msg += "引き分けです。";
      } else if (room.winner === playerSymbol) {
        msg += "あなたの勝ちです！";
      } else {
        msg += "あなたの負けです…。";
      }

      if (currentUser) {
        const myUid = currentUser.uid;
        const players = room.players || {};
        const opponentUid =
          players.X === myUid ? players.O :
          players.O === myUid ? players.X : null;
        const requests = room.rematchRequests || {};
        const myRequested = !!requests[myUid];
        const opponentRequested = opponentUid ? !!requests[opponentUid] : false;

        if (!myRequested) {
          rematchButton.disabled = false;
          msg += " 「再戦希望」を押すと相手にリクエストを送れます。";
        } else {
          rematchButton.disabled = true;
          if (!opponentRequested) {
            msg += " 再戦希望を送りました。相手の同意を待っています…";
          } else {
            msg += " 双方が再戦希望しました。まもなく再戦が始まります…";
          }
        }

        if (myRequested && opponentRequested && currentRoomId) {
          tryStartRematchOnce(currentRoomId);
        }
      } else {
        rematchButton.disabled = true;
      }

      setStatus(msg);

      if (currentRoomId) {
        tryUpdateRatingsOnce(roomId);
      }
    }
  });
}

// ---------------------------
// セルクリック（共通入口）
// ---------------------------
async function handleCellClick(index) {
  // AI 対戦中
  if (isAIGame) {
    handleCellClickVsAI(index);
    return;
  }

  // PvP
  if (!currentUser || !currentRoomId || !currentRoomData || !playerSymbol) {
    return;
  }

  try {
    const roomRef = ref(db, "rooms/" + currentRoomId);
    await runTransaction(roomRef, (room) => {
      if (room === null) return room;
      if (room.status !== "playing") return room;
      if (room.turn !== playerSymbol) return room;

      const boardStr = room.board || ".........";
      if (boardStr[index] !== ".") return room;

      const boardArr = boardStr.split("");
      boardArr[index] = playerSymbol;
      const newBoard = boardArr.join("");

      const result = checkWinnerForBoard(newBoard);
      const now = Date.now();

      room.board = newBoard;

      if (result === "X" || result === "O") {
        room.status = "finished";
        room.winner = result;
        room.turnDeadline = null;
      } else if (result === "draw") {
        room.status = "finished";
        room.winner = "draw";
        room.turnDeadline = null;
      } else {
        room.turn = playerSymbol === "X" ? "O" : "X";
        room.turnDeadline = now + 2000;
      }

      return room;
    });
  } catch (e) {
    console.error("Move error:", e);
  }
}

// ---------------------------
// レーティング更新（PvP）
// ---------------------------
async function tryUpdateRatingsOnce(roomId) {
  const flagRef = ref(db, "rooms/" + roomId + "/ratingUpdated");
  try {
    const result = await runTransaction(flagRef, (current) => {
      if (current === true) {
        return;
      }
      return true;
    });
    if (!result.committed) {
      return;
    }
    await updateRatings(roomId);
  } catch (e) {
    console.error("Rating transaction error:", e);
  }
}

async function updateRatings(roomId) {
  const roomRef = ref(db, "rooms/" + roomId);
  const roomSnap = await get(roomRef);
  if (!roomSnap.exists()) return;

  const room = roomSnap.val();
  if (room.status !== "finished") return;

  const players = room.players || {};
  const uidX = players.X;
  const uidO = players.O;
  if (!uidX || !uidO) return;

  const winner = room.winner;

  const [snapX, snapO] = await Promise.all([
    get(ref(db, "users/" + uidX)),
    get(ref(db, "users/" + uidO))
  ]);

  const dataX = snapX.val() || {};
  const dataO = snapO.val() || {};

  let ratingX = typeof dataX.rating === "number" ? dataX.rating : 1500;
  let ratingO = typeof dataO.rating === "number" ? dataO.rating : 1500;

  const K = 32;
  const expectedX = 1 / (1 + Math.pow(10, (ratingO - ratingX) / 400));
  const expectedO = 1 / (1 + Math.pow(10, (ratingX - ratingO) / 400));

  let scoreX, scoreO;
  if (winner === "X") {
    scoreX = 1;
    scoreO = 0;
  } else if (winner === "O") {
    scoreX = 0;
    scoreO = 1;
  } else if (winner === "draw") {
    scoreX = 0.5;
    scoreO = 0.5;
  } else {
    return;
  }

  const newRatingX = Math.round(ratingX + K * (scoreX - expectedX));
  const newRatingO = Math.round(ratingO + K * (scoreO - expectedO));

  const updates = {};
  updates["users/" + uidX + "/rating"] = newRatingX;
  updates["users/" + uidO + "/rating"] = newRatingO;

  await update(ref(db), updates);
}

// ---------------------------
// ルーム退出（PvP / AI両対応）
// ---------------------------
async function leaveRoom() {
  // AI対戦中の「退出」
  if (isAIGame) {
    isAIGame = false;
    aiGameActive = false;
    aiThinking = false;
    aiBoardStr = ".........";
    aiCurrentTurn = "X";
    clearAiHumanTimer();

    setInGameUI(false);
    setSearchingUI(false);
    rematchButton.disabled = true;
    resetBoardUI();
    matchButton.disabled = false;
    cancelButton.disabled = true;
    setStatus("ロビーに戻りました。");
    return;
  }

  // PvP の退出
  if (!currentUser) return;

  const uid = currentUser.uid;

  if (roomUnsubscribe) {
    roomUnsubscribe();
    roomUnsubscribe = null;
  }

  currentRoomId = null;
  playerSymbol = null;
  currentRoomData = null;
  lastRoomStatus = null;
  clearPvpTurnTimer();

  const updates = {};
  updates["users/" + uid + "/currentRoom"] = null;
  updates["users/" + uid + "/currentSymbol"] = null;

  try {
    await update(ref(db), updates);
  } catch (e) {
    console.error("Leave room error:", e);
  }

  setInGameUI(false);
  setSearchingUI(false);
  rematchButton.disabled = true;
  resetBoardUI();
  setStatus("ロビーに戻りました。");
}

// ---------------------------
// ニックネーム保存
// ---------------------------
async function saveNickname() {
  if (!currentUser) return;
  const name = nicknameInput.value.trim();
  if (name.length > 16) {
    setStatus("ニックネームは16文字以内にしてください。");
    return;
  }
  try {
    await update(ref(db, "users/" + currentUser.uid), {
      nickname: name || null
    });
    setStatus("ニックネームを更新しました。");
  } catch (e) {
    console.error("Save nickname error:", e);
    setStatus("ニックネームの更新中にエラーが発生しました。");
  }
}

// ---------------------------
// ウィンドウ閉じる前
// ---------------------------
window.addEventListener("beforeunload", () => {
  if (currentUser) {
    remove(ref(db, "queue/" + currentUser.uid)).catch(() => {});
  }
});

// ---------------------------
// イベント登録
// ---------------------------
matchButton.addEventListener("click", () => {
  startMatchmaking();
});

cancelButton.addEventListener("click", () => {
  cancelMatchmaking();
});

leaveButton.addEventListener("click", () => {
  leaveRoom();
});

rematchButton.addEventListener("click", () => {
  requestRematch();
});

saveNicknameButton.addEventListener("click", () => {
  saveNickname();
});

nicknameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveNickname();
  }
});

// ---------------------------
// 認証開始
// ---------------------------
async function startAuth() {
  initBoardUI();
  setInGameUI(false);
  setSearchingUI(false);
  rematchButton.disabled = true;
  connectionStatusEl.textContent = "匿名ログイン中…";

  try {
    await signInAnonymously(auth);
  } catch (e) {
    console.error("signInAnonymously error:", e);
    connectionStatusEl.textContent = "匿名ログインに失敗しました: " + e.message;
  }

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      currentUser = user;
      userIdEl.textContent = user.uid;
      connectionStatusEl.textContent = "ログイン済み";
      setStatus("レーティング情報を取得中…");
      await initUserData(user.uid);
      subscribeRanking();
      subscribeQueueInfo();
      setStatus("「対戦相手を探す」を押すとマッチング開始します。");
    } else {
      currentUser = null;
      userIdEl.textContent = "-";
      ratingEl.textContent = "-";
      connectionStatusEl.textContent = "未ログイン";
      setStatus("匿名ログインに失敗しました。");
    }
  });
}

// 起動
startAuth();
