# 🎯 Koun Banega Codepathi (KBC)
> A real-time game show app for college events. Runs fully on localhost.

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
cd kbc
npm install
```

### 2. Start the Server
```bash
npm start
```

### 3. Open the Two Screens
| Screen | URL | Purpose |
|---|---|---|
| **Display** | http://localhost:3000/display.html | Project this on the big screen |
| **Admin** | http://localhost:3000/admin.html | You control from this tab |

> Tip: Open Display in full screen (F11), then switch to Admin tab to control.

---

## 🎮 How to Run a Game

### Before the Event
1. Edit `data/questions.json` with your actual questions (see format below)
2. You can add as many rounds and questions as you want

### Running the Show

1. **Setup** → Click ⚙️ Setup on Admin → Enter contestant names → 🚀 Start Game
2. **Intro a contestant** → Click 🎤 next to their name → Display shows their name dramatically
3. **Load a question** → Click a question from the list in Admin → It appears on the display
4. **Reveal options** → Click A, B, C, D buttons one by one for dramatic effect (or "Reveal All")
5. **Start timer** → Click ▶ Start (uses the round's default time, or set a custom duration)
6. **Lock answer** → When contestant decides, click "Lock A/B/C/D"
7. **Reveal answer** → Click ✅ Reveal Correct Answer
8. **Eliminate or Advance** → Click ❌ or 🏅 for the contestant
9. **Repeat** for next contestant / question

### Lifelines
- **50:50** → Removes 2 wrong options from the display automatically
- **Audience Poll** → First click "Use" to mark it used, then have audience raise hands, enter counts in the right panel → click 📊 Show Poll
- **Phone a Friend** → Shows a phone overlay on the display screen

### Rounds
- Each round in `questions.json` is a separate difficulty tier
- Use "🏁 End Current Round" to show the round end screen
- Mark winners with 🏅, then start next round

---

## 📝 Questions Format (`data/questions.json`)

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
          "question": "Your question here?",
          "options": {
            "A": "Option A",
            "B": "Option B",
            "C": "Option C",
            "D": "Option D"
          },
          "correct": "B",
          "difficulty": "easy"
        }
      ]
    }
  ]
}
```

- `timeLimit` is in seconds
- `correct` is the key of the correct option: `"A"`, `"B"`, `"C"`, or `"D"`
- `difficulty` can be `"easy"`, `"medium"`, or `"hard"` (affects badge color in admin)
- Add as many rounds and questions as you need!

### Hot Reload Questions
If you edit `questions.json` while the server is running, click **🔄 Reload Questions** in the Admin panel — no restart needed.

---

## 🏆 Multiple Contestants / Rounds Flow

```
Setup (add all contestants)
    ↓
Round 1:
  For each contestant:
    Intro → Load question → Reveal options → Timer → Lock answer → Reveal → Advance/Eliminate
    ↓
  End Round → Show round winners
    ↓
Round 2 (with advancing contestants):
  Repeat above
    ↓
Final Round → Game Over screen
```

---

## 📁 Project Structure

```
kbc/
├── server.js              ← Node.js + Socket.IO server
├── package.json
├── data/
│   └── questions.json     ← ✏️ Edit this with your questions
└── public/
    ├── display.html       ← 📺 Project this on screen
    └── admin.html         ← 🕹 Your control panel
```

---

## 💡 Tips for the Event

- Test everything 30 minutes before the event
- Keep Admin tab open on your laptop, Display tab full-screened
- Use Message Overlay for dramatic moments ("Is that your final answer? 🔥")
- The audience poll counts panel is on the right side of Admin — enter counts as hands go up
- You can open Admin on your phone too (connect phone to same WiFi/hotspot as laptop)

---

Made with ❤️ for college events. Good luck! 🎉
