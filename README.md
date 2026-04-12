# Koun Banega codepati (KBC)

Real-time game show app for local events.

## Quick Start

```bash
npm install
npm start
```

- Display screen: http://localhost:3000/display.html
- Admin panel: http://localhost:3000/admin.html

## New Game Model

- One question = one round attempt.
- Correct answer: current participant completes that round and game moves to next round.
- Wrong answer: participant is eliminated.
- Admin starts a new participant with Next participant.
- No points system is required by game logic; admin flow is round-progress based.

## Single Source of Round Count

Edit only [data/questions.json](data/questions.json) in gameConfig.rounds.

- Number of entries in gameConfig.rounds = number of rounds.
- Round money/prize is also defined there.
- Admin panel no longer edits round count or prize plan.

## Questions JSON Format

```json
{
	"gameConfig": {
		"rounds": [
			{ "label": "Round 1", "prize": "₹10,000", "timeLimit": 30 },
			{ "label": "Round 2", "prize": "₹50,000", "timeLimit": 45 }
		]
	},
	"questions": [
		{
			"id": 1,
			"levels": [1, 2],
			"question": "Your question here?",
			"options": {
				"A": "Option A",
				"B": "Option B",
				"C": "Option C",
				"D": "Option D"
			},
			"correct": "B"
		}
	]
}
```

Notes:

- levels is an array so a question can appear in multiple rounds.
- Question is eligible only if its level includes current round number.
- A question is treated as used once loaded.
- timeLimit is in seconds.

### Optional media per question

You can attach local media to any question with a `media` field.

```json
{
	"id": 10,
	"levels": [1],
	"question": "Identify this logo",
	"options": {
		"A": "Node.js",
		"B": "Docker",
		"C": "Kubernetes",
		"D": "Redis"
	},
	"correct": "B",
	"media": [
		{
			"type": "image",
			"src": "/assets/logo.jpg",
			"caption": "Look at the visual clue"
		},
		{
			"type": "audio",
			"src": "/sounds/Intro.mp3",
			"controls": true
		},
		{
			"type": "video",
			"src": "/assets/kbc.mp4",
			"controls": true
		}
	]
}
```

Rules:

- Use local paths served from `public/` (for example `/media/question1.png` maps to `public/media/question1.png`).
- GIF files are supported as `type: "image"` (or by using a `.gif` file path).
- `media` can be a single object, a string path, or an array.

## Admin Flow

1. Set participant.
2. Intro participant.
3. In Available Questions, either:
   - click Use on a specific question, or
   - click Randomize question.
4. Reveal options, run timer, lock answer.
5. Reveal answer.
6. If wrong, click Next participant and continue from the same round.
7. If correct, system advances to next round.

## Reload Questions Without Restart

After editing [data/questions.json](data/questions.json), click Reload Questions in admin.

## Project Structure

```text
kbc/
├── server.js
├── package.json
├── data/
│   └── questions.json
└── public/
		├── display.html
		└── admin.html
```
