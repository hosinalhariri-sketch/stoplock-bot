const { Bot, InlineKeyboard } = require("grammy");
const fs = require("fs");
const express = require("express");
const cors = require("cors");

// 🔑 Telegram Bot Token & WebApp URL
const BOT_TOKEN = process.env.BOT_TOKEN || "8897585537:AAG08N6a05gtkhHgs6GD-UMnpoExZaSd1sQ"; 
const MINI_APP_URL = "https://stop-lock-challenge.vercel.app/";

const bot = new Bot(BOT_TOKEN);
const app = express();
app.use(express.json());
app.use(cors());

const DB_FILE = "./users.json";
const ROOMS_FILE = "./rooms.json";

// Helper functions for Database
function loadData(file) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({}));
  try { return JSON.parse(fs.readFileSync(file)); } catch (e) { return {}; }
}

function saveData(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Save error:", e);
  }
}

function ensureUserExists(users, userId, name) {
  if (!users[userId]) {
    users[userId] = {
      id: userId,
      username: name || `Player_${userId}`,
      points: 2.0,
      bestDiff: null,
      lastClaimDate: null,
      referralsCount: 0,
      createdAt: new Date().toISOString()
    };
  }
}

// ==========================================
// 🌐 API ENDPOINTS (FOR MINI APP CONNECTION)
// ==========================================

// 🟢 0. Main Health Check
app.get("/", (req, res) => {
  res.status(200).send("🚀 StopLock Server is Live and Active!");
});

// 🔄 1. Get Updated User Data
app.get("/api/user-data/:userId", (req, res) => {
  const users = loadData(DB_FILE);
  const u = users[req.params.userId];
  if (!u) return res.status(404).json({ error: "User not found" });
  res.json({ points: u.points, bestDiff: u.bestDiff });
});

// 🏆 2. Get Top 50 Global Leaderboard
app.get("/api/top50", (req, res) => {
  const users = loadData(DB_FILE);
  const sorted = Object.values(users)
    .filter(u => u && u.bestDiff !== null && u.bestDiff !== undefined)
    .sort((a, b) => a.bestDiff - b.bestDiff)
    .slice(0, 50);

  res.json(sorted);
});

// 🎁 3. Claim Daily Reward (+0.5 Point)
app.post("/api/claim-daily", (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  const users = loadData(DB_FILE);
  ensureUserExists(users, userId);

  const today = new Date().toDateString();
  if (users[userId].lastClaimDate === today) {
    return res.status(400).json({ error: "Already claimed today", points: users[userId].points });
  }

  users[userId].points = (users[userId].points || 0) + 0.5;
  users[userId].lastClaimDate = today;
  saveData(DB_FILE, users);

  res.json({ success: true, points: users[userId].points });
});

// ⭐ 4. Create Telegram Stars Payment Invoice Link
app.post("/api/create-stars-invoice", async (req, res) => {
  const { userId, mode, starsCount } = req.body;
  if (!userId || !starsCount) return res.status(400).json({ error: "Missing data" });

  try {
    const invoiceLink = await bot.api.createInvoiceLink(
      `StopLock - ${mode.toUpperCase()} Item`,
      `Stars Entry / Cosmetics unlock for ${mode.toUpperCase()}`,
      JSON.stringify({ userId, mode }),
      "", 
      "XTR", 
      [{ label: `${starsCount} Stars`, amount: starsCount }]
    );

    res.json({ success: true, invoiceLink });
  } catch (e) {
    console.error("Invoice Error:", e);
    res.status(500).json({ error: "Failed to generate invoice" });
  }
});

// 🔍 5. Fetch Room Status and Players
app.get("/api/room-status/:roomId", (req, res) => {
  const { roomId } = req.params;
  const rooms = loadData(ROOMS_FILE);
  
  let foundRoom = null;
  for (const mode in rooms) {
    if (rooms[mode]?.activeRooms && rooms[mode].activeRooms[roomId]) {
      foundRoom = rooms[mode].activeRooms[roomId];
      break;
    }
  }

  res.json({ players: foundRoom || [] });
});

// 🚪 6. Player Exits Room / Concludes Match
app.post("/api/leave-room", async (req, res) => {
  const { userId, roomId, mode } = req.body;
  if (!userId || !roomId || !mode) return res.status(400).json({ error: "Missing data" });

  const rooms = loadData(ROOMS_FILE);
  if (rooms[mode]?.activeRooms?.[roomId]) {
    let currentRoomPlayers = rooms[mode].activeRooms[roomId];
    const player = currentRoomPlayers.find(p => String(p.userId) === String(userId));
    if (player) {
      player.hasFinished = true;
    }
    saveData(ROOMS_FILE, rooms);
    
    await checkAndFinalizeRoom(mode, roomId);
  }
  res.json({ success: true });
});

// 🏆 7. Submit Score & Update Leaderboards
app.post("/api/submit-score", async (req, res) => {
  const { userId, mode, diff, cost, roomId, attemptNumber } = req.body;
  if (!userId || !mode || diff === undefined) return res.status(400).json({ error: "Invalid data" });

  const users = loadData(DB_FILE);
  const rooms = loadData(ROOMS_FILE);

  ensureUserExists(users, userId);

  if (cost && cost > 0) {
    users[userId].points = Math.max(0, (users[userId].points || 0) - cost);
  }

  const cleanDiff = parseFloat(Number(diff).toFixed(3));

  if (users[userId].bestDiff === null || users[userId].bestDiff === undefined || cleanDiff < users[userId].bestDiff) {
    users[userId].bestDiff = cleanDiff;
  }

  const activeRoomKey = roomId || `${mode}_room_${rooms[mode]?.currentRoomId || 1}`;

  if (!rooms[mode]) rooms[mode] = { currentRoomId: 1, activeRooms: {} };
  if (!rooms[mode].activeRooms) rooms[mode].activeRooms = {};
  if (!rooms[mode].activeRooms[activeRoomKey]) {
    rooms[mode].activeRooms[activeRoomKey] = [];
  }

  let currentRoomPlayers = rooms[mode].activeRooms[activeRoomKey];

  const existingPlayerIndex = currentRoomPlayers.findIndex(p => String(p.userId) === String(userId));

  if (existingPlayerIndex !== -1) {
    if (cleanDiff < currentRoomPlayers[existingPlayerIndex].diff) {
      currentRoomPlayers[existingPlayerIndex].diff = cleanDiff;
    }
    if (attemptNumber >= 2) {
      currentRoomPlayers[existingPlayerIndex].hasFinished = true;
    }
  } else {
    currentRoomPlayers.push({ 
      userId: String(userId), 
      username: users[userId].username, 
      diff: cleanDiff,
      hasFinished: attemptNumber >= 2
    });
  }

  saveData(DB_FILE, users);
  saveData(ROOMS_FILE, rooms);

  await checkAndFinalizeRoom(mode, activeRoomKey);

  res.json({ 
    success: true, 
    points: users[userId].points,
    roomId: activeRoomKey,
    roomPlayers: currentRoomPlayers
  });
});

// 🏁 Finalize Room Match and Award Bonus Points
async function checkAndFinalizeRoom(mode, roomId) {
  const rooms = loadData(ROOMS_FILE);
  const users = loadData(DB_FILE);

  if (!rooms[mode]?.activeRooms?.[roomId]) return;

  let currentRoomPlayers = rooms[mode].activeRooms[roomId];
  const targetPlayers = mode === 'duel' ? 2 : 10;

  const isCapacityFull = currentRoomPlayers.length >= targetPlayers;
  const allPlayersFinished = currentRoomPlayers.every(p => p.hasFinished === true);

  if (isCapacityFull && allPlayersFinished) {
    currentRoomPlayers.sort((a, b) => a.diff - b.diff);

    if (mode === 'duel') {
      const winner = currentRoomPlayers[0];
      const loser = currentRoomPlayers[1];

      if (winner && users[winner.userId]) {
        users[winner.userId].points = (users[winner.userId].points || 0) + 2;
        try {
          await bot.api.sendMessage(winner.userId, `⚔️ **Victory!**\nYou won the 1v1 duel with a diff of \`${winner.diff}s\` against \`${loser ? loser.diff : '-'}s\`!\nEarned **+2 Bonus Points** 🪙!`);
        } catch (e) {}
      }

      if (loser && users[loser.userId]) {
        try {
          await bot.api.sendMessage(loser.userId, `⚔️ **Defeat!**\nYou lost the duel with a diff of \`${loser.diff}s\` against \`${winner.diff}s\`.`);
        } catch (e) {}
      }

    } else {
      const winner1 = currentRoomPlayers[0];
      if (winner1 && users[winner1.userId]) {
        users[winner1.userId].points = (users[winner1.userId].points || 0) + 5;
        try { await bot.api.sendMessage(winner1.userId, `🥇 **1st Place!** In (${mode.toUpperCase()}) match with \`${winner1.diff}s\` diff! Earned **+5 Bonus Points** 🪙!`); } catch (e) {}
      }
    }

    delete rooms[mode].activeRooms[roomId];
    rooms[mode].currentRoomId = (rooms[mode].currentRoomId || 1) + 1;

    saveData(DB_FILE, users);
    saveData(ROOMS_FILE, rooms);
  }
}

// ==========================================
// 🤖 TELEGRAM BOT COMMANDS & HANDLERS
// ==========================================

// ⭐ Pre-checkout Handler for Telegram Stars
bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true));

// ⭐ Successful Payment Handler for Telegram Stars
bot.on("message:successful_payment", async (ctx) => {
  try {
    await ctx.reply("🌟 **Payment Confirmed!**\nYour item / cosmetics have been unlocked! 🚀");
  } catch (e) {}
});

bot.command("start", async (ctx) => {
  const userId = ctx.from.id;
  const users = loadData(DB_FILE);
  const args = ctx.match;

  let isNewUser = !users[userId];
  ensureUserExists(users, userId, ctx.from.username || ctx.from.first_name);

  if (isNewUser && args && args !== String(userId)) {
    const referrerId = args;
    ensureUserExists(users, referrerId, `Player_${referrerId}`);

    users[referrerId].points = (users[referrerId].points || 0) + 1;
    users[referrerId].referralsCount = (users[referrerId].referralsCount || 0) + 1;

    try {
      await ctx.api.sendMessage(
        referrerId,
        `🎉 **New Referral Bonus!**\nA friend joined using your link! You earned **+1 Free Point** 🪙\nTotal Balance: **${users[referrerId].points} Points**.`
      );
    } catch (e) {}
  }

  saveData(DB_FILE, users);

  const currentUser = users[userId];
  const inviteLink = `https://t.me/${ctx.me.username}?start=${userId}`;

  const welcomeText = isNewUser
    ? `🎯 **WELCOME TO STOPLOCK CHALLENGE!** 🎯\n\n` +
      `Test your speed and precision against the clock! ⏱️🔥\n\n` +
      `🎁 **WELCOME BONUS:**\n` +
      `You received **2 FREE POINTS** to start! 🪙\n\n` +
      `📊 **YOUR PROFILE:**\n` +
      `• 🪙 **Points:** \`${currentUser.points.toFixed(1)}\`\n` +
      `• 🏆 **Best Record:** \`No records yet\`\n\n` +
      `👇 Tap **Play StopLock Trend** below to climb Global TOP 50!`
    : `⚡ **WELCOME BACK, CHAMPION!** ⚡\n\n` +
      `Ready to break your record and climb the Global Top 50? 🚀\n\n` +
      `📊 **YOUR PROFILE:**\n` +
      `• 🪙 **Points:** \`${currentUser.points.toFixed(1)}\`\n` +
      `• 🏆 **Best Record:** \`${currentUser.bestDiff !== null && currentUser.bestDiff !== undefined ? currentUser.bestDiff + 's' : 'No records yet'}\`\n\n` +
      `👇 Tap **Play StopLock Trend** below to play!`;

  const keyboard = new InlineKeyboard()
    .webApp("🟢 Play StopLock Trend", MINI_APP_URL)
    .row()
    .url("👥 Invite Friends (+1 Point)", `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent("Join StopLock Challenge and test your precision to reach Global TOP 50! ⏱️🔥")}`)
    .row()
    .text("🏆 Global TOP 50", "show_leaderboard")
    .text("📜 Rules & FAQ", "show_rules");

  await ctx.reply(welcomeText, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
});

bot.callbackQuery("show_leaderboard", async (ctx) => {
  const users = loadData(DB_FILE);
  const sorted = Object.values(users)
    .filter(u => u && u.bestDiff !== null && u.bestDiff !== undefined)
    .sort((a, b) => a.bestDiff - b.bestDiff)
    .slice(0, 15);

  if (sorted.length === 0) {
    return ctx.answerCallbackQuery({ text: "🏆 No leaderboard records yet!", show_alert: true });
  }

  let leaderText = "🏆 **Global Leaderboard Top 15:**\n\n";
  sorted.forEach((u, idx) => {
    leaderText += `${idx + 1}. **${u.username}** — \`${u.bestDiff}s\`\n`;
  });

  await ctx.reply(leaderText, { parse_mode: "Markdown" });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("show_rules", async (ctx) => {
  const rulesText = `📜 **STOPLOCK RULES & FAQ:**\n\n` +
    `1️⃣ **Points & Bonus:** Get 2 free points on join, +0.5 daily claim, watch optional ads for **+1 Free Point** 🪙 (Up to 5 ads/day), and +1 point for each friend invited.\n\n` +
    `2️⃣ **Top 50 Ranking:** Compete globally! The closer your timing is to the target (lowest Diff), the higher you rank on the Leaderboard.\n\n` +
    `3️⃣ **Private Rooms:** Create custom rooms to challenge your friends directly and prove your precision speed!\n\n` +
    `4️⃣ **Cosmetics & Skins:** Collect points or Telegram Stars ⭐ to unlock custom LED timer displays, golden buzzer buttons, and profile badges.`;
  
  await ctx.reply(rulesText, { parse_mode: "Markdown" });
  await ctx.answerCallbackQuery();
});

// Start Express Server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌐 API Server running on port ${PORT}`));

// Start Bot Engine & Drop Old Blocked Updates
bot.start({
  drop_pending_updates: true
});
console.log("🚀 StopLock Bot Backend is active and running...");