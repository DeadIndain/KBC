Here's the full context dump:

---

## Project: Koun Banega codepati (KBC)

**Type:** Real-time game show app for a college event. Runs fully on localhost, no hosting, no auth needed.

**Stack:**

- Backend: Node.js + Express + SSE pub/sub (`server.js`)
- Frontend: Vanilla HTML/CSS/JS (two static files served by Express)
- No database, no build step

**Run command:** `npm start` → server on `http://localhost:3000`

---

## Two Pages

| File                  | URL             | Purpose                                          |
| --------------------- | --------------- | ------------------------------------------------ |
| `public/display.html` | `/display.html` | Projected on the big screen — audience sees this |
| `public/admin.html`   | `/admin.html`   | Host's control panel — run the show from here    |

---

## Data File

`data/questions.json` — pre-loaded questions, structured as:

```json
{
	"rounds": [
		{
			"roundName": "Round 1 - Warm Up",
			"prizeLevel": "₹10,000",
			"timeLimit": 30,
			"questions": [
				{
					"id": 1,
					"question": "...",
					"options": { "A": "...", "B": "...", "C": "...", "D": "..." },
					"correct": "B",
					"difficulty": "easy"
				}
			]
		}
	]
}
```

---

## Pub/Sub Events (Admin → Server → Display)

| Event                  | Payload                         | What it does                                        |
| ---------------------- | ------------------------------- | --------------------------------------------------- |
| `setup-game`           | `{ contestants: [names] }`      | Initializes entire game state                       |
| `intro-contestant`     | `{ contestantId }`              | Shows contestant name on display                    |
| `load-question`        | `{ roundIndex, questionIndex }` | Loads question onto display                         |
| `reveal-option`        | `{ option: 'A'/'B'/'C'/'D' }`   | Reveals one option at a time                        |
| `reveal-all-options`   | —                               | Reveals all remaining options                       |
| `start-timer`          | `{ seconds? }`                  | Starts countdown (uses round default if no seconds) |
| `pause-timer`          | —                               | Pauses timer                                        |
| `reset-timer`          | —                               | Resets to round default                             |
| `lock-answer`          | `{ answer }`                    | Marks contestant's chosen answer                    |
| `reveal-answer`        | —                               | Highlights correct (green) / wrong (red)            |
| `eliminate-contestant` | `{ contestantId }`              | Marks contestant as out                             |
| `advance-contestant`   | `{ contestantId }`              | Marks contestant as round winner                    |
| `lifeline-fifty-fifty` | `{ contestantId }`              | Removes 2 wrong options                             |
| `lifeline-audience`    | `{ contestantId }`              | Marks lifeline used, switches phase                 |
| `lifeline-phone`       | `{ contestantId }`              | Shows phone overlay on display                      |
| `end-lifeline-phone`   | —                               | Dismisses phone overlay                             |
| `submit-audience-poll` | `{ counts: {A,B,C,D} }`         | Converts raw hand counts → % → shows bar chart      |
| `show-message`         | `{ message }`                   | Shows full-screen message overlay                   |
| `clear-message`        | —                               | Dismisses message overlay                           |
| `round-end`            | —                               | Shows round end screen                              |
| `game-over`            | —                               | Shows game over / winner screen                     |
| `reset-game`           | —                               | Full reset back to lobby                            |

Server also emits:

- `state` → full game state object, sent to ALL clients on every change
- `questions-meta` → round names, prize levels, question counts, time limits (no correct answers exposed)

---

## Game State Object (what display.html receives on every `state` event)

```js
{
  phase: 'lobby' | 'contestant-intro' | 'question' | 'answer-reveal' | 'lifeline-poll' | 'lifeline-phone' | 'round-end' | 'game-over',
  contestants: [
    { id: 'c0', name: 'Alice', active: true, eliminated: false, score: 2 }
  ],
  currentContestantIndex: 0,
  currentRoundIndex: 0,
  currentQuestionIndex: 1,
  currentQuestion: {
    id: 2,
    question: '...',
    options: { A: '...', B: '...', C: '...', D: '...' },
    difficulty: 'medium'
  },
  correctAnswer: 'C',        // present in state (display uses it for highlight)
  selectedAnswer: 'B',       // what contestant locked in
  revealedOptions: ['A','B'], // which options are currently visible
  removedOptions: ['B','D'], // removed by 50-50
  highlightCorrect: false,   // true after reveal-answer
  highlightWrong: false,
  timerRunning: true,
  timerValue: 23,
  lifelines: {
    'c0': { fiftyFifty: true, audiencePoll: false, phoneFriend: true }
  },
  audiencePollData: { A: 10, B: 65, C: 15, D: 10 }, // percentages, null if not active
  message: '',               // overlay message string
  scores: { 'c0': 2, 'c1': 1 },
  roundWinners: ['c0'],
  prizeMoneyLadder: [
    { round: 1, name: 'Round 1', prize: '₹10,000', active: false },
    { round: 2, name: 'Round 2', prize: '₹50,000', active: true },
    { round: 3, name: 'Final', prize: '₹1,00,000', active: false }
  ]
}
```

---

## Display Screen — Current Design

**Aesthetic:** Dark blue space theme, gold accents, cyan highlights

- Fonts: `Cinzel` (display/headers) + `Rajdhani` (body) from Google Fonts
- CSS variables: `--gold: #f5c842`, `--deep-blue: #050a1f`, `--accent: #00d4ff`, `--correct: #00e676`, `--wrong: #ff1744`
- Animated background: radial gradients + subtle grid + floating particles
- All screens are `position: absolute` divs toggled with `.active` class

**Screens in display.html:**

1. `#screen-lobby` — logo + contestant chips
2. `#screen-intro` — full-screen contestant name reveal animation
3. `#screen-question` — main game layout (question + options + timer + sidebar)
4. `#screen-round-end` — round complete + winners list
5. `#screen-game-over` — final winner podium

**Question screen layout:**

```
[Header: logo | contestant name + round]
[Timer circle | Lifeline icons (50:50, 👥, 📞)]
[Question box — centered text, gold border, shimmer animation]
[Options grid — 2x2, options pop in one at a time]
[Audience poll bars — hidden unless audiencePollData present]
                                    [Sidebar: prize ladder + contestant scores]
```

**Option card states:** default (hidden) → `revealed` (pop-in animation) → `selected` (gold) → `correct` (green flash) / `wrong` (red)

**Overlays (fixed, z-index above everything):**

- Phone friend overlay — full screen with ringing phone animation
- Message overlay — full screen with large text

---

## Admin Panel — Current Design

**Aesthetic:** GitHub dark theme (dark grays, subtle borders)

- 3-column layout: `320px | 1fr | 260px`
- Left: contestant list + game flow + message overlay controls
- Center: question browser (round tabs → question list) + active question controls (reveal options, lock answer, reveal answer)
- Right: timer, lifelines, audience poll input

**Key admin interactions:**

- 🎤 Intro → `intro-contestant`
- ❌ Eliminate → `eliminate-contestant`
- 🏅 Advance → `advance-contestant`
- Click question → `load-question`
- Reveal A/B/C/D buttons → `reveal-option`
- Lock A/B/C/D → `lock-answer`
- ✅ Reveal Answer → `reveal-answer`
- Audience poll: enter raw hand counts per option → auto converts to % on submit
- Message presets: "Correct!", "Wrong!", "Time's Up!", "Final Answer?", "KBC"
- Hot reload questions without server restart: `GET /reload-questions`

---

## What Could Be Improved on the Frontend

Things the current version doesn't have yet:

- **Sound effects** — folder `public/sounds/` exists and there are sounds but its not implimented properly.
- **Question text in admin** — the question list shows placeholder text ("Click to load") instead of actual question text, because the admin only receives `questions-meta` (no correct answers), not full question content. Could add a separate `/questions-for-admin` endpoint
- **Smoother transitions** between screens (currently just toggle)
- **Contestant turn order** is manual (host clicks intro) — could add a "Next Contestant" auto-advance button
- **Score history** — no per-question breakdown, just total count

---

That's everything. The two files to improve are `public/display.html` and `public/admin.html`. The server (`server.js`) and game logic don't need changes unless you add new socket events.
