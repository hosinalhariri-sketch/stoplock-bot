const { Bot, InlineKeyboard } = require("grammy");
const fs = require("fs");
const express = require("express");
const cors = require("cors");

// 🔑 Telegram Bot Token & WebApp URL
const BOT_TOKEN = "8897585537:AAG08N6a05gtkhHgs6GD-UMnpoExZaSd1sQ"; 
const MINI_APP_URL = "https://stop-lock-challenge.vercel.app/";

const bot = new Bot(BOT_TOKEN);
const app = express();
app.use(express.json());
app.use(cors());

const DB_FILE = "./users.json";
const ROOMS_FILE = "./rooms.json";

// 💰 الجوائز المالية لكل جدول عند اكتمال الغرفة (20 لاعباً)
const PRIZES = {
  bronze: { total: 1.00, p1: 0.60, p2: 0.25, p3: 0.15 },
  silver: { total: 3.00, p1: 1.80, p2: 0.80, p3: 0.40 },
  gold:   { total: 10.00, p1: 6.00, p2: 2.50, p3: 1.50 },
  chaos:  { total: 25.00, p1: 15.00, p2: 6.50, p3: 3.50 }
};

// Helper functions for Database
function loadData(file) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({}));
  try { return JSON.parse(fs.readFileSync(file)); } catch (e) { return {}; }
}

function saveData(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Ensure user object has all proper fields
function ensureUserExists(users, userId, name) {
  if (!users[userId]) {
    users[userId] = {
      id: userId,
      username: name || `Player_${userId}`,
      points: 2.0, // 🎁 2 Welcoming Free Points
      balanceUSD: 0.00, // 💵 Cash Balance
      bestDiff: null,
      lastClaimDate: null,
      referralsCount: 0,
      createdAt: new Date().toISOString()
    };
  } else {
    if (users[userId].balanceUSD === undefined) users[userId].balanceUSD = 0.00;
  }
}

// ==========================================
// 🌐 API ENDPOINTS (FOR MINI APP CONNECTION)
// ==========================================

// 🔄 1. جلب بيانات المستخدم المحدثة عند فتح اللعبة
app.get("/api/user-data/:userId", (req, res) => {
  const users = loadData(DB_FILE);
  const u = users[req.params.userId];
  if (!u) return res.status(404).json({ error: "User not found" });
  res.json({ points: u.points, balanceUSD: u.balanceUSD });
});

// 🎁 2. المطالبة بالمكافأة اليومية (0.5 نقطة) وحفظها دائماً
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

// 🏆 3. إرسال نتيجة المحاولة واحتساب أرباح الغرف (20 لاعباً)
app.post("/api/submit-score", async (req, res) => {
  const { userId, mode, diff } = req.body;
  if (!userId || !mode || diff === undefined) return res.status(400).json({ error: "Invalid data" });

  const users = loadData(DB_FILE);
  const rooms = loadData(ROOMS_FILE);

  ensureUserExists(users, userId);

  // تحديث أفضل رقم شخصي
  if (users[userId].bestDiff === null || diff < users[userId].bestDiff) {
    users[userId].bestDiff = diff;
  }

  // إضافة النتيجة للغرفة الحالية
  if (!rooms[mode]) rooms[mode] = { currentRoomId: 1, players: [] };
  let currentRoom = rooms[mode];
  currentRoom.players.push({ userId, username: users[userId].username, diff });

  // عند اكتمال الغرفة بـ 20 لاعباً -> توزيع الأرباح
  if (currentRoom.players.length >= 20) {
    currentRoom.players.sort((a, b) => a.diff - b.diff);

    const winner1 = currentRoom.players[0];
    const winner2 = currentRoom.players[1];
    const winner3 = currentRoom.players[2];
    const prize = PRIZES[mode] || PRIZES.bronze;

    users[winner1.userId].balanceUSD = (users[winner1.userId].balanceUSD || 0) + prize.p1;
    users[winner2.userId].balanceUSD = (users[winner2.userId].balanceUSD || 0) + prize.p2;
    users[winner3.userId].balanceUSD = (users[winner3.userId].balanceUSD || 0) + prize.p3;

    try {
      await bot.api.sendMessage(winner1.userId, `🥇 **مبروك!** حققت المركز الأول في جدول (${mode.toUpperCase()}) وحصلت على **$${prize.p1} USD** 💵!`);
      await bot.api.sendMessage(winner2.userId, `🥈 **مبروك!** حققت المركز الثاني في جدول (${mode.toUpperCase()}) وحصلت على **$${prize.p2} USD** 💵!`);
      await bot.api.sendMessage(winner3.userId, `🥉 **مبروك!** حققت المركز الثالث في جدول (${mode.toUpperCase()}) وحصلت على **$${prize.p3} USD** 💵!`);
    } catch (e) {}

    // تفريغ الغرفة لبدء غرفة جديدة
    rooms[mode] = { currentRoomId: currentRoom.currentRoomId + 1, players: [] };
  }

  saveData(DB_FILE, users);
  saveData(ROOMS_FILE, rooms);

  res.json({ success: true, balanceUSD: users[userId].balanceUSD || 0, points: users[userId].points });
});

// ==========================================
// 🤖 TELEGRAM BOT COMMANDS & HANDLERS
// ==========================================

// 🎯 /start Command Handler
bot.command("start", async (ctx) => {
  const userId = ctx.from.id;
  const users = loadData(DB_FILE);
  const args = ctx.match; // Referrer ID if present

  let isNewUser = !users[userId];

  ensureUserExists(users, userId, ctx.from.username || ctx.from.first_name);

  // Handle Referral logic
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
    } catch (e) {
      console.log("Could not notify referrer:", e.message);
    }
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
      `• 💵 **Cash Balance:** \`$${currentUser.balanceUSD.toFixed(2)} USD\`\n` +
      `• 🏆 **Best Record:** \`No records yet\`\n\n` +
      `📌 *Minimum Withdrawal Threshold:* **$7.00 USD**\n\n` +
      `👇 Tap **Play StopLock Trend** below to begin!`
    : `⚡ **WELCOME BACK, CHAMPION!** ⚡\n\n` +
      `Ready to set a new record and claim top cash prizes? 🚀\n\n` +
      `📊 **YOUR PROFILE:**\n` +
      `• 🪙 **Points:** \`${currentUser.points.toFixed(1)}\`\n` +
      `• 💵 **Cash Balance:** \`$${currentUser.balanceUSD.toFixed(2)} USD\`\n` +
      `• 🏆 **Best Record:** \`${currentUser.bestDiff !== null ? currentUser.bestDiff + 's' : 'No records yet'}\`\n\n` +
      `📌 *Minimum Withdrawal Threshold:* **$7.00 USD**\n\n` +
      `👇 Tap **Play StopLock Trend** below to play!`;

  const keyboard = new InlineKeyboard()
    .webApp("🟢 Play StopLock Trend", MINI_APP_URL)
    .row()
    .url("👥 Invite Friends (+1 Point)", `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent("Join StopLock Challenge and test your precision to win real rewards! ⏱️🔥")}`)
    .row()
    .text("🏆 Leaderboard", "show_leaderboard")
    .text("📜 Rules & FAQ", "show_rules")
    .row()
    .text("💳 Withdraw ($7.00 Min)", "request_payout");

  await ctx.reply(welcomeText, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
});

// 🏆 Leaderboard Callback
bot.callbackQuery("show_leaderboard", async (ctx) => {
  const users = loadData(DB_FILE);
  const sorted = Object.values(users)
    .filter(u => u.bestDiff !== null)
    .sort((a, b) => a.bestDiff - b.bestDiff)
    .slice(0, 10);

  if (sorted.length === 0) {
    return ctx.answerCallbackQuery({ text: "🏆 No leaderboard records yet!", show_alert: true });
  }

  let leaderText = "🏆 **Global Leaderboard Top 10:**\n\n";
  sorted.forEach((u, idx) => {
    leaderText += `${idx + 1}. **${u.username}** — \`${u.bestDiff}s\`\n`;
  });

  await ctx.reply(leaderText, { parse_mode: "Markdown" });
  await ctx.answerCallbackQuery();
});

// 📜 Rules & FAQ Callback
bot.callbackQuery("show_rules", async (ctx) => {
  const rulesText = `📜 **STOPLOCK RULES & FAQ:**\n\n` +
    `1️⃣ **Points & Free Tries:** Get 2 free points on join, +0.5 daily bonus claim, and +1 point for each friend invited.\n\n` +
    `2️⃣ **Game Modes:**\n` +
    `• 🥉 **Bronze:** Classic visible timer.\n` +
    `• 🥈 **Silver:** Blind Mode (hides after 1s).\n` +
    `• ❄️ **Gold:** Hidden timer + 2 Scheduled Freezes.\n` +
    `• 💎 **Mega Chaos:** Visible timer + Random Lag/Jumps.\n\n` +
    `3️⃣ **Room Matches:** Each room holds 20 real players. Top 3 precision scores split the cash prize pool!\n\n` +
    `4️⃣ **Payouts & Withdrawals:** Minimum payout threshold is **$7.00 USD**. Requests are processed manually via Binance Pay / USDT / Vodafone Cash / PayPal.`;
  
  await ctx.reply(rulesText, { parse_mode: "Markdown" });
  await ctx.answerCallbackQuery();
});

// 💳 Payout Request Callback
bot.callbackQuery("request_payout", async (ctx) => {
  const users = loadData(DB_FILE);
  const u = users[ctx.from.id];

  if (!u || u.balanceUSD < 7.00) {
    return ctx.answerCallbackQuery({ 
      text: `❌ Insufficient balance! Minimum payout threshold is $7.00 USD. Your balance: $${u ? u.balanceUSD.toFixed(2) : '0.00'} USD.`, 
      show_alert: true 
    });
  }

  await ctx.reply(
    `💵 **PAYOUT REQUEST ELIGIBLE!**\n\n` +
    `Your Cash Balance: **$${u.balanceUSD.toFixed(2)} USD**\n\n` +
    `Please reply to this message with your payment details:\n` +
    `• Binance Pay ID\n` +
    `• USDT Address (TRC20/BEP20)\n` +
    `• Vodafone Cash / Local Wallet Number\n\n` +
    `An admin will review and complete your transfer shortly! 🚀`
  );
  await ctx.answerCallbackQuery();
});

// Start Express Server for Mini App API Communication
app.listen(3000, () => console.log("🌐 API Server running on port 3000"));

// Start Bot Engine
bot.start();
console.log("🚀 StopLock English Bot Backend is active and running...");