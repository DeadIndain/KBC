const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const DB_PATH = path.join(__dirname, "data", "event_questions.sqlite");
const db = new sqlite3.Database(DB_PATH);
const ADMIN_SETTINGS_KEY = "game_config";

// ─── Load Questions ───────────────────────────────────────────────────────────
let questionsData = JSON.parse(
	fs.readFileSync("./data/questions.json", "utf-8"),
);
let allQuestions = buildQuestionBank(questionsData);

// ─── Game State ───────────────────────────────────────────────────────────────
let gameState = {
	phase: "lobby", // lobby | contestant-intro | question | answer-reveal | lifeline-poll | lifeline-phone | round-end | game-over
	contestants: [],
	currentContestantIndex: 0,
	currentRoundIndex: 0,
	currentQuestionIndex: 0,
	currentQuestion: null,
	currentQuestionTrackingId: null,
	answerEvaluated: false,
	revealedOptions: [],
	selectedAnswer: null,
	correctAnswer: null,
	timerRunning: false,
	timerValue: 0,
	lifelines: {},
	audiencePollData: null,
	removedOptions: [],
	highlightCorrect: false,
	highlightWrong: false,
	message: "",
	introTrigger: 0,
	scores: {},
	roundWinners: [],
	questionsAnswered: 0,
	gameConfig: {
		totalQuestionsToWin: 5,
		prizes: ["₹10,000", "₹20,000", "₹40,000", "₹80,000", "₹1,60,000"],
	},
	prizeMoneyLadder: [],
};

let timerInterval = null;

// ─── DB Helpers ───────────────────────────────────────────────────────────────
function runDb(sql, params = []) {
	return new Promise((resolve, reject) => {
		db.run(sql, params, function onRun(err) {
			if (err) return reject(err);
			resolve(this);
		});
	});
}

function getDb(sql, params = []) {
	return new Promise((resolve, reject) => {
		db.get(sql, params, (err, row) => {
			if (err) return reject(err);
			resolve(row);
		});
	});
}

function allDb(sql, params = []) {
	return new Promise((resolve, reject) => {
		db.all(sql, params, (err, rows) => {
			if (err) return reject(err);
			resolve(rows);
		});
	});
}

async function initQuestionDb() {
	await runDb(`
    CREATE TABLE IF NOT EXISTS question_tracking (
      question_id TEXT PRIMARY KEY,
      asked_count INTEGER NOT NULL DEFAULT 0,
      wrong_count INTEGER NOT NULL DEFAULT 0,
      solved INTEGER NOT NULL DEFAULT 0,
      last_result TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

	await runDb(
		"CREATE INDEX IF NOT EXISTS idx_question_tracking_solved_asked ON question_tracking (solved, asked_count)",
	);

	for (const q of allQuestions) {
		await runDb(
			"INSERT OR IGNORE INTO question_tracking (question_id) VALUES (?)",
			[q.trackingId],
		);
	}
}

async function initAdminSettingsDb() {
	await runDb(`
		CREATE TABLE IF NOT EXISTS admin_settings (
			setting_key TEXT PRIMARY KEY,
			setting_value TEXT NOT NULL,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`);
}

async function loadPersistedGameConfig() {
	const row = await getDb(
		"SELECT setting_value FROM admin_settings WHERE setting_key = ?",
		[ADMIN_SETTINGS_KEY],
	);
	if (!row?.setting_value) return;

	try {
		gameState.gameConfig = normalizeGameConfig(JSON.parse(row.setting_value));
	} catch (_error) {
		// Ignore malformed persisted config and keep defaults.
	}
}

async function savePersistedGameConfig(config) {
	await runDb(
		`INSERT INTO admin_settings (setting_key, setting_value, updated_at)
		 VALUES (?, ?, CURRENT_TIMESTAMP)
		 ON CONFLICT(setting_key) DO UPDATE SET
		   setting_value = excluded.setting_value,
		   updated_at = CURRENT_TIMESTAMP`,
		[ADMIN_SETTINGS_KEY, JSON.stringify(config)],
	);
}

async function ensureTrackingRows() {
	for (const q of allQuestions) {
		await runDb(
			"INSERT OR IGNORE INTO question_tracking (question_id) VALUES (?)",
			[q.trackingId],
		);
	}
}

async function resetQuestionTracking() {
	await runDb(
		`UPDATE question_tracking
		 SET asked_count = 0,
		     wrong_count = 0,
		     solved = 0,
		     last_result = NULL,
		     updated_at = CURRENT_TIMESTAMP`,
	);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizeDifficulty(value) {
	const d = String(value || "medium").toLowerCase();
	if (d === "easy" || d === "medium" || d === "hard") return d;
	return "medium";
}

function buildQuestionBank(data) {
	const bank = [];
	data.rounds.forEach((round, roundIndex) => {
		round.questions.forEach((q, questionIndex) => {
			bank.push({
				trackingId: `r${roundIndex + 1}-q${q.id || questionIndex + 1}-${questionIndex}`,
				id: q.id,
				question: q.question,
				options: q.options,
				correct: q.correct,
				difficulty: normalizeDifficulty(q.difficulty),
				roundIndex,
				questionIndex,
				roundName: round.roundName,
				prizeLevel: round.prizeLevel,
				timeLimit: Number(round.timeLimit) || 45,
			});
		});
	});
	return bank;
}

function getContestantById(id) {
	return gameState.contestants.find((c) => c.id === id);
}

function getActiveContestant() {
	return (
		gameState.contestants.find((c) => c.active) || gameState.contestants[0]
	);
}

function normalizeGameConfig(rawConfig = {}) {
	const totalQuestionsToWin = Math.max(
		1,
		Math.min(20, Number(rawConfig.totalQuestionsToWin) || 5),
	);

	const inputPrizes = Array.isArray(rawConfig.prizes)
		? rawConfig.prizes
		: String(rawConfig.prizes || "")
				.split(/\n|,/)
				.map((p) => p.trim())
				.filter(Boolean);

	const prizes = Array.from({ length: totalQuestionsToWin }, (_, i) => {
		return inputPrizes[i] || `Prize ${i + 1}`;
	});

	return { totalQuestionsToWin, prizes };
}

function buildPrizeLadder(config) {
	return Array.from({ length: config.totalQuestionsToWin }, (_, i) => ({
		round: i + 1,
		name: `Question ${i + 1}`,
		prize: config.prizes[i],
		active: false,
	}));
}

function setActivePrizeIndex(index) {
	gameState.prizeMoneyLadder = gameState.prizeMoneyLadder.map((item, i) => ({
		...item,
		active: i === index,
	}));
}

function broadcast() {
	io.emit("state", gameState);
}

function stopTimer() {
	if (timerInterval) {
		clearInterval(timerInterval);
		timerInterval = null;
	}
	gameState.timerRunning = false;
}

function startTimer(seconds) {
	stopTimer();
	gameState.timerValue = seconds;
	gameState.timerRunning = true;
	broadcast();

	timerInterval = setInterval(() => {
		gameState.timerValue -= 1;
		if (gameState.timerValue <= 0) {
			stopTimer();
			gameState.timerRunning = false;
			gameState.phase = "answer-reveal";
			broadcast();
		} else {
			broadcast();
		}
	}, 1000);
}

async function getTrackingMap() {
	const rows = await allDb(
		"SELECT question_id, asked_count, wrong_count, solved FROM question_tracking",
	);
	const map = new Map();
	rows.forEach((row) => {
		map.set(row.question_id, {
			asked_count: Number(row.asked_count) || 0,
			wrong_count: Number(row.wrong_count) || 0,
			solved: Number(row.solved) === 1,
		});
	});
	return map;
}

async function getQuestionsMetaPayload() {
	const trackingMap = await getTrackingMap();
	const difficultyKeys = ["easy", "medium", "hard"];

	const totals = { easy: 0, medium: 0, hard: 0, any: allQuestions.length };
	const available = { easy: 0, medium: 0, hard: 0, any: 0 };

	allQuestions.forEach((q) => {
		totals[q.difficulty] += 1;
		const t = trackingMap.get(q.trackingId) || {
			asked_count: 0,
			solved: false,
		};
		if (!t.solved && t.asked_count < 3) {
			available[q.difficulty] += 1;
			available.any += 1;
		}
	});

	const solvedCount = allQuestions.filter((q) => {
		const t = trackingMap.get(q.trackingId);
		return t && t.solved;
	}).length;

	const exhaustedCount = allQuestions.filter((q) => {
		const t = trackingMap.get(q.trackingId);
		return t && !t.solved && t.asked_count >= 3;
	}).length;

	return {
		totals,
		available,
		solvedCount,
		exhaustedCount,
		questionCount: allQuestions.length,
		difficulties: [...difficultyKeys, "any"],
	};
}

async function emitQuestionsMeta(targetSocket = null) {
	const payload = await getQuestionsMetaPayload();
	if (targetSocket) {
		targetSocket.emit("questions-meta", payload);
	} else {
		io.emit("questions-meta", payload);
	}
}

function pickRandom(list) {
	if (!list.length) return null;
	return list[Math.floor(Math.random() * list.length)];
}

async function selectNextQuestion(difficulty) {
	const trackingMap = await getTrackingMap();
	const wantedDifficulty = String(difficulty || "any").toLowerCase();

	const eligible = allQuestions.filter((q) => {
		const t = trackingMap.get(q.trackingId) || {
			asked_count: 0,
			solved: false,
		};
		const difficultyMatch =
			wantedDifficulty === "any" ? true : q.difficulty === wantedDifficulty;
		return difficultyMatch && !t.solved && t.asked_count < 3;
	});

	const neverAsked = eligible.filter((q) => {
		const t = trackingMap.get(q.trackingId) || { asked_count: 0 };
		return t.asked_count === 0;
	});

	const selected = pickRandom(neverAsked.length ? neverAsked : eligible);
	if (!selected) return null;

	await runDb(
		`UPDATE question_tracking
     SET asked_count = asked_count + 1,
         last_result = 'asked',
         updated_at = CURRENT_TIMESTAMP
     WHERE question_id = ?`,
		[selected.trackingId],
	);

	const updated = await getDb(
		"SELECT asked_count FROM question_tracking WHERE question_id = ?",
		[selected.trackingId],
	);

	return {
		...selected,
		askedCount: Number(updated?.asked_count) || 1,
	};
}

async function markCurrentQuestionResult(isCorrect) {
	if (!gameState.currentQuestionTrackingId) return;

	if (isCorrect) {
		await runDb(
			`UPDATE question_tracking
       SET solved = 1,
           last_result = 'correct',
           updated_at = CURRENT_TIMESTAMP
       WHERE question_id = ?`,
			[gameState.currentQuestionTrackingId],
		);
	} else {
		await runDb(
			`UPDATE question_tracking
       SET wrong_count = wrong_count + 1,
           last_result = 'wrong',
           updated_at = CURRENT_TIMESTAMP
       WHERE question_id = ?`,
			[gameState.currentQuestionTrackingId],
		);
	}
}

function resetParticipantState(name, keepConfig = true) {
	const nextName = (name || "").trim() || "Participant";
	const contestantId = "c0";
	const config = keepConfig
		? normalizeGameConfig(gameState.gameConfig)
		: normalizeGameConfig();

	gameState = {
		...gameState,
		phase: "lobby",
		contestants: [
			{
				id: contestantId,
				name: nextName,
				active: true,
				eliminated: false,
				score: 0,
			},
		],
		currentContestantIndex: 0,
		currentRoundIndex: 0,
		currentQuestionIndex: 0,
		currentQuestion: null,
		currentQuestionTrackingId: null,
		answerEvaluated: false,
		revealedOptions: [],
		selectedAnswer: null,
		correctAnswer: null,
		timerRunning: false,
		timerValue: 0,
		lifelines: {
			[contestantId]: {
				fiftyFifty: true,
				audiencePoll: true,
				phoneFriend: true,
			},
		},
		audiencePollData: null,
		removedOptions: [],
		highlightCorrect: false,
		highlightWrong: false,
		message: "",
		introTrigger: 0,
		scores: { [contestantId]: 0 },
		roundWinners: [],
		questionsAnswered: 0,
		gameConfig: config,
		prizeMoneyLadder: buildPrizeLadder(config),
	};

	setActivePrizeIndex(0);
}

// ─── Socket Events ────────────────────────────────────────────────────────────
io.on("connection", async (socket) => {
	console.log(`[Socket] Client connected: ${socket.id}`);

	socket.emit("state", gameState);
	if (gameState.phase === "contestant-intro") {
		socket.emit("play-sound", { sound: "introDramatic" });
	}
	await emitQuestionsMeta(socket);

	socket.on("setup-game", async ({ contestants, config }) => {
		stopTimer();
		const firstName =
			Array.isArray(contestants) && contestants.length
				? String(contestants[0]).trim()
				: "Participant";

		if (config) {
			gameState.gameConfig = normalizeGameConfig(config);
		}

		resetParticipantState(firstName || "Participant", true);
		gameState.phase = "contestant-intro";
		gameState.introTrigger = Number(gameState.introTrigger || 0) + 1;
		gameState.message = "";
		broadcast();
		io.emit("play-sound", { sound: "introDramatic" });
		await emitQuestionsMeta();
	});

	socket.on("set-game-config", ({ totalQuestionsToWin, prizes }, callback) => {
		try {
			const config = normalizeGameConfig({ totalQuestionsToWin, prizes });
			gameState.gameConfig = config;
			gameState.prizeMoneyLadder = buildPrizeLadder(config);
			savePersistedGameConfig(config).catch((error) => {
				console.error("Failed to persist game config:", error);
			});

			const nextActiveIndex = Math.min(
				gameState.questionsAnswered,
				Math.max(config.totalQuestionsToWin - 1, 0),
			);
			setActivePrizeIndex(nextActiveIndex);

			broadcast();
			if (typeof callback === "function") {
				callback({ ok: true, message: "Game config updated" });
			}
		} catch (error) {
			if (typeof callback === "function") {
				callback({ ok: false, message: error.message });
			}
		}
	});

	socket.on("reset-question-tracking", async (callback) => {
		try {
			await resetQuestionTracking();
			await emitQuestionsMeta();
			if (typeof callback === "function") {
				callback({ ok: true, message: "Question tracking reset" });
			}
		} catch (error) {
			if (typeof callback === "function") {
				callback({ ok: false, message: error.message });
			}
		}
	});

	socket.on("intro-contestant", ({ contestantId }) => {
		stopTimer();
		gameState.contestants.forEach((c) => {
			c.active = false;
		});
		const c = getContestantById(contestantId) || gameState.contestants[0];
		if (c) c.active = true;
		gameState.phase = "contestant-intro";
		gameState.introTrigger = Number(gameState.introTrigger || 0) + 1;
		gameState.message = "";
		broadcast();
		io.emit("play-sound", { sound: "introDramatic" });
	});

	socket.on("load-next-question", async ({ difficulty }, callback) => {
		try {
			stopTimer();
			const question = await selectNextQuestion(difficulty);

			if (!question) {
				if (typeof callback === "function") {
					callback({
						ok: false,
						message:
							"No eligible questions left for this difficulty (all solved or reached 3 attempts).",
					});
				}
				return;
			}

			gameState.currentRoundIndex = question.roundIndex;
			gameState.currentQuestionIndex = question.questionIndex;
			gameState.currentQuestionTrackingId = question.trackingId;
			gameState.currentQuestion = {
				id: question.id,
				question: question.question,
				options: question.options,
				difficulty: question.difficulty,
				roundName: question.roundName,
				prizeLevel: question.prizeLevel,
				timeLimit: question.timeLimit,
				attemptNumber: question.askedCount,
				maxAttempts: 3,
			};

			gameState.correctAnswer = question.correct;
			gameState.revealedOptions = [];
			gameState.selectedAnswer = null;
			gameState.answerEvaluated = false;
			gameState.highlightCorrect = false;
			gameState.highlightWrong = false;
			gameState.audiencePollData = null;
			gameState.removedOptions = [];
			gameState.phase = "question";
			gameState.message = "";

			const activeIndex = Math.min(
				gameState.questionsAnswered,
				Math.max(gameState.gameConfig.totalQuestionsToWin - 1, 0),
			);
			setActivePrizeIndex(activeIndex);

			broadcast();
			await emitQuestionsMeta();

			if (typeof callback === "function") {
				callback({ ok: true, message: "Question loaded" });
			}
		} catch (error) {
			if (typeof callback === "function") {
				callback({ ok: false, message: error.message });
			}
		}
	});

	socket.on("reveal-option", ({ option }) => {
		if (!gameState.revealedOptions.includes(option)) {
			gameState.revealedOptions.push(option);
		}
		broadcast();
	});

	socket.on("reveal-all-options", () => {
		gameState.revealedOptions = ["A", "B", "C", "D"].filter(
			(o) => !gameState.removedOptions.includes(o),
		);
		broadcast();
	});

	socket.on("start-timer", ({ seconds }) => {
		const duration =
			Number(seconds) || Number(gameState.currentQuestion?.timeLimit) || 45;
		startTimer(duration);
	});

	socket.on("pause-timer", () => {
		stopTimer();
		broadcast();
	});

	socket.on("reset-timer", () => {
		stopTimer();
		gameState.timerValue = Number(gameState.currentQuestion?.timeLimit) || 45;
		broadcast();
	});

	socket.on("lock-answer", ({ answer }) => {
		stopTimer();
		gameState.selectedAnswer = answer;
		gameState.phase = "answer-reveal";
		broadcast();
	});

	socket.on("reveal-answer", async () => {
		if (gameState.answerEvaluated) {
			return;
		}

		gameState.highlightCorrect = true;
		const isCorrect = gameState.selectedAnswer === gameState.correctAnswer;
		gameState.highlightWrong = !isCorrect;

		const active = getActiveContestant();
		if (active && isCorrect) {
			gameState.scores[active.id] = (gameState.scores[active.id] || 0) + 1;
			active.score = gameState.scores[active.id];
			gameState.questionsAnswered = active.score;
		}

		gameState.answerEvaluated = true;
		await markCurrentQuestionResult(isCorrect);

		if (
			gameState.questionsAnswered >= gameState.gameConfig.totalQuestionsToWin
		) {
			gameState.phase = "game-over";
		}

		const nextActiveIndex = Math.min(
			gameState.questionsAnswered,
			Math.max(gameState.gameConfig.totalQuestionsToWin - 1, 0),
		);
		setActivePrizeIndex(nextActiveIndex);

		broadcast();
		await emitQuestionsMeta();
	});

	socket.on("lifeline-fifty-fifty", ({ contestantId }) => {
		if (!gameState.lifelines[contestantId]?.fiftyFifty) return;
		gameState.lifelines[contestantId].fiftyFifty = false;

		const correct = gameState.correctAnswer;
		const allOptions = ["A", "B", "C", "D"];
		const wrong = allOptions.filter((o) => o !== correct);
		const toRemove = wrong.sort(() => Math.random() - 0.5).slice(0, 2);
		gameState.removedOptions = toRemove;
		gameState.revealedOptions = gameState.revealedOptions.filter(
			(o) => !toRemove.includes(o),
		);

		broadcast();
	});

	socket.on("lifeline-phone", ({ contestantId }) => {
		if (!gameState.lifelines[contestantId]?.phoneFriend) return;
		gameState.lifelines[contestantId].phoneFriend = false;
		gameState.phase = "lifeline-phone";
		broadcast();
	});

	socket.on("end-lifeline-phone", () => {
		gameState.phase = "question";
		broadcast();
	});

	socket.on("lifeline-audience", ({ contestantId }) => {
		if (!gameState.lifelines[contestantId]?.audiencePoll) return;
		gameState.lifelines[contestantId].audiencePoll = false;
		gameState.phase = "lifeline-poll";
		gameState.audiencePollData = null;
		broadcast();
	});

	socket.on("submit-audience-poll", ({ counts }) => {
		const activeOptions = ["A", "B", "C", "D"].filter(
			(o) => !gameState.removedOptions.includes(o),
		);
		const total = activeOptions.reduce((sum, k) => sum + (counts[k] || 0), 0);
		const percentages = {};
		activeOptions.forEach((k) => {
			percentages[k] =
				total > 0 ? Math.round(((counts[k] || 0) / total) * 100) : 0;
		});

		const sum = activeOptions.reduce((s, k) => s + percentages[k], 0);
		if (sum !== 100 && activeOptions.length > 0) {
			percentages[activeOptions[0]] += 100 - sum;
		}

		gameState.audiencePollData = percentages;
		gameState.phase = "question";
		broadcast();
	});

	socket.on("show-message", ({ message }) => {
		gameState.message = message;
		broadcast();
	});

	socket.on("play-sound", ({ sound }) => {
		const safeSound = String(sound || "").trim();
		if (!safeSound) return;
		io.emit("play-sound", { sound: safeSound });
	});

	socket.on("clear-message", () => {
		gameState.message = "";
		broadcast();
	});

	socket.on("round-end", () => {
		stopTimer();
		gameState.phase = "round-end";
		broadcast();
	});

	socket.on("game-over", () => {
		stopTimer();
		gameState.phase = "game-over";
		broadcast();
	});

	socket.on("reset-game", () => {
		stopTimer();
		resetParticipantState("Participant", true);
		gameState.contestants = [];
		gameState.message = "";
		broadcast();
	});

	socket.on("reset-for-next-participant", ({ name }) => {
		stopTimer();
		resetParticipantState(name, true);
		gameState.phase = "contestant-intro";
		gameState.introTrigger = Number(gameState.introTrigger || 0) + 1;
		gameState.message = "";
		broadcast();
		io.emit("play-sound", { sound: "introDramatic" });
	});

	socket.on("disconnect", () => {
		console.log(`[Socket] Client disconnected: ${socket.id}`);
	});
});

// ─── Reload Questions endpoint ────────────────────────────────────────────────
app.get("/reload-questions", async (req, res) => {
	try {
		questionsData = JSON.parse(
			fs.readFileSync("./data/questions.json", "utf-8"),
		);
		allQuestions = buildQuestionBank(questionsData);
		await ensureTrackingRows();
		await emitQuestionsMeta();
		res.json({ success: true, message: "Questions reloaded!" });
	} catch (e) {
		res.status(500).json({ success: false, message: e.message });
	}
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = 3000;

(async () => {
	try {
		await initQuestionDb();
		await initAdminSettingsDb();
		await loadPersistedGameConfig();
		gameState.prizeMoneyLadder = buildPrizeLadder(gameState.gameConfig);
		setActivePrizeIndex(0);

		server.listen(PORT, () => {
			console.log("\n🎯 Koun Banega Codepathi is LIVE!");
			console.log(
				`\n   Display Screen : http://localhost:${PORT}/display.html`,
			);
			console.log(`   Admin Panel    : http://localhost:${PORT}/admin.html`);
			console.log(
				"\n   Open Display on the projector tab, Admin on your control tab.\n",
			);
			console.log(`   Question DB    : ${DB_PATH}\n`);
		});
	} catch (error) {
		console.error("Failed to initialize server:", error);
		process.exit(1);
	}
})();
