// firebaseClient.js
// Firebase 初期化と、よく使う関数・オブジェクトのエクスポート

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  onValue,
  remove,
  runTransaction,
  push
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-database.js";

// あなたの Firebase 設定
const firebaseConfig = {
  apiKey: "AIzaSyDLQFUnt9f3thWU_27K1qMc-nEaKRKNucY",
  authDomain: "ox-game-f496d.firebaseapp.com",
  databaseURL: "https://ox-game-f496d-default-rtdb.firebaseio.com/",
  projectId: "ox-game-f496d",
  storageBucket: "ox-game-f496d.firebasestorage.app",
  messagingSenderId: "414536351496",
  appId: "1:414536351496:web:8bb92924feeffc1d03b6bd",
  measurementId: "G-ET20CFKJBF"
};

// Firebase 初期化
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// main.js から使うものをまとめて export
export {
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
};
