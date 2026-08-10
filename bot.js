const { Bot, InlineKeyboard } = require("grammy");
const fs = require("fs");
const express = require("express");
const cors = require("cors");

// 🔑 Telegram Bot Token & WebApp URL
const BOT_TOKEN = process.env.BOT_TOKEN || "8897585537:AAHfOpaFJB7fw4xwsQ3WJF3HFxOiZcfgchc"; 
const MINI_APP_URL = "https://stop-lock-challenge.vercel.app/";

const bot = new Bot(BOT_TOKEN);
const app = express();
app.use(express.json());
app.use(cors());

const DB_FILE = "./users.json";
const ROOMS_FILE = "./rooms.json";

// Fast Memory Caching for optimal speed
let usersCache = loadData(DB_FILE);
let roomsCache = loadData(ROOMS_FILE);

function loadData(file) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({}));
  try { return JSON.parse(fs.readFileSync(file)); } catch (e) { return {}; }
}

function saveData(file, data) {
  fs.writeFile(file, JSON.stringify(data, null, 2), () => {});
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

// Helper to determine language preference (en / fr)
function getLang(ctx) {
  const code = ctx.from?.language_code || "en";
  return code.startsWith("fr") ? "fr" : "en";
}

// ==========================================
// 🌐 API ENDPOINTS (FOR MINI APP CONNECTION)
// ==========================================

app.get("/", (req, res) => {
  res.status(200).send("🚀 StopLock Server is Live and Active!");
});

app.get("/api/user-data/:userId", (req, res) => {
  const u = usersCache[req.params.userId];
  if (!u) return res.status(404).json({ error: "User not found" });
  res.json({ points: u.points });
});

app.get("/api/top50", (req, res) => {
  const sorted = Object.values(usersCache)
    .filter(u => u && u.bestDiff !== null && u.bestDiff !== undefined)
    .sort((a, b) => a.bestDiff - b.bestDiff)
    .slice(0, 50);

  res.json(sorted);
});

app.post("/api/claim-daily", (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  ensureUserExists(usersCache, userId);

  const today = new Date().toDateString();
  if (usersCache[userId].lastClaimDate === today) {
    return res.status(400).json({ error: "Already claimed today", points: usersCache[userId].points });
  }

  usersCache[userId].points = (usersCache[userId].points || 0) + 0.5;
  usersCache[userId].lastClaimDate = today;
  saveData(DB_FILE, usersCache);

  res.json({ success: true, points: usersCache[userId].points });
});

app.get("/api/room-status/:roomId", (req, res) => {
  const { roomId } = req.params;
  let foundRoom = null;
  for (const mode in roomsCache) {
    if (roomsCache[mode]?.activeRooms && roomsCache[mode].activeRooms[roomId]) {
      foundRoom = roomsCache[mode].activeRooms[roomId];
      break;
    }
  }

  res.json({ players: foundRoom || [] });
});

app.post("/api/leave-room", async (req, res) => {
  const { userId, roomId, mode } = req.body;
  if (!userId || !roomId || !mode) return res.status(400).json({ error: "Missing data" });

  if (roomsCache[mode]?.activeRooms?.[roomId]) {
    let currentRoomPlayers = roomsCache[mode].activeRooms[roomId];
    const player = currentRoomPlayers.find(p => String(p.userId) === String(userId));
    if (player) {
      player.hasFinished = true;
    }
    saveData(ROOMS_FILE, roomsCache);
    
    await checkAndFinalizeRoom(mode, roomId);
  }
  res.json({ success: true });
});

app.post("/api/submit-score", async (req, res) => {
  const { userId, mode, diff, cost, roomId, attemptNumber } = req.body;
  if (!userId || !mode || diff === undefined) return res.status(400).json({ error: "Invalid data" });

  ensureUserExists(usersCache, userId);

  if (cost && cost > 0) {
    usersCache[userId].points = Math.max(0, (usersCache[userId].points || 0) - cost);
  }

  const cleanDiff = parseFloat(Number(diff).toFixed(3));

  if (usersCache[userId].bestDiff === null || cleanDiff < usersCache[userId].bestDiff) {
    usersCache[userId].bestDiff = cleanDiff;
  }

  const activeRoomKey = roomId || `${mode}_room_${roomsCache[mode]?.currentRoomId || 1}`;

  if (!roomsCache[mode]) roomsCache[mode] = { currentRoomId: 1, activeRooms: {} };
  if (!roomsCache[mode].activeRooms) roomsCache[mode].activeRooms = {};
  if (!roomsCache[mode].activeRooms[activeRoomKey]) {
    roomsCache[mode].activeRooms[activeRoomKey] = [];
  }

  let currentRoomPlayers = roomsCache[mode].activeRooms[activeRoomKey];

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
      username: usersCache[userId].username, 
      diff: cleanDiff,
      hasFinished: attemptNumber >= 2
    });
  }

  saveData(DB_FILE, usersCache);
  saveData(ROOMS_FILE, roomsCache);

  await checkAndFinalizeRoom(mode, activeRoomKey);

  res.json({ 
    success: true, 
    points: usersCache[userId].points,
    roomId: activeRoomKey,
    roomPlayers: currentRoomPlayers
  });
});

async function checkAndFinalizeRoom(mode, roomId) {
  if (!roomsCache[mode]?.activeRooms?.[roomId]) return;

  let currentRoomPlayers = roomsCache[mode].activeRooms[roomId];
  const targetPlayers = mode === 'duel' ? 2 : 10;

  const isCapacityFull = currentRoomPlayers.length >= targetPlayers;
  const allPlayersFinished = currentRoomPlayers.every(p => p.hasFinished === true);

  if (isCapacityFull && allPlayersFinished) {
    currentRoomPlayers.sort((a, b) => a.diff - b.diff);

    if (mode === 'duel') {
      const winner = currentRoomPlayers[0];
      const loser = currentRoomPlayers[1];

      if (winner && usersCache[winner.userId]) {
        usersCache[winner.userId].points = (usersCache[winner.userId].points || 0) + 2;
        try {
          await bot.api.sendMessage(winner.userId, `⚔️ **VICTORY!**\nYou won the duel with a difference of \`${winner.diff}s\` vs \`${loser ? loser.diff : '-'}s\`!\nBonus: **+2 Points** 🪙!`);
        } catch (e) {}
      }

      if (loser && usersCache[loser.userId]) {
        try {
          await bot.api.sendMessage(loser.userId, `⚔️ **DEFEAT!**\nYou lost the duel with \`${loser.diff}s\` vs \`${winner ? winner.diff : '-'}s\`. Better luck next time!`);
        } catch (e) {}
      }

    } else {
      const winner1 = currentRoomPlayers[0];
      const winner2 = currentRoomPlayers[1];
      const winner3 = currentRoomPlayers[2];

      if (winner1 && usersCache[winner1.userId]) {
        usersCache[winner1.userId].points = (usersCache[winner1.userId].points || 0) + 5;
        try { await bot.api.sendMessage(winner1.userId, `🥇 **1st Place!** in (${mode.toUpperCase()}) room! Bonus: **+5 Points** 🪙!`); } catch (e) {}
      }
      if (winner2 && usersCache[winner2.userId]) {
        usersCache[winner2.userId].points = (usersCache[winner2.userId].points || 0) + 3;
        try { await bot.api.sendMessage(winner2.userId, `🥈 **2nd Place!** in (${mode.toUpperCase()}) room! Bonus: **+3 Points** 🪙!`); } catch (e) {}
      }
      if (winner3 && usersCache[winner3.userId]) {
        usersCache[winner3.userId].points = (usersCache[winner3.userId].points || 0) + 1;
        try { await bot.api.sendMessage(winner3.userId, `🥉 **3rd Place!** in (${mode.toUpperCase()}) room! Bonus: **+1 Point** 🪙!`); } catch (e) {}
      }
    }

    delete roomsCache[mode].activeRooms[roomId];
    roomsCache[mode].currentRoomId = (roomsCache[mode].currentRoomId || 1) + 1;

    saveData(DB_FILE, usersCache);
    saveData(ROOMS_FILE, roomsCache);
  }
}

// ==========================================
// 🤖 TELEGRAM BOT COMMANDS & HANDLERS
// ==========================================

bot.command("start", async (ctx) => {
  const userId = ctx.from.id;
  const args = ctx.match;
  const lang = getLang(ctx);

  let isNewUser = !usersCache[userId];
  ensureUserExists(usersCache, userId, ctx.from.username || ctx.from.first_name);

  if (isNewUser && args && args !== String(userId)) {
    const referrerId = args;
    ensureUserExists(usersCache, referrerId, `Player_${referrerId}`);

    usersCache[referrerId].points = (usersCache[referrerId].points || 0) + 1;
    usersCache[referrerId].referralsCount = (usersCache[referrerId].referralsCount || 0) + 1;

    try {
      await ctx.api.sendMessage(
        referrerId,
        `🎉 **New Referral Bonus!**\nA friend joined using your link! You earned **+1 Free Point** 🪙\nTotal: **${usersCache[referrerId].points} Points**.`
      );
    } catch (e) {}
  }

  saveData(DB_FILE, usersCache);

  const currentUser = usersCache[userId];
  const inviteLink = `https://t.me/${ctx.me.username}?start=${userId}`;

  let welcomeText = "";
  let keyboard = new InlineKeyboard();

  if (lang === "fr") {
    welcomeText = isNewUser
      ? `🎯 **BIENVENUE SUR STOPLOCK CHALLENGE!** 🎯\n\n` +
        `Testez votre vitesse et votre précision contre la montre! ⏱️🔥\n\n` +
        `🎁 **BONUS DE BIENVENUE:**\n` +
        `Vous avez reçu **2 POINTS GRATUITS** pour commencer! 🪙\n\n` +
        `📊 **VOTRE PROFIL:**\n` +
        `• 🪙 **Points:** \`${currentUser.points.toFixed(1)}\`\n` +
        `• 🏆 **Meilleur Record:** \`Aucun record\`\n\n` +
        `👇 Appuyez sur **Jouer à StopLock** ci-dessous pour commencer!`
      : `⚡ **BONRETOUR, CHAMPION!** ⚡\n\n` +
        `Prêt à établir un nouveau record mondial? 🚀\n\n` +
        `📊 **VOTRE PROFIL:**\n` +
        `• 🪙 **Points:** \`${currentUser.points.toFixed(1)}\`\n` +
        `• 🏆 **Meilleur Record:** \`${currentUser.bestDiff !== null ? currentUser.bestDiff + 's' : 'Aucun record'}\`\n\n` +
        `👇 Appuyez sur **Jouer à StopLock** ci-dessous pour jouer!`;

    keyboard
      .webApp("🟢 Jouer à StopLock Trend", MINI_APP_URL)
      .row()
      .url("👥 Inviter des amis (+1 Pt)", `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent("Rejoins StopLock Challenge et teste ta précision pour battre les meilleurs records! ⏱️🔥")}`)
      .row()
      .text("🏆 Classement", "show_leaderboard")
      .text("📜 Règles & FAQ", "show_rules");

  } else {
    welcomeText = isNewUser
      ? `🎯 **WELCOME TO STOPLOCK CHALLENGE!** 🎯\n\n` +
        `Test your speed and precision against the clock! ⏱️🔥\n\n` +
        `🎁 **WELCOME BONUS:**\n` +
        `You received **2 FREE POINTS** to start! 🪙\n\n` +
        `📊 **YOUR PROFILE:**\n` +
        `• 🪙 **Points:** \`${currentUser.points.toFixed(1)}\`\n` +
        `• 🏆 **Best Record:** \`No records yet\`\n\n` +
        `👇 Tap **Play StopLock Trend** below to begin!`
      : `⚡ **WELCOME BACK, CHAMPION!** ⚡\n\n` +
        `Ready to set a new global record? 🚀\n\n` +
        `📊 **YOUR PROFILE:**\n` +
        `• 🪙 **Points:** \`${currentUser.points.toFixed(1)}\`\n` +
        `• 🏆 **Best Record:** \`${currentUser.bestDiff !== null ? currentUser.bestDiff + 's' : 'No records yet'}\`\n\n` +
        `👇 Tap **Play StopLock Trend** below to play!`;

    keyboard
      .webApp("🟢 Play StopLock Trend", MINI_APP_URL)
      .row()
      .url("👥 Invite Friends (+1 Point)", `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent("Join StopLock Challenge and test your precision to set top scores! ⏱️🔥")}`)
      .row()
      .text("🏆 Leaderboard", "show_leaderboard")
      .text("📜 Rules & FAQ", "show_rules");
  }

  await ctx.reply(welcomeText, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
});

bot.callbackQuery("show_leaderboard", async (ctx) => {
  const lang = getLang(ctx);
  const sorted = Object.values(usersCache)
    .filter(u => u && u.bestDiff !== null)
    .sort((a, b) => a.bestDiff - b.bestDiff)
    .slice(0, 10);

  if (sorted.length === 0) {
    const emptyMsg = lang === "fr" ? "🏆 Aucun record pour le moment!" : "🏆 No leaderboard records yet!";
    return ctx.answerCallbackQuery({ text: emptyMsg, show_alert: true });
  }

  let leaderText = lang === "fr" ? "🏆 **Classement Mondial Top 10:**\n\n" : "🏆 **Global Leaderboard Top 10:**\n\n";
  sorted.forEach((u, idx) => {
    leaderText += `${idx + 1}. **${u.username}** — \`${u.bestDiff}s\`\n`;
  });

  await ctx.reply(leaderText, { parse_mode: "Markdown" });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("show_rules", async (ctx) => {
  const lang = getLang(ctx);
  let rulesText = "";

  if (lang === "fr") {
    rulesText = `📜 **RÈGLES ET FAQ STOPLOCK:**\n\n` +
      `1️⃣ **Points & Bonus:** Obtenez 2 points gratuits à l'inscription, +0.5 lors de la réclamation quotidienne, et +1 point pour chaque ami invité.\n\n` +
      `2️⃣ **Politique d'essais:** Vous obtenez **Maximum 2 Essais** par match. Seul votre MEILLEUR score dans la salle est conservé!\n\n` +
      `3️⃣ **Modes de Jeu:**\n` +
      `• 🎯 **Practice Arena:** Entraînement libre et illimité.\n` +
      `• ⚔️ **Head-to-Head Duel:** Match à 2 joueurs (+2 Points).\n` +
      `• ⏱️ **Classic Precision:** Chronomètre visible.\n` +
      `• 👁️‍🗨️ **Blind Sense:** Le chronomètre se masque au hasard.\n` +
      `• ❄️ **Frost Glitch:** Gels de système dynamiques.\n` +
      `• 💎 **Quantum Chaos:** Lags et ralentissements de vitesse.`;
  } else {
    rulesText = `📜 **STOPLOCK RULES & FAQ:**\n\n` +
      `1️⃣ **Points & Bonus:** Get 2 free points on join, +0.5 daily claim, and +1 point for each friend invited.\n\n` +
      `2️⃣ **Attempts Policy:** You get **Max 2 Tries** per room match using Points. Your BEST score in the room is saved!\n\n` +
      `3️⃣ **Game Modes:**\n` +
      `• 🎯 **Practice Arena:** Unlimited free warm-up.\n` +
      `• ⚔️ **Head-to-Head Duel:** 2-Player Match (+2 Points Bonus).\n` +
      `• ⏱️ **Classic Precision:** Pure visible timer.\n` +
      `• 👁️‍🗨️ **Blind Sense:** Timer hides randomly.\n` +
      `• ❄️ **Frost Glitch:** Dynamic system freezes.\n` +
      `• 💎 **Quantum Chaos:** Speed Lags + Glitches.`;
  }

  await ctx.reply(rulesText, { parse_mode: "Markdown" });
  await ctx.answerCallbackQuery();
});

// Start Express Server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌐 API Server running on port ${PORT}`));

// Start Bot Engine (Long Polling)
bot.start({
  drop_pending_updates: true
});
console.log("🚀 StopLock Free Edition Backend is active and running...");