const express = require("express");
const http = require("http");
const { EventEmitter } = require("events");
const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const server = http.createServer(app);
const bus = new EventEmitter();
const pubsubClients = new Set();
const commandHandlers = new Map();

const PORT = 3000;
const DB_PATH = path.join(__dirname, "data", "event_questions.sqlite");
const QUESTIONS_FILE_PATH = path.join(__dirname, "data", "questions.json");

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const db = new sqlite3.Database(DB_PATH);

let questionsData = JSON.parse(fs.readFileSync(QUESTIONS_FILE_PATH, "utf-8"));
let allQuestions = buildQuestionBank(questionsData);

let gameState = {
	phase: "lobby",
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
	removedOptions: [],
	highlightCorrect: false,
	highlightWrong: false,
	message: "",
	introTrigger: 0,
	scores: {},
	roundWinners: [],
	roundsCompleted: 0,
	lastCompletedRoundIndex: null,
	lastOutcome: null,
	gameConfig: buildGameConfig(questionsData),
	prizeMoneyLadder: [],
};

gameState.prizeMoneyLadder = buildPrizeLadder(gameState.gameConfig);
setActivePrizeIndex(0);

let timerInterval = null;
let lifelineOverlayTimer = null;

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
	await runDb(`
    UPDATE question_tracking
    SET asked_count = 0,
        wrong_count = 0,
        solved = 0,
        last_result = NULL,
        updated_at = CURRENT_TIMESTAMP
  `);
}

function sendSseEvent(res, event, payload) {
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function publish(event, payload) {
	bus.emit(event, payload);
	for (const res of pubsubClients) {
		sendSseEvent(res, event, payload);
	}
}

function broadcast() {
	publish("state", gameState);
}

function registerCommand(name, handler) {
	commandHandlers.set(name, handler);
}

function normalizeDifficulty(value) {
	const d = String(value || "medium").toLowerCase();
	if (d === "easy" || d === "medium" || d === "hard") return d;
	return "medium";
}

function normalizeMediaType(value) {
	const type = String(value || "")
		.trim()
		.toLowerCase();
	if (type === "image" || type === "audio" || type === "video") return type;
	return "";
}

function detectMediaTypeFromSrc(src) {
	const cleanSrc = String(src || "")
		.split("?")[0]
		.toLowerCase();
	if (/\.(png|jpe?g|gif|webp|svg)$/.test(cleanSrc)) return "image";
	if (/\.(mp3|wav|ogg|m4a|aac)$/.test(cleanSrc)) return "audio";
	if (/\.(mp4|webm|ogg|mov|m4v)$/.test(cleanSrc)) return "video";
	return "";
}

function sanitizeLocalMediaSrc(value) {
	const raw = String(value || "")
		.trim()
		.replace(/\\/g, "/");
	if (!raw) return "";
	if (/^[a-z]+:/i.test(raw)) return "";
	if (raw.includes("..")) return "";
	return raw.startsWith("/") ? raw : `/${raw}`;
}

function normalizeQuestionMedia(value) {
	if (!value) return [];
	const rawItems = Array.isArray(value) ? value : [value];
	const normalized = rawItems
		.map((item) => {
			if (typeof item === "string") {
				const src = sanitizeLocalMediaSrc(item);
				if (!src) return null;
				const type = detectMediaTypeFromSrc(src) || "image";
				return {
					src,
					type,
					alt: "",
					caption: "",
					autoplay: false,
					loop: false,
					muted: false,
					controls: type !== "image",
				};
			}

			if (!item || typeof item !== "object") return null;
			const src = sanitizeLocalMediaSrc(item.src);
			if (!src) return null;
			const inferredType = detectMediaTypeFromSrc(src);
			const type = normalizeMediaType(item.type) || inferredType || "image";
			return {
				src,
				type,
				alt: String(item.alt || ""),
				caption: String(item.caption || ""),
				autoplay: Boolean(item.autoplay),
				loop: Boolean(item.loop),
				muted: Boolean(item.muted),
				controls:
					type === "image"
						? false
						: item.controls !== undefined
							? Boolean(item.controls)
							: true,
			};
		})
		.filter(Boolean);

	return normalized;
}

function normalizeRoundConfig(round, index) {
	return {
		level: index + 1,
		label:
			String(round?.label || round?.roundName || round?.name || "").trim() ||
			`Round ${index + 1}`,
		prize: String(round?.prize || round?.prizeLevel || "").trim(),
		timeLimit: Math.max(1, Number(round?.timeLimit) || 45),
	};
}

function normalizeLevelList(value, fallbackLevel = 1) {
	const rawLevels = Array.isArray(value)
		? value
		: value === undefined || value === null || value === ""
			? [fallbackLevel]
			: [value];
	const levels = rawLevels
		.map((item) => Number(item))
		.filter((item) => Number.isInteger(item) && item > 0);
	return Array.from(new Set(levels.length ? levels : [fallbackLevel]));
}

function getConfiguredRounds(data = questionsData) {
	if (Array.isArray(data?.gameConfig?.rounds)) {
		return data.gameConfig.rounds.map((round, index) =>
			normalizeRoundConfig(round, index),
		);
	}

	if (Array.isArray(data?.rounds) && data.rounds.length) {
		if (Array.isArray(data.rounds[0]?.questions)) {
			return data.rounds.map((round, index) =>
				normalizeRoundConfig(
					{
						label: round.roundName,
						prize: round.prizeLevel,
						timeLimit: round.timeLimit,
					},
					index,
				),
			);
		}
		return data.rounds.map((round, index) =>
			normalizeRoundConfig(round, index),
		);
	}

	return [];
}

function buildGameConfig(data = questionsData) {
	const rounds = getConfiguredRounds(data);
	return { totalRounds: rounds.length, rounds };
}

function buildQuestionBank(data) {
	const rounds = getConfiguredRounds(data);
	const roundCount = rounds.length;
	const bank = [];

	if (Array.isArray(data?.questions)) {
		data.questions.forEach((q, questionIndex) => {
			const id = q.id ?? questionIndex + 1;
			const levels = normalizeLevelList(q.levels ?? q.rounds ?? q.level, 1)
				.filter((level) => !roundCount || level <= roundCount)
				.sort((a, b) => a - b);
			const media = normalizeQuestionMedia(q.media);

			bank.push({
				trackingId: `q-${id}`,
				id,
				question: q.question,
				options: q.options || {},
				correct: q.correct,
				difficulty: normalizeDifficulty(q.difficulty),
				levels,
				media,
			});
		});
		return bank;
	}

	if (Array.isArray(data?.rounds)) {
		data.rounds.forEach((round, roundIndex) => {
			const entries = Array.isArray(round?.questions) ? round.questions : [];
			entries.forEach((q, questionIndex) => {
				const id = q.id ?? questionIndex + 1;
				const media = normalizeQuestionMedia(q.media);
				bank.push({
					trackingId: `r${roundIndex + 1}-q${id}-${questionIndex}`,
					id,
					question: q.question,
					options: q.options || {},
					correct: q.correct,
					difficulty: normalizeDifficulty(q.difficulty),
					levels: [roundIndex + 1],
					media,
				});
			});
		});
	}

	return bank;
}

function buildPrizeLadder(config) {
	return (config.rounds || []).map((round, index) => ({
		round: index + 1,
		name: round.label || `Round ${index + 1}`,
		prize: round.prize || `Prize ${index + 1}`,
		active: false,
	}));
}

function setActivePrizeIndex(index) {
	gameState.prizeMoneyLadder = gameState.prizeMoneyLadder.map((item, i) => ({
		...item,
		active: i === index,
	}));
}

function clearLifelineOverlayTimer() {
	if (lifelineOverlayTimer) {
		clearTimeout(lifelineOverlayTimer);
		lifelineOverlayTimer = null;
	}
}

function getContestantLifelines(contestantId = null) {
	const activeId = contestantId || getActiveContestant()?.id;
	if (!activeId) return null;
	if (!gameState.lifelines[activeId]) {
		gameState.lifelines[activeId] = {
			fiftyFifty: true,
			callFriend: true,
			audiencePoll: true,
		};
	}
	return gameState.lifelines[activeId];
}

function showTemporaryLifelineOverlay(phase, durationMs = 5000) {
	clearLifelineOverlayTimer();
	gameState.phase = phase;
	broadcast();
	lifelineOverlayTimer = setTimeout(() => {
		if (gameState.phase === phase) {
			gameState.phase = "question";
			broadcast();
		}
		lifelineOverlayTimer = null;
	}, durationMs);
}

function getContestantById(id) {
	return gameState.contestants.find((c) => c.id === id);
}

function getActiveContestant() {
	return (
		gameState.contestants.find((c) => c.active) || gameState.contestants[0]
	);
}

function getRoundConfigAt(index) {
	return gameState.gameConfig.rounds?.[index] || null;
}

function getRoundPrizeAt(index) {
	if (!Number.isInteger(index) || index < 0) return "Rs 0";
	return getRoundConfigAt(index)?.prize || "Rs 0";
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
	gameState.highlightCorrect = false;
	gameState.highlightWrong = false;
	broadcast();

	timerInterval = setInterval(() => {
		gameState.timerValue -= 1;
		if (gameState.timerValue <= 0) {
			stopTimer();
			gameState.timerValue = 0;
			gameState.phase = "answer-reveal";
			gameState.highlightCorrect = true;
			gameState.highlightWrong = false;
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
	const rounds = (gameState.gameConfig.rounds || []).map((round, index) => {
		const roundNumber = index + 1;
		const questions = allQuestions
			.filter((q) => (q.levels || []).includes(roundNumber))
			.map((q) => {
				const tracking = trackingMap.get(q.trackingId) || { asked_count: 0 };
				return {
					id: q.id,
					question: q.question,
					levels: q.levels,
					mediaCount: Array.isArray(q.media) ? q.media.length : 0,
					available: Number(tracking.asked_count) === 0,
				};
			});

		return {
			roundIndex: index,
			roundNumber,
			label: round.label,
			prize: round.prize,
			timeLimit: round.timeLimit,
			questionCount: questions.length,
			availableCount: questions.filter((q) => q.available).length,
			questions,
		};
	});

	const availableCount = allQuestions.filter((q) => {
		const tracking = trackingMap.get(q.trackingId) || { asked_count: 0 };
		return Number(tracking.asked_count) === 0;
	}).length;

	return {
		questionCount: allQuestions.length,
		availableCount,
		totalRounds: rounds.length,
		rounds,
		currentRoundIndex: gameState.currentRoundIndex,
		roundsCompleted: gameState.roundsCompleted,
	};
}

async function emitQuestionsMeta(targetSocket = null) {
	const payload = await getQuestionsMetaPayload();
	if (targetSocket) sendSseEvent(targetSocket, "questions-meta", payload);
	else publish("questions-meta", payload);
}

function pickRandom(list) {
	if (!list.length) return null;
	return list[Math.floor(Math.random() * list.length)];
}

async function selectNextQuestion(roundIndex, questionId = null) {
	const trackingMap = await getTrackingMap();
	const targetRoundIndex = Number.isInteger(roundIndex)
		? roundIndex
		: Math.max(Number(gameState.currentRoundIndex) || 0, 0);
	const targetRoundNumber = targetRoundIndex + 1;

	const eligible = allQuestions.filter((q) => {
		const tracking = trackingMap.get(q.trackingId) || { asked_count: 0 };
		return (
			(q.levels || []).includes(targetRoundNumber) &&
			Number(tracking.asked_count) === 0
		);
	});

	const selected = questionId
		? eligible.find((q) => String(q.id) === String(questionId))
		: pickRandom(eligible);
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
	const roundConfig = getRoundConfigAt(targetRoundIndex);

	return {
		...selected,
		roundIndex: targetRoundIndex,
		roundNumber: targetRoundNumber,
		roundName: roundConfig?.label || `Round ${targetRoundNumber}`,
		prizeLevel: roundConfig?.prize || "",
		timeLimit: roundConfig?.timeLimit || 45,
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

function resetParticipantState(name, preserveRound = false) {
	clearLifelineOverlayTimer();
	const contestantId = "c0";
	const nextName = (name || "").trim() || "Participant";
	const currentRoundIndex = preserveRound
		? Math.max(0, Number(gameState.currentRoundIndex) || 0)
		: 0;

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
		currentRoundIndex,
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
				callFriend: true,
				audiencePoll: true,
			},
		},
		removedOptions: [],
		highlightCorrect: false,
		highlightWrong: false,
		message: "",
		introTrigger: 0,
		scores: { [contestantId]: 0 },
		roundWinners: [],
		lastOutcome: null,
		gameConfig: gameState.gameConfig,
		prizeMoneyLadder: buildPrizeLadder(gameState.gameConfig),
	};

	setActivePrizeIndex(currentRoundIndex);
}

app.get("/events", async (req, res) => {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.write(": connected\n\n");
	pubsubClients.add(res);

	const cleanup = () => pubsubClients.delete(res);
	req.on("close", cleanup);
	req.on("aborted", cleanup);

	sendSseEvent(res, "state", gameState);
	if (gameState.phase === "contestant-intro") {
		sendSseEvent(res, "play-sound", { sound: "introDramatic" });
	}
	await emitQuestionsMeta(res);
});

app.post("/api/command/:name", async (req, res) => {
	const handler = commandHandlers.get(req.params.name);
	if (!handler) {
		res.status(404).json({ ok: false, message: "Unknown command" });
		return;
	}

	try {
		const result = await handler(req.body || {});
		if (result === undefined) {
			res.json({ ok: true });
			return;
		}
		res.json(result);
	} catch (error) {
		res.status(500).json({ ok: false, message: error.message });
	}
});

registerCommand("setup-game", async ({ contestants } = {}) => {
	stopTimer();
	clearLifelineOverlayTimer();
	const firstName =
		Array.isArray(contestants) && contestants.length
			? String(contestants[0]).trim()
			: "Participant";

	resetParticipantState(firstName, false);
	gameState.roundsCompleted = 0;
	gameState.lastCompletedRoundIndex = null;
	gameState.phase = "setup";
	gameState.message = "";
	broadcast();
	await emitQuestionsMeta();
	return { ok: true, message: "Game setup - ready to begin" };
});

registerCommand("ready-game", async () => {
	clearLifelineOverlayTimer();
	gameState.phase = "contestant-intro";
	gameState.introTrigger = Number(gameState.introTrigger || 0) + 1;
	gameState.message = "";
	broadcast();
	await emitQuestionsMeta();
	return { ok: true, message: "Game started" };
});

registerCommand("reset-question-tracking", async () => {
	await resetQuestionTracking();
	await emitQuestionsMeta();
	return { ok: true, message: "Question tracking reset" };
});

registerCommand("intro-contestant", async ({ contestantId }) => {
	stopTimer();
	clearLifelineOverlayTimer();
	gameState.contestants.forEach((c) => {
		c.active = false;
	});
	const c = getContestantById(contestantId) || gameState.contestants[0];
	if (c) c.active = true;
	gameState.phase = "contestant-intro";
	gameState.introTrigger = Number(gameState.introTrigger || 0) + 1;
	gameState.message = "";
	broadcast();
	publish("play-sound", { sound: "introDramatic" });
	return { ok: true };
});

registerCommand(
	"load-next-question",
	async ({ roundIndex, questionId } = {}) => {
		stopTimer();
		clearLifelineOverlayTimer();
		publish("pause-sound", { sound: "timer45" });
		const nextRoundIndex = Number.isInteger(roundIndex)
			? roundIndex
			: Math.max(Number(gameState.currentRoundIndex) || 0, 0);

		const question = await selectNextQuestion(nextRoundIndex, questionId);
		if (!question) {
			return {
				ok: false,
				message: "No available questions left for this round.",
			};
		}

		gameState.currentRoundIndex = question.roundIndex;
		gameState.currentQuestionIndex = question.id;
		gameState.currentQuestionTrackingId = question.trackingId;
		gameState.currentQuestion = {
			id: question.id,
			question: question.question,
			options: question.options,
			difficulty: question.difficulty,
			media: question.media || [],
			roundName: question.roundName,
			prizeLevel: question.prizeLevel,
			timeLimit: question.timeLimit,
			attemptNumber: question.askedCount,
			roundIndex: question.roundIndex,
			roundNumber: question.roundNumber,
		};

		gameState.correctAnswer = question.correct;
		gameState.revealedOptions = [];
		gameState.selectedAnswer = null;
		gameState.answerEvaluated = false;
		gameState.highlightCorrect = false;
		gameState.highlightWrong = false;
		gameState.removedOptions = [];
		gameState.timerRunning = false;
		gameState.timerValue = 0;
		gameState.phase = "question";
		gameState.message = "";
		setActivePrizeIndex(gameState.currentRoundIndex);

		broadcast();
		await emitQuestionsMeta();
		return { ok: true, message: "Question loaded" };
	},
);

registerCommand("load-question", async ({ roundIndex, questionId } = {}) => {
	return commandHandlers.get("load-next-question")({ roundIndex, questionId });
});

registerCommand("reveal-option", async ({ option }) => {
	if (!gameState.revealedOptions.includes(option)) {
		gameState.revealedOptions.push(option);
	}
	broadcast();
	return { ok: true };
});

registerCommand("reveal-all-options", async () => {
	gameState.revealedOptions = ["A", "B", "C", "D"].filter(
		(o) => !gameState.removedOptions.includes(o),
	);
	startTimer(Number(gameState.currentQuestion?.timeLimit) || 45);
	publish("play-sound", { sound: "timer45" });
	broadcast();
	return { ok: true };
});

registerCommand("start-timer", async ({ seconds }) => {
	startTimer(
		Number(seconds) || Number(gameState.currentQuestion?.timeLimit) || 45,
	);
	publish("play-sound", { sound: "timer45" });
	return { ok: true };
});

registerCommand("pause-timer", async () => {
	stopTimer();
	broadcast();
	return { ok: true };
});

registerCommand("reset-timer", async () => {
	stopTimer();
	gameState.timerValue = Number(gameState.currentQuestion?.timeLimit) || 45;
	broadcast();
	return { ok: true };
});

registerCommand("lock-answer", async ({ answer }) => {
	stopTimer();
	gameState.selectedAnswer = answer;
	publish("pause-sound", { sound: "timer45" });
	publish("play-sound", { sound: "lock" });
	broadcast();
	return { ok: true };
});

registerCommand("reveal-answer", async () => {
	if (gameState.answerEvaluated) return { ok: true };
	clearLifelineOverlayTimer();

	gameState.phase = "answer-reveal";
	gameState.highlightCorrect = true;
	const isCorrect = gameState.selectedAnswer === gameState.correctAnswer;
	const resultSound = isCorrect ? "correct" : "wrong";
	gameState.highlightWrong = !isCorrect;

	const active = getActiveContestant();
	if (active && isCorrect) {
		gameState.roundsCompleted = (gameState.roundsCompleted || 0) + 1;
		gameState.scores[active.id] = gameState.roundsCompleted;
		active.score = gameState.roundsCompleted;
		gameState.lastCompletedRoundIndex = gameState.currentRoundIndex;

		const nextRoundIndex = gameState.currentRoundIndex + 1;
		if (nextRoundIndex >= (gameState.gameConfig.rounds || []).length) {
			gameState.phase = "game-over";
			gameState.lastOutcome = {
				type: "grand-prize",
				name: active.name,
				prize: getRoundPrizeAt(gameState.currentRoundIndex),
			};
		} else {
			gameState.currentRoundIndex = nextRoundIndex;
			gameState.phase = "round-end";
			gameState.lastOutcome = null;
		}
	} else if (active && !isCorrect) {
		active.eliminated = true;
		active.active = false;
		gameState.phase = "walkout";
		gameState.lastOutcome = {
			type: "walkout",
			name: active.name,
			prize: getRoundPrizeAt(gameState.lastCompletedRoundIndex),
		};
	}

	gameState.answerEvaluated = true;
	await markCurrentQuestionResult(isCorrect);
	setActivePrizeIndex(gameState.currentRoundIndex);

	// If the phase already moved past answer reveal, emit result audio explicitly.
	if (gameState.phase !== "answer-reveal") {
		publish("play-sound", { sound: resultSound });
	}

	broadcast();
	await emitQuestionsMeta();
	return { ok: true };
});

registerCommand("lifeline-fifty-fifty", async ({ contestantId }) => {
	const lifelines = getContestantLifelines(contestantId);
	if (!lifelines?.fiftyFifty) return { ok: true };
	lifelines.fiftyFifty = false;

	const trackingId = gameState.currentQuestionTrackingId;
	const correct = gameState.correctAnswer;
	const allOptions = ["A", "B", "C", "D"];
	const wrong = allOptions.filter(
		(o) => o !== correct && !gameState.removedOptions.includes(o),
	);
	const toRemove = wrong.sort(() => Math.random() - 0.5).slice(0, 2);
	publish("play-sound", { sound: "lifeline" });
	publish("play-sound", { sound: "suspense4" });
	broadcast();
	setTimeout(() => {
		if (gameState.currentQuestionTrackingId !== trackingId) return;
		const currentWrong = ["A", "B", "C", "D"].filter(
			(o) =>
				o !== gameState.correctAnswer && !gameState.removedOptions.includes(o),
		);
		const nextRemoved = currentWrong
			.sort(() => Math.random() - 0.5)
			.slice(0, 2);
		gameState.removedOptions = Array.from(
			new Set([...gameState.removedOptions, ...nextRemoved]),
		);
		gameState.revealedOptions = gameState.revealedOptions.filter(
			(o) => !nextRemoved.includes(o),
		);
		broadcast();
	}, 6000);

	return { ok: true };
});

registerCommand("lifeline-phone", async ({ contestantId }) => {
	const lifelines = getContestantLifelines(contestantId);
	if (!lifelines?.callFriend) return { ok: true };
	lifelines.callFriend = false;
	publish("play-sound", { sound: "lifeline" });
	showTemporaryLifelineOverlay("lifeline-phone", 5000);
	return { ok: true };
});

registerCommand("lifeline-audience", async ({ contestantId }) => {
	const lifelines = getContestantLifelines(contestantId);
	if (!lifelines?.audiencePoll) return { ok: true };
	lifelines.audiencePoll = false;
	publish("play-sound", { sound: "lifeline" });
	showTemporaryLifelineOverlay("lifeline-poll", 5000);
	return { ok: true };
});

registerCommand("show-message", async ({ message }) => {
	gameState.message = message;
	broadcast();
	return { ok: true };
});

registerCommand("clear-message", async () => {
	gameState.message = "";
	broadcast();
	return { ok: true };
});

registerCommand("play-sound", async ({ sound }) => {
	const safeSound = String(sound || "").trim();
	if (!safeSound) return { ok: false, message: "Sound name required" };
	publish("play-sound", { sound: safeSound });
	return { ok: true };
});

registerCommand("round-end", async () => {
	stopTimer();
	clearLifelineOverlayTimer();
	gameState.phase = "round-end";
	broadcast();
	return { ok: true };
});

registerCommand("game-over", async () => {
	stopTimer();
	clearLifelineOverlayTimer();
	gameState.phase = "game-over";
	broadcast();
	return { ok: true };
});

registerCommand("reset-game", async () => {
	stopTimer();
	clearLifelineOverlayTimer();
	resetParticipantState("Participant", false);
	gameState.contestants = [];
	gameState.message = "";
	broadcast();
	return { ok: true };
});

registerCommand("reset-for-next-participant", async ({ name }) => {
	stopTimer();
	clearLifelineOverlayTimer();
	resetParticipantState(name, true);
	gameState.phase = "contestant-intro";
	gameState.introTrigger = Number(gameState.introTrigger || 0) + 1;
	gameState.message = "";
	broadcast();
	publish("play-sound", { sound: "introDramatic" });
	return { ok: true };
});

app.get("/reload-questions", async (req, res) => {
	try {
		questionsData = JSON.parse(fs.readFileSync(QUESTIONS_FILE_PATH, "utf-8"));
		allQuestions = buildQuestionBank(questionsData);
		await ensureTrackingRows();
		gameState.gameConfig = buildGameConfig(questionsData);
		gameState.prizeMoneyLadder = buildPrizeLadder(gameState.gameConfig);
		setActivePrizeIndex(gameState.currentRoundIndex);
		await emitQuestionsMeta();
		res.json({ success: true, message: "Questions reloaded!" });
	} catch (e) {
		res.status(500).json({ success: false, message: e.message });
	}
});

(async () => {
	try {
		await initQuestionDb();
		await ensureTrackingRows();
		gameState.gameConfig = buildGameConfig(questionsData);
		gameState.prizeMoneyLadder = buildPrizeLadder(gameState.gameConfig);
		setActivePrizeIndex(0);

		server.listen(PORT, () => {
			console.log("\n🎯 Koun Banega Codepati is LIVE!");
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
