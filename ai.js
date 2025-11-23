// ai.js
// 三目並べの勝敗判定と AI クラス

// 勝敗判定用ライン
export const WIN_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6]
];

// 盤面は "........." のような9文字の文字列を想定
export function checkWinnerForBoard(boardStr) {
  for (const [a, b, c] of WIN_LINES) {
    const v = boardStr[a];
    if (v !== "." && v === boardStr[b] && v === boardStr[c]) {
      return v; // "X" or "O"
    }
  }
  if (!boardStr.includes(".")) {
    return "draw";
  }
  return null;
}

// レーティングに応じてミス率を変える簡易AI
export class TicTacToeAI {
  constructor(rating = 1500) {
    this.rating = rating;
  }

  setRating(rating) {
    this.rating = rating;
  }

  /**
   * @param {string} boardStr 9マスの盤面（'.', 'X', 'O'）
   * @param {string} aiSymbol  AI側の記号（"O"など）
   * @param {string} humanSymbol 人間側の記号（"X"など）
   * @returns {number|null} 着手位置（0〜8） or null
   */
  chooseMove(boardStr, aiSymbol = "O", humanSymbol = "X") {
    if (typeof boardStr !== "string" || boardStr.length !== 9) {
      throw new Error("boardStr must be a 9-length string");
    }

    const empties = [];
    for (let i = 0; i < 9; i++) {
      if (boardStr[i] === ".") empties.push(i);
    }
    if (empties.length === 0) return null;

    const findWinningMove = (forSymbol) => {
      for (const idx of empties) {
        const arr = boardStr.split("");
        arr[idx] = forSymbol;
        const result = checkWinnerForBoard(arr.join(""));
        if (result === forSymbol) {
          return idx;
        }
      }
      return null;
    };

    const winMove = findWinningMove(aiSymbol);
    const blockMove = findWinningMove(humanSymbol);

    let bestMove = null;
    if (winMove !== null) {
      bestMove = winMove;
    } else if (blockMove !== null) {
      bestMove = blockMove;
    } else if (boardStr[4] === ".") {
      // 中央
      bestMove = 4;
    } else {
      const corners = [0, 2, 6, 8].filter((i) => boardStr[i] === ".");
      if (corners.length > 0) {
        bestMove = corners[Math.floor(Math.random() * corners.length)];
      } else {
        bestMove = empties[Math.floor(Math.random() * empties.length)];
      }
    }

    // レートに応じてミス率を変える
    let mistakeRate;
    if (this.rating < 1400) {
      mistakeRate = 0.6;
    } else if (this.rating < 1700) {
      mistakeRate = 0.3;
    } else {
      mistakeRate = 0.1;
    }

    if (Math.random() < mistakeRate) {
      // わざとランダムに打つ
      return empties[Math.floor(Math.random() * empties.length)];
    } else {
      return bestMove !== null
        ? bestMove
        : empties[Math.floor(Math.random() * empties.length)];
    }
  }
}
