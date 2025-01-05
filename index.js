require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const {default: PQueue} = require("p-queue");

const app = express();
app.use(express.json());

/** ========== Environment Variables ========== */
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const DOWNLOAD_PATH = process.env.DOWNLOAD_PATH;
const BASE_URL = process.env.BOT_SERVER_BASEURL;
console.log("CONFIG:", {PORT, BOT_TOKEN, DOWNLOAD_PATH, BASE_URL});

/** ========== Retry & Backoff Settings ========== */
const MAX_RETRIES = 3; // maximum attempts
const BACKOFF_DELAYS = [60, 120, 240]; // seconds: 30s, 1min, 2min (exponential style)

/**
 * Helper to get wait time for next retry:
 * - If error is 429, we respect Telegram's retry_after.
 * - Otherwise, use exponential backoff from BACKOFF_DELAYS.
 */
function getWaitTime(is429, attempt, retryAfterFromTelegram = 30) {
    if (is429) {
        return retryAfterFromTelegram;
    }
    // For non-429 errors, fallback to an exponential pattern
    if (attempt <= BACKOFF_DELAYS.length) {
        return BACKOFF_DELAYS[attempt - 1] || 30;
    }
    // If attempt somehow exceeds known delays, fallback to 30s
    return 30;
}

function delayFn(timeout = 1000) {
    return new Promise((resolve) => setTimeout(resolve, timeout));
}

/** ========== Queue Setup ========== */
const queue = new PQueue({concurrency: 1});
let statusTimer = null;

const sendStatusUpdates = (reply) => {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(async () => {
        await reply(`Queue Info: size=${queue.size}, pending=${queue.pending}`);
    }, 10000);
};

queue.on("idle", () => {
    if (statusTimer) clearInterval(statusTimer);
});

/**
 * ========== Telegram API Helper ==========
 * Unified GET/POST with exponential backoff up to MAX_RETRIES.
 */
async function telegramApiRequest({
                                      endpoint,
                                      method = "POST",
                                      data = {},
                                      chatId,
                                      fallbackReply,
                                      attempt = 1,
                                  }) {
    const url = `${BASE_URL}/bot${BOT_TOKEN}/${endpoint}`;

    try {
        let resp;
        if (method === "GET") {
            resp = await axios.get(url, {params: data});
        } else {
            resp = await axios.post(url, data);
        }
        return resp.data;
    } catch (err) {
        const is429 = err?.response?.data?.error_code === 429;
        const retryAfterFromTelegram = err?.response?.data?.parameters?.retry_after || 30;

        // For any Telegram error, we handle up to MAX_RETRIES with either 429-based or exponential backoff
        if (attempt < MAX_RETRIES) {
            const waitTime = getWaitTime(is429, attempt, retryAfterFromTelegram);
            console.error(
                `Telegram Error. Attempt=${attempt}, will retry in ${waitTime} seconds.`
            );
            await fallbackReply(`Telegram Error. Waiting ${waitTime} seconds before retry...`);
            await delayFn(waitTime * 1000);

            return telegramApiRequest({
                endpoint,
                method,
                data,
                chatId,
                fallbackReply,
                attempt: attempt + 1,
            });
        }

        // If we reached here, we've hit max attempts
        console.error("Max retries reached. Aborting request.");
        throw err; // Let the caller handle the final error
    }
}

/** ========== Telegram Wrappers ========== */
async function sendMessage(chatId, text) {
    const responseData = await telegramApiRequest({
        endpoint: "sendMessage",
        method: "POST",
        data: {chat_id: chatId, text},
        chatId,
        fallbackReply: async (msg) => sendMessage(chatId, msg),
    });
    return responseData.result?.message_id;
}

async function editMessage(chatId, messageId, text) {
    await telegramApiRequest({
        endpoint: "editMessageText",
        method: "POST",
        data: {chat_id: chatId, message_id: messageId, text},
        chatId,
        fallbackReply: async (msg) => sendMessage(chatId, msg),
    });
}

/** ========== File Operations ========== */
function moveAndRenameFile(source, destination, callback) {
    fs.rename(source, destination, (err) => {
        if (err) {
            if (err.code === "EXDEV") {
                // cross-device fallback
                const readStream = fs.createReadStream(source);
                const writeStream = fs.createWriteStream(destination);
                readStream.on("error", callback);
                writeStream.on("error", callback);
                readStream.on("close", () => fs.unlink(source, callback));
                readStream.pipe(writeStream);
            } else {
                callback(err);
            }
        } else {
            callback(null);
        }
    });
}

/** ========== Progress Simulation ========== */
async function sendProgress(chatId, messageId, steps = 10, duration = 3000) {
    const interval = duration / steps;
    let lastPercentage = 0;

    for (let i = 1; i <= steps; i++) {
        await delayFn(interval);
        const percentage = i * (100 / steps);
        if (percentage !== lastPercentage) {
            const progressBar = `[${"▓".repeat(i)}${"░".repeat(steps - i)}] ${percentage}%`;
            await editMessage(chatId, messageId, `Progress: ${progressBar}`);
            lastPercentage = percentage;
        }
    }
}

/** ========== File Processing ========== */
async function processFile(sourcePath, targetPath, chatId, reply) {
    // 1. Send initial message
    const msgId = await reply("Starting file move...");

    // 2. Send a fake progress bar
    await sendProgress(chatId, msgId);

    // 3. Actually move the file
    return new Promise((resolve, reject) => {
        moveAndRenameFile(sourcePath, targetPath, async (err) => {
            if (err) {
                console.error("Error moving file:", err);
                await editMessage(chatId, msgId, `Error: ${err.message}`);
                return reject(err);
            }
            await editMessage(chatId, msgId, `File successfully moved to ${targetPath}`);
            resolve();
        });
    });
}

/** ========== Main Logic: processRequest ========== */
async function processRequest(fileId, message, reply) {
    const chatId = message.chat.id;
    try {
        const {file_name: originalFileName} = message.document;

        // 1) Retrieve file info from Telegram (GET) with backoff
        const fileInfoData = await telegramApiRequest({
            endpoint: "getFile",
            method: "GET",
            data: {file_id: fileId},
            chatId,
            fallbackReply: async (msg) => sendMessage(chatId, msg),
        });

        // 2) Resolve path from the file info
        const filePathOnServer = fileInfoData.result.file_path;
        const absoluteFilePathOnServer = path.join(filePathOnServer);

        const destinationPath = path.join(DOWNLOAD_PATH, originalFileName);

        console.log("File Info:", {
            originalFileName,
            fileId,
            filePathOnServer: absoluteFilePathOnServer,
            destinationPath,
        });

        // 3) Slow down if queue is heavily loaded
        if (queue.pending > 2) await delayFn(30000);

        // 4) Show user we are about to move file
        await reply(`${originalFileName}\nPreparing to move file...`);

        // 5) Process the file (move + progress)
        await processFile(absoluteFilePathOnServer, destinationPath, chatId, reply);

        // 6) Notify success
        await reply(`${originalFileName} has been moved to ${destinationPath}`);
    } catch (error) {
        console.error("processRequest Error:", error.response?.data || error.message);
        await reply(`Error: ${error.message} \nFILE: ${message.document.file_name}`);
    }
}

/** ========== Webhook Endpoint ========== */
app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
    console.log("Webhook received");
    res.send("success");

    const {message} = req.body;
    if (!message || !message.document) return;

    const chatId = message.chat.id;
    const reply = async (text) => sendMessage(chatId, text);

    await reply(`Request received for file: ${message.document.file_name}`);
    sendStatusUpdates(reply);

    // Add job to queue
    await queue.add(() => processRequest(message.document.file_id, message, reply));
});

/** ========== Fallback GET ========== */
app.get("*", (req, res) => {
    res.send("Hello World!");
});

/** ========== Listen ========== */
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
