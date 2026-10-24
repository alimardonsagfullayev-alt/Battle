
const express = require("express");
const http = require("http");
const os = require("os");
const path = require("path");
const { Server } = require("socket.io");
const { words, grammar } = require("./public/questions.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 25000,
  pingTimeout: 60000
});

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const ROUND_MS = 15000;
const SPEED_MS = 5000;

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_, res) => res.redirect("/host.html"));
app.get("/health", (_, res) => res.json({ ok: true }));

function makePin() {
  let pin;
  do { pin = String(Math.floor(100000 + Math.random() * 900000)); }
  while (rooms.has(pin));
  return pin;
}

function shuffle(items) {
  return [...items].sort(() => Math.random() - 0.5);
}

function leaderboard(room) {
  return [...room.players.values()]
    .sort((a, b) => b.score - a.score || b.correct - a.correct)
    .map((p, i) => ({
      id: p.id, nickname: p.nickname, score: p.score,
      rank: i + 1, correct: p.correct, connected: p.connected
    }));
}

function roomState(room) {
  return {
    pin: room.pin,
    status: room.status,
    topic: room.topic,
    total: room.questions.length,
    index: room.index,
    players: leaderboard(room),
    question: room.current ? {
      type: room.current.type,
      prompt: room.current.prompt,
      options: room.current.options,
      number: room.index + 1,
      total: room.questions.length,
      endsAt: room.endsAt,
      duration: room.duration
    } : null
  };
}

function emitRoom(room) {
  io.to(room.pin).emit("room-state", roomState(room));
  room.players.forEach(p => {
    if (p.connected) {
      io.to(p.id).emit("my-stats", {
        score: p.score,
        rank: leaderboard(room).find(x => x.id === p.id)?.rank || 0,
        streak: p.streak,
        powerups: p.powerups
      });
    }
  });
}

function makeWordQuestion(word, type) {
  const pool = shuffle(words.filter(w => w.word !== word.word));
  let prompt, answer, options;

  if (type === "reverse") {
    prompt = `“${word.uz}” so‘zining inglizchasi?`;
    answer = word.word;
    options = [answer, ...pool.slice(0, 3).map(w => w.word)];
  } else if (type === "missing") {
    if (word.word.length < 3 || word.word.includes(" ")) {
      return makeWordQuestion(word, "word");
    }
    const index = Math.floor(Math.random() * word.word.length);
    const letter = word.word[index];
    prompt = word.word.slice(0, index) + "_" + word.word.slice(index + 1);
    answer = letter;
    const letters = "abcdefghijklmnopqrstuvwxyz".replace(letter, "");
    options = [letter, ...shuffle(letters.split("")).slice(0, 3)];
  } else {
    prompt = `“${word.word}” so‘zining o‘zbekcha tarjimasi?`;
    answer = word.uz;
    options = [answer, ...pool.slice(0, 3).map(w => w.uz)];
  }

  return { type, prompt, answer, options: shuffle(options), explanation: `${word.word} — ${word.uz}` };
}

function makeGrammarQuestion(item) {
  return {
    type: "grammar",
    prompt: item.sentence,
    answer: item.answer,
    options: shuffle(item.options),
    explanation: `${item.sentence} → ${item.answer}`
  };
}

function makeGameQuestions(topic, count) {
  const pool = shuffle(words.filter(w => topic === "all" || w.topic === topic));
  const grammarPool = shuffle(grammar);
  const result = [];

  for (let i = 0; i < count; i++) {
    // Five-question speed finale.
    if (i >= count - Math.min(5, count)) {
      const w = pool[i % pool.length];
      const type = ["word", "reverse", "missing", "grammar"][
        Math.floor(Math.random() * 4)
      ];
      if (type === "grammar") {
        result.push(makeGrammarQuestion(grammarPool[i % grammarPool.length]));
      } else {
        result.push(makeWordQuestion(w, type));
      }
      continue;
    }

    const type = ["word", "reverse", "missing", "grammar"][
      Math.floor(Math.random() * 4)
    ];
    if (type === "grammar") {
      result.push(makeGrammarQuestion(grammarPool[i % grammarPool.length]));
    } else {
      result.push(makeWordQuestion(pool[i % pool.length], type));
    }
  }

  // Avoid revealing answers to clients. Keep answers only on the server.
  return result.map((q, i) => ({
    ...q,
    speed: i >= count - Math.min(5, count)
  }));
}

function publicQuestion(q) {
  return {
    type: q.type,
    prompt: q.prompt,
    options: q.options,
    explanation: q.explanation
  };
}

function stopTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function endQuestion(room) {
  if (!room.current || room.status !== "question") return;
  stopTimer(room);
  room.status = "reveal";

  io.to(room.pin).emit("answer-reveal", {
    correctAnswer: room.current.answer,
    explanation: room.current.explanation,
    leaderboard: leaderboard(room).slice(0, 5),
    number: room.index + 1,
    total: room.questions.length
  });
  emitRoom(room);

  room.timer = setTimeout(() => {
    room.timer = null;
    room.index++;
    if (room.index >= room.questions.length) {
      room.status = "finished";
      room.current = null;
      emitRoom(room);
      io.to(room.pin).emit("game-over", {
        podium: leaderboard(room).slice(0, 3),
        leaderboard: leaderboard(room)
      });
      return;
    }
    nextQuestion(room);
  }, 4500);
}

function nextQuestion(room) {
  stopTimer(room);
  if (room.index >= room.questions.length) return;

  room.status = "question";
  room.current = room.questions[room.index];
  room.duration = room.current.speed ? SPEED_MS : ROUND_MS;
  room.endsAt = Date.now() + room.duration;
  room.players.forEach(p => {
    p.answered = false;
    p.doubleActive = false;
    p.hiddenOptions = [];
  });

  io.to(room.pin).emit("new-question", {
    ...publicQuestion(room.current),
    number: room.index + 1,
    total: room.questions.length,
    duration: room.duration,
    endsAt: room.endsAt,
    speed: room.current.speed
  });
  emitRoom(room);
  room.timer = setTimeout(() => endQuestion(room), room.duration);
}

function sanitizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 18);
}

io.on("connection", socket => {
  socket.on("host-create", (_, cb) => {
    const pin = makePin();
    const room = {
      pin, hostId: socket.id, players: new Map(),
      status: "lobby", topic: "all", questions: [],
      index: -1, current: null, timer: null
    };
    rooms.set(pin, room);
    socket.join(pin);
    socket.data.hostPin = pin;
    cb?.({ ok: true, pin });
    emitRoom(room);
  });

  socket.on("host-resume", (data, cb) => {
    const room = rooms.get(String(data?.pin || ""));
    if (!room || room.hostId !== socket.id) {
      if (room && room.hostId === socket.data.previousHostId) {
        room.hostId = socket.id;
      } else {
        cb?.({ ok: false, error: "Xona topilmadi yoki bu hostga tegishli emas." });
        return;
      }
    }
    socket.join(room.pin);
    socket.data.hostPin = room.pin;
    cb?.({ ok: true, pin: room.pin });
    emitRoom(room);
  });

  socket.on("join-game", (data, cb) => {
    const pin = String(data?.pin || "").trim();
    const nickname = sanitizeName(data?.nickname);
    const room = rooms.get(pin);

    if (!room) return cb?.({ ok: false, error: "PIN noto‘g‘ri yoki xona mavjud emas." });
    if (!nickname) return cb?.({ ok: false, error: "Nickname kiriting." });
    if (room.status === "finished") return cb?.({ ok: false, error: "Bu o‘yin tugagan." });

    let player = [...room.players.values()].find(
      p => p.nickname.toLowerCase() === nickname.toLowerCase()
    );

    if (player && player.connected) {
      return cb?.({ ok: false, error: "Bu nickname band. Boshqasini tanlang." });
    }

    if (player) {
      player.id = socket.id;
      player.connected = true;
    } else {
      if (room.players.size >= 100) {
        return cb?.({ ok: false, error: "Xona to‘la." });
      }
      player = {
        id: socket.id, nickname, score: 0, correct: 0, streak: 0,
        answered: false, connected: true,
        powerups: { fifty: true, double: true },
        doubleActive: false, hiddenOptions: []
      };
      room.players.set(socket.id, player);
    }

    // A reconnecting player's map key must be updated to the new socket ID.
    for (const [key, value] of room.players) {
      if (value === player && key !== socket.id) room.players.delete(key);
    }
    room.players.set(socket.id, player);
    socket.join(pin);
    socket.data.pin = pin;
    socket.data.nickname = nickname;

    cb?.({ ok: true, nickname, pin });
    socket.emit("joined", {
      nickname, state: roomState(room),
      question: room.current && room.status === "question"
        ? { ...publicQuestion(room.current), number: room.index + 1,
            total: room.questions.length, duration: Math.max(0, room.endsAt - Date.now()),
            endsAt: room.endsAt, speed: room.current.speed }
        : null
    });
    emitRoom(room);
  });

  socket.on("host-start", data => {
    const room = rooms.get(socket.data.hostPin);
    if (!room || room.hostId !== socket.id || room.status !== "lobby") return;
    if (room.players.size < 2) {
      socket.emit("host-error", "O‘yinni boshlash uchun kamida 2 nafar o‘yinchi kerak.");
      return;
    }

    const topic = String(data?.topic || "all");
    const allowed = ["all", "food", "travel", "family", "school", "jobs", "animals", "daily"];
    room.topic = allowed.includes(topic) ? topic : "all";
    const count = [10, 20, 30].includes(Number(data?.count)) ? Number(data.count) : 10;
    room.questions = makeGameQuestions(room.topic, count);
    room.index = 0;
    nextQuestion(room);
  });

  socket.on("answer", data => {
    const room = rooms.get(socket.data.pin);
    if (!room || room.status !== "question" || !room.current) return;
    const player = room.players.get(socket.id);
    if (!player || !player.connected || player.answered) return;

    player.answered = true;
    const correct = String(data?.answer ?? "") === room.current.answer;
    let points = 0;

    if (correct) {
      const remaining = Math.max(0, room.endsAt - Date.now());
      const ratio = remaining / room.duration;
      points = Math.round(500 + 500 * ratio);
      if (player.streak >= 2) points *= 2;
      if (player.doubleActive) points *= 2;
      player.score += points;
      player.correct++;
      player.streak++;
    } else {
      player.streak = 0;
    }
    player.doubleActive = false;

    socket.emit("answer-result", {
      correct, points, score: player.score,
      correctAnswer: room.current.answer,
      explanation: room.current.explanation
    });

    emitRoom(room);
    if ([...room.players.values()].filter(p => p.connected).every(p => p.answered)) {
      endQuestion(room);
    }
  });

  socket.on("use-powerup", data => {
    const room = rooms.get(socket.data.pin);
    const player = room?.players.get(socket.id);
    if (!room || room.status !== "question" || !player || player.answered) return;

    if (data?.type === "fifty" && player.powerups.fifty) {
      player.powerups.fifty = false;
      const wrong = shuffle(room.current.options.filter(o => o !== room.current.answer)).slice(0, 2);
      player.hiddenOptions = wrong;
      socket.emit("powerup-result", { type: "fifty", hiddenOptions: wrong });
    } else if (data?.type === "double" && player.powerups.double) {
      player.powerups.double = false;
      player.doubleActive = true;
      socket.emit("powerup-result", { type: "double", message: "Keyingi to‘g‘ri javob x2!" });
    }
    emitRoom(room);
  });

  socket.on("host-next", () => {
    const room = rooms.get(socket.data.hostPin);
    if (!room || room.hostId !== socket.id || room.status !== "reveal") return;
    stopTimer(room);
    room.index++;
    if (room.index >= room.questions.length) {
      room.status = "finished";
      room.current = null;
      emitRoom(room);
      io.to(room.pin).emit("game-over", {
        podium: leaderboard(room).slice(0, 3),
        leaderboard: leaderboard(room)
      });
    } else nextQuestion(room);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const player = room.players.get(socket.id);
      if (player) {
        player.connected = false;
        emitRoom(room);
      }
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("\n⚔️  ENGLISH BATTLE server ishga tushdi!");
  console.log(`Host: http://localhost:${PORT}/host.html`);
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) {
        console.log(`Telefonlar uchun: http://${net.address}:${PORT}/player.html`);
      }
    }
  }
  if (process.env.RENDER_EXTERNAL_URL) {
    console.log(`Internet manzili: ${process.env.RENDER_EXTERNAL_URL}`);
  }
});
