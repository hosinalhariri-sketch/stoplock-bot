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

// 💰 الجوائز المالية لكل جدول
const PRIZES = {
  duel:   { total: 0.10, p1: 0.10, p2: 0.00, p3: 0.00 },
  bronze: { total: 0.50, p1: 0.25, p2: 0.15, p3: 0.10 },
  silver: { total: 1.50, p1: 0.80, p2: 0.45, p3: 0.25 },
  gold:   { total: 5.00, p1: 2.50, p2: 1.50, p3: 1.00 },
  chaos:  { total: 12.50, p1: 6.50, p2: 3.50, p3: 2.50 }
};

// Helper functions for Database
function loadData(file) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({}));
  try { return JSON.parse(fs.readFileSync(file)); } catch (e) { return {}; }
}

function saveData(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function ensureUserExists(users, userId, name) {
  if (!users[userId]) {
    users[userId] = {
      id: userId,
      username: name || `Player_${userId}`,
      points: 2.0,
      balanceUSD: 0.00,
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

// 🟢 0. مسار فحص الاستجابة الرئيسي
app.get("/", (req, res) => {
  res.status(200).send("🚀 StopLock Server is Live and Active!");
});

// 🔄 1. جلب بيانات المستخدم المحدثة
app.get("/api/user-data/:userId", (req, res) => {
  const users = loadData(DB_FILE);
  const u = users[req.params.userId];
  if (!u) return res.status(404).json({ error: "User not found" });
  res.json({ points: u.points, balanceUSD: u.balanceUSD });
});

// 🎁 2. المطالبة بالمكافأة اليومية (+0.5 نقطة)
app.post("/api/claim-daily", (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  const users = loadData(DB_FILE);
  ensureUserExists(users, userId);

  const today = new Date().toDateString();
  if (users[userId].lastClaimDate === today) {
    return res.status(400).json({ error: "Already claimed today", points: users[userId].points });
  }

  users[userId].points = (users[userId].points || 0) + 1000;
  users[userId].lastClaimDate = today;
  saveData(DB_FILE, users);

  res.json({ success: true, points: users[userId].points });
});

// ⭐ 3. مسار إنشاء فاتورة الدفع بـ Telegram Stars
app.post("/api/create-stars-invoice", async (req, res) => {
  const { userId, mode, starsCount } = req.body;
  if (!userId || !starsCount) return res.status(400).json({ error: "Missing data" });

  try {
    const invoiceLink = await bot.api.createInvoiceLink(
      `StopLock - ${mode.toUpperCase()} Entry`,
      `Entry fee for ${mode.toUpperCase()} tournament room`,
      JSON.stringify({ userId, mode }),
      "", // متطلب فارغ لنجوم تلجرام
      "XTR", // رمز عملة Telegram Stars
      [{ label: `${starsCount} Stars Entry`, amount: starsCount }]
    );

    res.json({ success: true, invoiceLink });
  } catch (e) {
    console.error("Invoice Error:", e);
    res.status(500).json({ error: "Failed to generate invoice" });
  }
});

// 🔍 4. مسار جلب حالة الغرفة واللاعبين
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

// 🏆 5. إرسال نتيجة المحاولة وتوزيع الجوائز
app.post("/api/submit-score", async (req, res) => {
  const { userId, mode, diff, cost, roomId } = req.body;
  if (!userId || !mode || diff === undefined) return res.status(400).json({ error: "Invalid data" });

  const users = loadData(DB_FILE);
  const rooms = loadData(ROOMS_FILE);

  ensureUserExists(users, userId);

  if (cost && cost > 0) {
    users[userId].points = Math.max(0, (users[userId].points || 0) - cost);
  }

  const cleanDiff = parseFloat(Number(diff).toFixed(3));

  if (users[userId].bestDiff === null || cleanDiff < users[userId].bestDiff) {
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
  } else {
    currentRoomPlayers.push({ 
      userId: String(userId), 
      username: users[userId].username, 
      diff: cleanDiff 
    });
  }

  const targetPlayers = mode === 'duel' ? 2 : 10;

  // 🏁 عند اكتمال الغرفة
  if (currentRoomPlayers.length >= targetPlayers) {
    currentRoomPlayers.sort((a, b) => a.diff - b.diff);

    const prize = PRIZES[mode] || PRIZES.bronze;

    if (mode === 'duel') {
      const winner = currentRoomPlayers[0];
      const loser = currentRoomPlayers[1];

      users[winner.userId].balanceUSD = (users[winner.userId].balanceUSD || 0) + prize.p1;

      try {
        await bot.api.sendMessage(winner.userId, `⚔️ **مبروك الفوز!**\nلقد انتصرت في المواجهة بفارق \`${winner.diff}s\` مقابل \`${loser.diff}s\` لمنافسك!\nوحصلت على **$${prize.p1} USD** 💵!`);
      } catch (e) {}

      try {
        await bot.api.sendMessage(loser.userId, `⚔️ **هاردلك!**\nلقد خسرت المواجهة بفارق \`${loser.diff}s\` مقابل \`${winner.diff}s\` لمنافسك.`);
      } catch (e) {}

    } else {
      const winner1 = currentRoomPlayers[0];
      const winner2 = currentRoomPlayers[1];
      const winner3 = currentRoomPlayers[2];

      users[winner1.userId].balanceUSD = (users[winner1.userId].balanceUSD || 0) + prize.p1;
      users[winner2.userId].balanceUSD = (users[winner2.userId].balanceUSD || 0) + prize.p2;
      users[winner3.userId].balanceUSD = (users[winner3.userId].balanceUSD || 0) + prize.p3;

      try {
        await bot.api.sendMessage(winner1.userId, `🥇 **المركز الأول!** في جدول (${mode.toUpperCase()})! حصلت على **$${prize.p1} USD** 💵!`);
        await bot.api.sendMessage(winner2.userId, `🥈 **المركز الثاني!** في جدول (${mode.toUpperCase()})! حصلت على **$${prize.p2} USD** 💵!`);
        await bot.api.sendMessage(winner3.userId, `🥉 **المركز الثالث!** في جدول (${mode.toUpperCase()})! حصلت على **$${prize.p3} USD** 💵!`);
      } catch (e) {}
    }

    delete rooms[mode].activeRooms[activeRoomKey];
    rooms[mode].currentRoomId = (rooms[mode].currentRoomId || 1) + 1;
  }

  saveData(DB_FILE, users);
  saveData(ROOMS_FILE, rooms);

  res.json({ 
    success: true, 
    balanceUSD: users[userId].balanceUSD || 0, 
    points: users[userId].points,
    roomId: activeRoomKey,
    roomPlayers: currentRoomPlayers
  });
});

// ==========================================
// 🤖 TELEGRAM BOT COMMANDS & HANDLERS
// ==========================================

// ⭐ معالجة دفع النجوم عبر تلجرام (Pre-checkout query)
bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true));

// ⭐ معالجة عملية الدفع الناجحة بالنجوم
bot.on("message:successful_payment", async (ctx) => {
  try {
    await ctx.reply("🌟 **تم تأكيد عملية الدفع بالنجوم بنجاح!**\nبالتوفيق في المنافسة! 🚀");
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
      `• 💵 **Cash Balance:** \`$${currentUser.balanceUSD.toFixed(2)} USD\`\n` +
      `• 🏆 **Best Record:** \`No records yet\`\n\n` +
      `📌 *Minimum Withdrawal Threshold:* **$10.00 USD**\n\n` +
      `👇 Tap **Play StopLock Trend** below to begin!`
    : `⚡ **WELCOME BACK, CHAMPION!** ⚡\n\n` +
      `Ready to set a new record and claim top cash prizes? 🚀\n\n` +
      `📊 **YOUR PROFILE:**\n` +
      `• 🪙 **Points:** \`${currentUser.points.toFixed(1)}\`\n` +
      `• 💵 **Cash Balance:** \`$${currentUser.balanceUSD.toFixed(2)} USD\`\n` +
      `• 🏆 **Best Record:** \`${currentUser.bestDiff !== null ? currentUser.bestDiff + 's' : 'No records yet'}\`\n\n` +
      `📌 *Minimum Withdrawal Threshold:* **$10.00 USD**\n\n` +
      `👇 Tap **Play StopLock Trend** below to play!`;

  const keyboard = new InlineKeyboard()
    .webApp("🟢 Play StopLock Trend", MINI_APP_URL)
    .row()
    .url("👥 Invite Friends (+1 Point)", `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent("Join StopLock Challenge and test your precision to win real rewards! ⏱️🔥")}`)
    .row()
    .text("🏆 Leaderboard", "show_leaderboard")
    .text("📜 Rules & FAQ", "show_rules")
    .row()
    .text("💳 Withdraw ($10.00 Min)", "request_payout");

  await ctx.reply(welcomeText, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
});

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

bot.callbackQuery("show_rules", async (ctx) => {
  const rulesText = `📜 **STOPLOCK RULES & FAQ:**\n\n` +
    `1️⃣ **Points & Bonus:** Get 2 free points on join, +0.5 daily claim, watch optional ads for **+1 Free Point** 🪙 (Up to 5 ads/day), and +1 point for each friend invited.\n\n` +
    `2️⃣ **Attempts Policy:** You get **Max 2 Tries** per room match using Points or Stars. Your BEST score in the room is saved!\n\n` +
    `3️⃣ **Game Modes:**\n` +
    `• 🎯 **Practice Arena:** Unlimited free warm-up.\n` +
    `• ⚔️ **Head-to-Head Duel:** 2-Player Match ($0.10 Prize).\n` +
    `• ⏱️ **Classic Precision:** Pure visible timer ($0.50 Prize).\n` +
    `• 👁️‍🗨️ **Blind Sense:** Timer hides randomly ($1.50 Prize).\n` +
    `• ❄️ **Frost Glitch:** Dynamic system freezes ($5.00 Prize).\n` +
    `• 💎 **Quantum Chaos:** Speed Lags + Glitches ($12.50 Prize).\n\n` +
    `4️⃣ **Payouts & Withdrawals:** Minimum payout threshold is **$10.00 USD**. Requests are processed manually via Binance Pay / USDT / Local Wallets.`;
  
  await ctx.reply(rulesText, { parse_mode: "Markdown" });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("request_payout", async (ctx) => {
  const users = loadData(DB_FILE);
  const u = users[ctx.from.id];

  if (!u || u.balanceUSD < 10.00) {
    return ctx.answerCallbackQuery({ 
      text: `❌ Insufficient balance! Minimum payout threshold is $10.00 USD. Your balance: $${u ? u.balanceUSD.toFixed(2) : '0.00'} USD.`, 
      show_alert: true 
    });
  }

  await ctx.reply(
    `💵 **PAYOUT REQUEST ELIGIBLE!**\n\n` +
    `Your Cash Balance: **$${u.balanceUSD.toFixed(2)} USD**\n\n` +
    `Please reply to this message with your payment details:\n` +
    `• Binance Pay ID\n` +
    `• USDT Address (TRC20/BEP20)\n` +
    `• Local Wallet Number\n\n` +
    `An admin will review and complete your transfer shortly! 🚀`
  );
  await ctx.answerCallbackQuery();
});

// Start Express Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 API Server running on port ${PORT}`));

// Start Bot Engine
bot.start();
console.log("🚀 StopLock Bot Backend is active and running...");