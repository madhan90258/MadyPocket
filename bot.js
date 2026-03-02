const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const express = require("express");

// ================= SERVER (Required for Render) =================
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.send("MadyPocket Bot is running 🚀");
});

app.listen(PORT, () => {
    console.log("Server running on port", PORT);
});

// ================= TELEGRAM BOT SETUP =================
const token = process.env.BOT_TOKEN;

if (!token) {
    console.error("❌ BOT_TOKEN not provided!");
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

bot.on("polling_error", (error) => {
    console.error("Polling error:", error);
});

// ================= DATABASE =================
const db = new sqlite3.Database('./expenses.db');
let userStates = {};

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        chat_id INTEGER PRIMARY KEY,
        wallet_balance REAL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER,
        date TEXT,
        type TEXT,
        category TEXT,
        amount REAL
    )`);
});

// ================= MENU =================
function mainMenu(chatId) {
    bot.sendMessage(chatId, "Choose an option:", {
        reply_markup: {
            keyboard: [
                ["💸 Spend", "💰 Credit"],
                ["📊 Balance", "📈 Weekly Report"]
            ],
            resize_keyboard: true
        }
    });
}

// ================= START =================
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;

    db.get(`SELECT * FROM users WHERE chat_id = ?`, [chatId], (err, row) => {
        if (!row) {
            bot.sendMessage(chatId, "Welcome to MadyPocket 💼\n\nEnter your initial wallet amount:");
        } else {
            mainMenu(chatId);
        }
    });
});

// ================= MESSAGE HANDLER =================
bot.on("message", (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) return;

    db.get(`SELECT * FROM users WHERE chat_id = ?`, [chatId], (err, row) => {

        // ===== INITIAL WALLET SETUP =====
        if (!row && !isNaN(text)) {
            db.run(`INSERT INTO users (chat_id, wallet_balance) VALUES (?, ?)`,
                [chatId, parseFloat(text)]);
            bot.sendMessage(chatId, `✅ Wallet initialized with ₹${text}`);
            mainMenu(chatId);
            return;
        }

        // ===== BUTTON HANDLING =====
        if (text === "💸 Spend") {
            if (!row) {
                bot.sendMessage(chatId, "⚠ Please set your wallet first using /start");
                return;
            }
            userStates[chatId] = "awaiting_spend";
            bot.sendMessage(chatId, "Enter spend details:\nExample: food 200");
            return;
        }

        if (text === "💰 Credit") {
            if (!row) {
                bot.sendMessage(chatId, "⚠ Please set your wallet first using /start");
                return;
            }
            userStates[chatId] = "awaiting_credit";
            bot.sendMessage(chatId, "Enter credit details:\nExample: salary 5000");
            return;
        }

        // ===== SPEND INPUT =====
        if (userStates[chatId] === "awaiting_spend") {

            const parts = text.split(" ");

            if (parts.length < 2 || isNaN(parts[1])) {
                bot.sendMessage(chatId, "❌ Invalid format.\nExample: food 200");
                return;
            }

            const category = parts[0];
            const amt = parseFloat(parts[1]);

            const newBalance = row.wallet_balance - amt;

            db.run(`UPDATE users SET wallet_balance = ? WHERE chat_id = ?`,
                [newBalance, chatId]);

            db.run(`INSERT INTO transactions (chat_id, date, type, category, amount)
                    VALUES (?, ?, ?, ?, ?)`,
                [chatId, new Date().toISOString(), "spend", category, amt]);

            bot.sendMessage(chatId,
                `✅ Spend Logged\nCategory: ${category}\nAmount: ₹${amt}\n💰 Balance: ₹${newBalance}`);

            userStates[chatId] = null;
            mainMenu(chatId);
            return;
        }

        // ===== CREDIT INPUT =====
        if (userStates[chatId] === "awaiting_credit") {

            const parts = text.split(" ");

            if (parts.length < 2 || isNaN(parts[1])) {
                bot.sendMessage(chatId, "❌ Invalid format.\nExample: salary 5000");
                return;
            }

            const category = parts[0];
            const amt = parseFloat(parts[1]);

            const newBalance = row.wallet_balance + amt;

            db.run(`UPDATE users SET wallet_balance = ? WHERE chat_id = ?`,
                [newBalance, chatId]);

            db.run(`INSERT INTO transactions (chat_id, date, type, category, amount)
                    VALUES (?, ?, ?, ?, ?)`,
                [chatId, new Date().toISOString(), "credit", category, amt]);

            bot.sendMessage(chatId,
                `✅ Credit Logged\nCategory: ${category}\nAmount: ₹${amt}\n💰 Balance: ₹${newBalance}`);

            userStates[chatId] = null;
            mainMenu(chatId);
            return;
        }

        // ===== BALANCE =====
        if (text === "📊 Balance") {

            if (!row) {
                bot.sendMessage(chatId, "⚠ Please set your wallet first using /start");
                return;
            }

            bot.sendMessage(chatId, `💰 Current Balance: ₹${row.wallet_balance}`);
            mainMenu(chatId);
            return;
        }

        // ===== WEEKLY REPORT =====
        if (text === "📈 Weekly Report") {

            if (!row) {
                bot.sendMessage(chatId, "⚠ Please set your wallet first using /start");
                return;
            }

            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

            db.all(`SELECT category, SUM(amount) as total
                    FROM transactions
                    WHERE chat_id = ?
                    AND date >= ?
                    GROUP BY category`,
                [chatId, sevenDaysAgo.toISOString()],
                (err, rows) => {

                    if (!rows || rows.length === 0) {
                        bot.sendMessage(chatId, "No transactions this week.");
                        mainMenu(chatId);
                        return;
                    }

                    let report = "📊 Weekly Summary (Last 7 Days):\n\n";
                    rows.forEach(row => {
                        report += `${row.category}: ₹${row.total}\n`;
                    });

                    bot.sendMessage(chatId, report);
                    mainMenu(chatId);
                });
        }

    });
});

// ================= DAILY REMINDER =================
cron.schedule("0 20 * * *", () => {
    db.all(`SELECT chat_id FROM users`, [], (err, users) => {
        if (!users) return;

        users.forEach(user => {
            bot.sendMessage(user.chat_id,
                "⏰ Reminder: Don't forget to update today's expenses!");
        });
    });
});